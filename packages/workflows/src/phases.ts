/**
 * Phase workflows — discovery, backlog, architecture, estimation, planning.
 *
 * Determinism rules (invariant I1): these files import only `@temporalio/workflow`, `@sdlc/shared`
 * and activity *types*. No Prisma, no fetch, no Date.now(), no Math.random(). The ESLint boundary
 * config and the replay tests both enforce it.
 */

import { proxyActivities, workflowInfo, log } from '@temporalio/workflow';
import type { ArtifactRef, ChangeRequest } from '@sdlc/shared';
import type { Activities } from '@sdlc/activities';
import { activityOptions, DEFAULT_QUEUE_PREFIX } from './lib/retry.js';
import { ApprovalInbox } from './lib/approval.js';

/**
 * Proxies are built per workflow from `input.queuePrefix`, not at module load, so an isolated
 * environment (a test, a second deployment sharing one namespace) gets its own task queues.
 */
function proxies(prefix: string = DEFAULT_QUEUE_PREFIX) {
  const options = activityOptions(prefix);
  return {
    agent: proxyActivities<Activities>(options.agent),
    db: proxyActivities<Activities>(options.database),
  };
}

export interface PhaseInput {
  projectId: string;
  projectKey: string;
  /** Task-queue prefix. Defaults to `sdlc`; tests and isolated environments override it. */
  queuePrefix?: string;
  limits: {
    maxBacklogRevisions: number;
    maxArchitectureRounds: number;
    estimationVarianceThreshold: number;
    approvalDefaultTimeoutHours: number;
  };
}

export type PhaseOutcome =
  | { status: 'COMPLETED'; artifactRef?: ArtifactRef; detail?: Record<string, unknown> }
  | { status: 'PARKED'; code: string; reason: string };

// ── Discovery ──────────────────────────────────────────────────────────────

export async function DiscoveryWorkflow(input: PhaseInput): Promise<PhaseOutcome> {
  const { agent, db } = proxies(input.queuePrefix);
  await db.setProjectPhase(input.projectId, 'DISCOVERY');

  const documentIds = await db.listUningestedDocuments(input.projectId);
  if (documentIds.length === 0) {
    return { status: 'PARKED', code: 'NO_INPUT', reason: 'No source documents have been imported.' };
  }

  // Ingestion is independent per document; four at a time keeps the embedding provider honest.
  for (let i = 0; i < documentIds.length; i += 4) {
    await Promise.all(documentIds.slice(i, i + 4).map((id) => db.ingestDocument(id)));
  }

  await db.setProjectPhase(input.projectId, 'REQUIREMENTS');
  const result = await agent.runAgent({
    agentKey: 'product-owner',
    projectId: input.projectId,
    phase: 'discovery',
    input: { mode: 'create', changeRequests: [] },
  });

  await db.emitEvent({
    projectId: input.projectId,
    type: 'REQUIREMENTS_CREATED',
    payload: { agentRunId: result.agentRunId },
  });

  return { status: 'COMPLETED', ...(result.outputRef ? { artifactRef: result.outputRef } : {}) };
}

// ── Backlog, with the bounded revision loop ────────────────────────────────

export async function BacklogWorkflow(input: PhaseInput): Promise<PhaseOutcome> {
  const { agent, db } = proxies(input.queuePrefix);
  const inbox = new ApprovalInbox(input.queuePrefix);
  const { workflowId } = workflowInfo();

  await db.setProjectPhase(input.projectId, 'BACKLOG_DRAFT');

  let changeRequests: ChangeRequest[] = [];
  let iteration = 0;
  let ref: ArtifactRef | undefined;

  for (;;) {
    const result = await agent.runAgent({
      agentKey: 'business-analyst',
      projectId: input.projectId,
      phase: iteration === 0 ? 'create' : 'revise',
      ...(ref ? { inputRefs: [ref] } : {}),
      input: {
        mode: iteration === 0 ? 'create' : 'revise',
        changeRequests: changeRequests as unknown as Record<string, unknown>[],
      },
    });
    ref = result.outputRef;

    await db.setProjectPhase(input.projectId, 'BACKLOG_REVIEW');
    const summary = await db.getBacklogSummary(input.projectId);

    const decision = await inbox.waitForApproval({
      gate: 'BACKLOG',
      projectId: input.projectId,
      workflowId,
      title: `Backlog review — ${summary.total} stories`,
      summary:
        `${summary.total} stories, ${summary.blockingFlags} blocking quality flag(s). ` +
        (result.decisionSummary?.summary ?? ''),
      ...(ref ? { artifactRef: ref } : {}),
      context: { iteration, ...summary },
      timeoutHours: input.limits.approvalDefaultTimeoutHours,
    });

    if (decision.decision === 'APPROVED') {
      await db.approveBacklog(input.projectId, decision.userId ?? 'system');
      if (ref) await db.approveArtifact(ref, decision.userId ?? 'system');
      await db.setProjectPhase(input.projectId, 'BACKLOG_APPROVED');
      return { status: 'COMPLETED', ...(ref ? { artifactRef: ref } : {}) };
    }

    if (decision.decision === 'REJECTED') {
      return { status: 'PARKED', code: 'BACKLOG_REJECTED', reason: decision.comment ?? 'Backlog rejected.' };
    }

    if (decision.decision === 'EXPIRED') {
      return { status: 'PARKED', code: 'APPROVAL_TIMEOUT', reason: 'The backlog gate expired.' };
    }

    // CHANGES_REQUESTED — revise, but only a bounded number of times.
    iteration += 1;
    if (iteration >= input.limits.maxBacklogRevisions) {
      return {
        status: 'PARKED',
        code: 'ITERATION_LIMIT_EXCEEDED',
        reason: `The backlog was revised ${iteration} times without converging.`,
      };
    }

    changeRequests = decision.changeRequests ?? [];
    log.info('revising backlog', { iteration, changeRequests: changeRequests.length });
  }
}

// ── Architecture ───────────────────────────────────────────────────────────

const BRIEFS = [
  { variant: 'A' as const, brief: 'Pragmatic and fast to deliver on the existing estate. Favour simplicity and a single transaction boundary over flexibility.' },
  { variant: 'B' as const, brief: 'Balanced. Keep one deployable but draw a hard module boundary where the domain is most likely to need independent scale later.' },
  { variant: 'C' as const, brief: 'Scale-first and independently deployable. Optimise for separate ownership and elastic scale, and be explicit about the consistency cost.' },
];

export async function ArchitectureWorkflow(input: PhaseInput): Promise<PhaseOutcome> {
  const { agent, db } = proxies(input.queuePrefix);
  const inbox = new ApprovalInbox(input.queuePrefix);
  const { workflowId } = workflowInfo();

  await db.setProjectPhase(input.projectId, 'ARCHITECTURE');

  for (let round = 1; round <= input.limits.maxArchitectureRounds; round += 1) {
    // Three genuinely different briefs, in parallel. The router is configured to keep these off a
    // single subscription seat so they do not silently serialise.
    await Promise.all(
      BRIEFS.map((option) =>
        agent.runAgent({
          agentKey: 'architect',
          projectId: input.projectId,
          phase: `round-${round}`,
          input: { mode: 'create', changeRequests: [], variant: option.variant, brief: option.brief, round },
        }),
      ),
    );

    const seed = await db.blindingSeed(input.projectId, round);
    const blinded = await db.prepareBlindOptions(input.projectId, round, seed);

    const critique = await agent.runAgent({
      agentKey: 'architecture-critic',
      projectId: input.projectId,
      phase: `round-${round}`,
      input: {
        mode: 'create',
        changeRequests: [],
        labels: blinded.labels,
        blindOptions: blinded.blind as Record<string, unknown>[],
      },
    });

    const recommendation = await db.computeRecommendation({
      projectId: input.projectId,
      agentRunId: critique.agentRunId,
      mapping: blinded.mapping,
      evaluations: critique.outputRef ? await db.readEvaluations(critique.outputRef) : [],
    });

    // Every option below the viability threshold means the round failed. Regenerating beats
    // asking a human to approve the least bad of three weak designs.
    if (recommendation.needsRegeneration && round < input.limits.maxArchitectureRounds) {
      log.warn('all architecture options scored below threshold; regenerating', { round });
      continue;
    }

    const decision = await inbox.waitForApproval({
      gate: 'ARCHITECTURE',
      projectId: input.projectId,
      workflowId,
      title: 'Architecture recommendation',
      summary: critique.decisionSummary?.summary ?? 'Three options evaluated by an independent critic.',
      context: {
        recommendedOptionId: recommendation.recommendedOptionId,
        ranked: recommendation.ranked,
        closeCall: recommendation.closeCall,
        round,
      },
      timeoutHours: input.limits.approvalDefaultTimeoutHours,
    });

    if (decision.decision === 'APPROVED') {
      const chosenOptionId =
        (decision.changeRequests?.[0]?.target.ref as string | undefined) ??
        recommendation.recommendedOptionId;

      const adr = await db.createAdr({
        projectId: input.projectId,
        optionId: chosenOptionId,
        approvedByUserId: decision.userId ?? 'system',
      });
      await db.setProjectPhase(input.projectId, 'ARCHITECTURE_APPROVED');
      return { status: 'COMPLETED', detail: { adrNumber: adr.number, optionId: chosenOptionId } };
    }

    if (decision.decision === 'CHANGES_REQUESTED' && round < input.limits.maxArchitectureRounds) {
      continue;
    }

    return {
      status: 'PARKED',
      code: decision.decision === 'EXPIRED' ? 'APPROVAL_TIMEOUT' : 'ARCHITECTURE_REJECTED',
      reason: decision.comment ?? 'Architecture not approved.',
    };
  }

  return {
    status: 'PARKED',
    code: 'ITERATION_LIMIT_EXCEEDED',
    reason: 'Architecture rounds exhausted without an approved option.',
  };
}

// ── Estimation ─────────────────────────────────────────────────────────────

export async function EstimationWorkflow(input: PhaseInput): Promise<PhaseOutcome> {
  const { agent, db } = proxies(input.queuePrefix);
  const inbox = new ApprovalInbox(input.queuePrefix);
  const { workflowId } = workflowInfo();

  await db.setProjectPhase(input.projectId, 'ESTIMATION');

  // Two estimators in parallel. The router keeps them off the same model where the chain allows,
  // so the two numbers are not correlated by construction.
  await Promise.all([
    agent.runAgent({
      agentKey: 'estimator',
      projectId: input.projectId,
      phase: 'primary',
      input: { mode: 'create', changeRequests: [], estimatorKind: 'PRIMARY' },
    }),
    agent.runAgent({
      agentKey: 'estimator',
      projectId: input.projectId,
      phase: 'independent',
      input: { mode: 'create', changeRequests: [], estimatorKind: 'INDEPENDENT' },
    }),
  ]);

  const variance = await db.computeEstimationVariance(input.projectId);

  const decision = await inbox.waitForApproval({
    gate: 'ESTIMATION',
    projectId: input.projectId,
    workflowId,
    title: 'Estimation review',
    summary:
      variance.reviewRequired.length > 0
        ? `${variance.reviewRequired.length} story estimate(s) disagree beyond the threshold and need reconciliation.`
        : 'Both estimators agree within the variance threshold.',
    context: { variance },
    timeoutHours: input.limits.approvalDefaultTimeoutHours,
  });

  if (decision.decision !== 'APPROVED') {
    return {
      status: 'PARKED',
      code: decision.decision === 'EXPIRED' ? 'APPROVAL_TIMEOUT' : 'ESTIMATION_REJECTED',
      reason: decision.comment ?? 'Estimates not approved.',
    };
  }

  return { status: 'COMPLETED', detail: { variance: variance.reviewRequired.length } };
}

// ── Resource + delivery planning, gated on development readiness ───────────

export async function PlanningWorkflow(input: PhaseInput): Promise<PhaseOutcome> {
  const { agent, db } = proxies(input.queuePrefix);
  const inbox = new ApprovalInbox(input.queuePrefix);
  const { workflowId } = workflowInfo();

  await db.setProjectPhase(input.projectId, 'PLANNING');

  const resources = await agent.runAgent({
    agentKey: 'resource-planner',
    projectId: input.projectId,
    phase: 'plan',
    input: { mode: 'create', changeRequests: [] },
  });

  const delivery = await agent.runAgent({
    agentKey: 'delivery-planner',
    projectId: input.projectId,
    phase: 'plan',
    input: { mode: 'create', changeRequests: [] },
  });

  const waves = await db.computeDeliveryWaves(input.projectId);

  const decision = await inbox.waitForApproval({
    gate: 'DEV_READINESS',
    projectId: input.projectId,
    workflowId,
    title: 'Development readiness',
    summary:
      `${waves.waves.length} wave(s), critical path ${waves.criticalPath.hours}h. ` +
      (delivery.decisionSummary?.summary ?? ''),
    ...(delivery.outputRef ? { artifactRef: delivery.outputRef } : {}),
    context: {
      waves: waves.waves,
      cycles: waves.cycles,
      criticalPath: waves.criticalPath,
      resourcePlan: resources.decisionSummary?.summary,
    },
    timeoutHours: input.limits.approvalDefaultTimeoutHours,
  });

  if (decision.decision !== 'APPROVED') {
    return {
      status: 'PARKED',
      code: decision.decision === 'EXPIRED' ? 'APPROVAL_TIMEOUT' : 'PLAN_REJECTED',
      reason: decision.comment ?? 'Delivery plan not approved.',
    };
  }

  await db.setProjectPhase(input.projectId, 'READY_FOR_DEVELOPMENT');
  await db.emitEvent({
    projectId: input.projectId,
    type: 'READY_FOR_DEVELOPMENT',
    payload: { waves: waves.waves.length },
  });

  return { status: 'COMPLETED', detail: { waves: waves.waves.length } };
}
