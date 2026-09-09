/**
 * The pipeline: seven stages, six human gates.
 *
 *   discovery -> backlog -> architecture -> estimation -> planning -> development -> qa
 *
 * This file holds the first five, which turn client material into an approved, estimated,
 * sequenced plan. The delivery half — writing the code and testing it — lives in
 * stages-delivery.ts, because those two stages carry the workspace and the tool loop with them and
 * would otherwise dominate this file.
 *
 * Everything a stage is made of (the gate helpers, the re-entrancy contract) is in stage-kit.ts.
 */
import { createHash } from 'node:crypto';
import { db, logEvent } from './db.js';
import {
  blindOptions,
  computeVariance,
  computeWaves,
  needsRegeneration,
  recommend,
  type DagNode,
  type EstimateInput,
  type OptionScores,
} from './domain.js';
import { runAgent } from './run-agent.js';
import type { ChangeRequest } from './agents/index.js';
import {
  gateState,
  openGate,
  setPhase,
  settle,
  type Stage,
  type StageContext,
  type StageResult,
} from './stage-kit.js';
import { development, quality } from './stages-delivery.js';

export type { Stage, StageContext, StageResult } from './stage-kit.js';

// ── Discovery ──────────────────────────────────────────────────────────────

const discovery: Stage = {
  key: 'discovery',
  name: 'Discovery',
  async run(ctx) {
    const documents = await db.document.count({ where: { projectId: ctx.run.projectId } });
    if (documents === 0) {
      return {
        status: 'PARKED',
        code: 'NO_INPUT',
        reason: 'This project has no source documents. Add the client material and start it again.',
      };
    }

    await setPhase(ctx.run.projectId, 'REQUIREMENTS');
    const result = await runAgent({ agentKey: 'product-owner', projectId: ctx.run.projectId, phase: 'discovery' });
    await ctx.spend(result.costUsd);

    return { status: 'COMPLETED' };
  },
};

// ── Backlog ────────────────────────────────────────────────────────────────

const backlog: Stage = {
  key: 'backlog',
  name: 'Backlog',
  async run(ctx) {
    const gate = await gateState(ctx.run.projectId, 'BACKLOG');
    if (gate.kind === 'pending') return { status: 'AWAITING_APPROVAL' };
    if (gate.kind === 'expired') {
      return { status: 'PARKED', code: 'APPROVAL_TIMEOUT', reason: 'The backlog gate expired unanswered.' };
    }

    let changeRequests: ChangeRequest[] = [];

    if (gate.kind === 'decided') {
      const settled = await settle(ctx, gate, {
        rejectedCode: 'BACKLOG_REJECTED',
        maxIterations: ctx.settings.limits.backlogRevisions,
        exhaustedReason: 'The backlog was revised repeatedly without converging.',
      });
      if (settled.kind === 'parked') return { status: 'PARKED', ...settled };

      if (settled.kind === 'approved') {
        await db.story.updateMany({
          where: { projectId: ctx.run.projectId, status: 'REVIEW' },
          data: { status: 'APPROVED' },
        });
        await db.requirement.updateMany({
          where: { projectId: ctx.run.projectId, status: 'REVIEW' },
          data: { status: 'APPROVED' },
        });
        await setPhase(ctx.run.projectId, 'BACKLOG_APPROVED');
        return { status: 'COMPLETED' };
      }

      // Raise the count *before* spending on the revision, so a crash cannot un-bound the loop.
      changeRequests = settled.changeRequests;
      await ctx.checkpoint({ iteration: ctx.run.iteration + 1 });
    }

    const first = ctx.run.iteration === 0;
    await setPhase(ctx.run.projectId, 'BACKLOG_DRAFT');

    const result = await runAgent({
      agentKey: 'business-analyst',
      projectId: ctx.run.projectId,
      phase: first ? 'create' : `revise-${ctx.run.iteration}`,
      mode: first ? 'create' : 'revise',
      changeRequests,
    });
    await ctx.spend(result.costUsd);

    const stories = await db.story.findMany({ where: { projectId: ctx.run.projectId } });
    const blocking = stories.reduce((sum, story) => {
      const flags = (story.qualityFlags ?? []) as { severity?: string }[];
      return sum + flags.filter((flag) => flag.severity === 'HIGH' || flag.severity === 'CRITICAL').length;
    }, 0);

    return openGate(ctx, {
      gate: 'BACKLOG',
      title: `Backlog review — ${stories.length} stories`,
      summary: `${stories.length} stories, ${blocking} blocking quality flag(s). ${result.summary}`,
      context: { stories: stories.length, blockingFlags: blocking, warnings: result.warnings },
    });
  },
};

// ── Architecture ───────────────────────────────────────────────────────────

/**
 * Three genuinely different briefs, kept in code rather than in settings.
 *
 * The point of three options is that they are not variations on one idea. An operator tuning the
 * briefs towards each other would quietly defeat the comparison the critic exists to make, so this
 * is one of the things the Settings page deliberately does not expose.
 */
const BRIEFS = [
  {
    variant: 'A',
    brief:
      'Pragmatic and fast to deliver on the existing estate. Favour simplicity and a single transaction boundary over flexibility.',
  },
  {
    variant: 'B',
    brief:
      'Balanced. Keep one deployable but draw a hard module boundary where the domain is most likely to need independent scale later.',
  },
  {
    variant: 'C',
    brief:
      'Scale-first and independently deployable. Optimise for separate ownership and elastic scale, and be explicit about the consistency cost.',
  },
];

const architecture: Stage = {
  key: 'architecture',
  name: 'Architecture',
  async run(ctx) {
    const gate = await gateState(ctx.run.projectId, 'ARCHITECTURE');
    let changeRequests: ChangeRequest[] = [];
    if (gate.kind === 'pending') return { status: 'AWAITING_APPROVAL' };
    if (gate.kind === 'expired') {
      return { status: 'PARKED', code: 'APPROVAL_TIMEOUT', reason: 'The architecture gate expired unanswered.' };
    }

    if (gate.kind === 'decided') {
      const settled = await settle(ctx, gate, {
        rejectedCode: 'ARCHITECTURE_REJECTED',
        maxIterations: ctx.settings.limits.architectureRounds,
        exhaustedReason: 'Architecture rounds were exhausted without an approved option.',
      });
      if (settled.kind === 'parked') return { status: 'PARKED', ...settled };

      if (settled.kind === 'approved') {
        // The approver may override the critic by naming a different option on the decision.
        const decisionContext = (settled.context ?? {}) as { recommendedOptionId?: string; chosenOptionId?: string };
        const chosenOptionId = decisionContext.chosenOptionId ?? decisionContext.recommendedOptionId;
        if (!chosenOptionId) {
          return {
            status: 'PARKED',
            code: 'NO_RECOMMENDATION',
            reason: 'Approved with no recommended option to write an ADR against.',
          };
        }
        await writeAdr(ctx.run.projectId, chosenOptionId, settled.decidedBy);
        await setPhase(ctx.run.projectId, 'ARCHITECTURE_APPROVED');
        return { status: 'COMPLETED' };
      }

      changeRequests = settled.changeRequests;
      await ctx.checkpoint({ iteration: ctx.run.iteration + 1 });
    }

    const round = ctx.run.iteration + 1;
    await setPhase(ctx.run.projectId, 'ARCHITECTURE');

    // Three briefs at once. They are independent, so there is nothing to serialise.
    const options = await Promise.all(
      BRIEFS.map((option) =>
        runAgent({
          agentKey: 'architect',
          projectId: ctx.run.projectId,
          phase: `round-${round}-${option.variant}`,
          mode: round === 1 ? 'create' : 'revise',
          changeRequests,
          vars: { variant: option.variant, brief: option.brief, round },
        }),
      ),
    );
    for (const option of options) await ctx.spend(option.costUsd);

    const written = await db.architectureOption.findMany({
      where: { projectId: ctx.run.projectId, round },
      orderBy: { variant: 'asc' },
    });
    if (written.length < 2) {
      return { status: 'PARKED', code: 'TOO_FEW_OPTIONS', reason: 'Fewer than two architecture options survived.' };
    }

    // Blind the options before the critic sees them: authorship stripped, labels shuffled on a
    // seed derived from the project and round, so the shuffle is stable across a retry.
    const seed = createHash('sha256').update(`${ctx.run.projectId}:${round}`).digest('hex').slice(0, 16);
    const { blind, mapping } = blindOptions(
      written.map((option) => ({
        optionId: option.id,
        variant: option.variant,
        name: option.name,
        overview: option.overview,
        detail: option.detail,
      })),
      seed,
    );

    const critique = await runAgent({
      agentKey: 'architecture-critic',
      projectId: ctx.run.projectId,
      phase: `round-${round}`,
      vars: { blindOptions: blind, labels: Object.keys(mapping) },
    });
    await ctx.spend(critique.costUsd);

    const evaluations = (critique.output as { evaluations: { label: string; scores: OptionScores['scores'] }[] })
      .evaluations;

    const scored: OptionScores[] = [];
    for (const evaluation of evaluations) {
      const optionId = mapping[evaluation.label];
      const option = written.find((candidate) => candidate.id === optionId);
      if (!option) continue;

      for (const score of evaluation.scores) {
        await db.architectureEvaluation.upsert({
          where: { optionId_criterion: { optionId: option.id, criterion: score.criterion } },
          create: { optionId: option.id, criterion: score.criterion, score: score.score, reasoning: score.reasoning },
          update: { score: score.score, reasoning: score.reasoning },
        });
      }
      scored.push({ optionId: option.id, variant: option.variant, name: option.name, scores: evaluation.scores });
    }

    const recommendation = recommend(scored);

    // Every option below the viability threshold means the round failed. Regenerating beats asking
    // a human to approve the least bad of three weak designs.
    if (needsRegeneration(recommendation) && round < ctx.settings.limits.architectureRounds) {
      await logEvent(ctx.run.projectId, 'ARCHITECTURE_ROUND_REGENERATED', { round });
      await ctx.checkpoint({ iteration: round });
      return { status: 'CONTINUE' };
    }

    return openGate(ctx, {
      gate: 'ARCHITECTURE',
      title: 'Architecture recommendation',
      summary: recommendation.reasoning,
      context: {
        recommendedOptionId: recommendation.recommendedOptionId,
        ranked: recommendation.ranked,
        closeCall: recommendation.closeCall,
        round,
      },
    });
  },
};

async function writeAdr(projectId: string, optionId: string, approvedBy: string): Promise<void> {
  const option = await db.architectureOption.findUniqueOrThrow({ where: { id: optionId } });
  const others = await db.architectureOption.findMany({
    where: { projectId, id: { not: optionId } },
    select: { variant: true, name: true },
  });
  const last = await db.adr.findFirst({ where: { projectId }, orderBy: { number: 'desc' } });
  const detail = option.detail as { disadvantages?: string[] };

  const adr = await db.adr.create({
    data: {
      projectId,
      number: (last?.number ?? 0) + 1,
      title: `Adopt ${option.name}`,
      context: option.overview,
      decision: `Adopt option ${option.variant}: ${option.name}.`,
      rationale: 'Selected by an independent critic scorecard and approved by a human.',
      consequences: detail.disadvantages ?? [],
      alternatives: others.map((other) => `${other.variant}: ${other.name}`),
      optionId: option.id,
      approvedBy,
    },
  });

  await logEvent(projectId, 'ADR_CREATED', { number: adr.number, optionId });
}

// ── Estimation ─────────────────────────────────────────────────────────────

const estimation: Stage = {
  key: 'estimation',
  name: 'Estimation',
  async run(ctx) {
    const gate = await gateState(ctx.run.projectId, 'ESTIMATION');
    let changeRequests: ChangeRequest[] = [];
    if (gate.kind === 'pending') return { status: 'AWAITING_APPROVAL' };
    if (gate.kind === 'expired') {
      return { status: 'PARKED', code: 'APPROVAL_TIMEOUT', reason: 'The estimation gate expired unanswered.' };
    }

    if (gate.kind === 'decided') {
      const settled = await settle(ctx, gate, { rejectedCode: 'ESTIMATION_REJECTED', maxIterations: 3 });
      if (settled.kind === 'parked') return { status: 'PARKED', ...settled };
      if (settled.kind === 'approved') return { status: 'COMPLETED' };
      changeRequests = settled.changeRequests;
      await ctx.checkpoint({ iteration: ctx.run.iteration + 1 });
    }

    await setPhase(ctx.run.projectId, 'ESTIMATION');
    const revising = ctx.run.iteration > 0;

    // Two estimators, run separately so neither sees the other's number.
    const [primary, independent] = await Promise.all([
      runAgent({
        agentKey: 'estimator',
        projectId: ctx.run.projectId,
        phase: 'primary',
        mode: revising ? 'revise' : 'create',
        changeRequests,
        vars: { estimatorKind: 'PRIMARY' },
      }),
      runAgent({
        agentKey: 'estimator',
        projectId: ctx.run.projectId,
        phase: 'independent',
        mode: revising ? 'revise' : 'create',
        changeRequests,
        vars: { estimatorKind: 'INDEPENDENT' },
      }),
    ]);
    await ctx.spend(primary.costUsd + independent.costUsd);

    const variances = await computeVariances(ctx.run.projectId, ctx.settings.limits.estimationVariance);
    const needReview = variances.filter((variance) => variance.reviewRequired);

    return openGate(ctx, {
      gate: 'ESTIMATION',
      title: 'Estimation review',
      summary:
        needReview.length > 0
          ? `${needReview.length} story estimate(s) disagree beyond the ${(ctx.settings.limits.estimationVariance * 100).toFixed(0)}% threshold and need reconciliation.`
          : 'Both estimators agree within the variance threshold on every story.',
      context: { variances, totalHours: totalHours(variances) },
    });
  },
};

async function computeVariances(projectId: string, threshold: number) {
  const estimates = await db.estimate.findMany({
    where: { projectId },
    include: { story: { select: { ref: true } } },
  });

  const byStory = new Map<string, { primary?: EstimateInput; independent?: EstimateInput }>();
  for (const estimate of estimates) {
    const entry = byStory.get(estimate.storyId) ?? {};
    const value: EstimateInput = {
      storyRef: estimate.story.ref,
      hours: estimate.hours,
      confidence: estimate.confidence,
      riskLevel: estimate.riskLevel,
      rangeLowHours: estimate.rangeLowHours,
      rangeHighHours: estimate.rangeHighHours,
    };
    if (estimate.estimatorKind === 'PRIMARY') entry.primary = value;
    if (estimate.estimatorKind === 'INDEPENDENT') entry.independent = value;
    byStory.set(estimate.storyId, entry);
  }

  return [...byStory.values()]
    .filter((pair) => pair.primary && pair.independent)
    .map((pair) => computeVariance(pair.primary!, pair.independent!, threshold));
}

function totalHours(variances: { primaryHours: number }[]): number {
  return Math.round(variances.reduce((sum, variance) => sum + variance.primaryHours, 0));
}

// ── Planning ───────────────────────────────────────────────────────────────

const planning: Stage = {
  key: 'planning',
  name: 'Planning',
  async run(ctx) {
    const gate = await gateState(ctx.run.projectId, 'DEV_READINESS');
    let changeRequests: ChangeRequest[] = [];
    if (gate.kind === 'pending') return { status: 'AWAITING_APPROVAL' };
    if (gate.kind === 'expired') {
      return { status: 'PARKED', code: 'APPROVAL_TIMEOUT', reason: 'The readiness gate expired unanswered.' };
    }

    if (gate.kind === 'decided') {
      const settled = await settle(ctx, gate, { rejectedCode: 'PLAN_REJECTED', maxIterations: 3 });
      if (settled.kind === 'parked') return { status: 'PARKED', ...settled };
      if (settled.kind === 'approved') {
        await db.story.updateMany({
          where: { projectId: ctx.run.projectId, status: 'APPROVED' },
          data: { status: 'PLANNED' },
        });
        await setPhase(ctx.run.projectId, 'READY_FOR_DEVELOPMENT');
        return { status: 'COMPLETED' };
      }
      changeRequests = settled.changeRequests;
      await ctx.checkpoint({ iteration: ctx.run.iteration + 1 });
    }

    await setPhase(ctx.run.projectId, 'PLANNING');
    const mode = ctx.run.iteration > 0 ? ('revise' as const) : ('create' as const);

    const resources = await runAgent({
      agentKey: 'resource-planner',
      projectId: ctx.run.projectId,
      phase: 'plan',
      mode,
      changeRequests,
    });
    await ctx.spend(resources.costUsd);

    const delivery = await runAgent({
      agentKey: 'delivery-planner',
      projectId: ctx.run.projectId,
      phase: 'plan',
      mode,
      changeRequests,
    });
    await ctx.spend(delivery.costUsd);

    // The waves are derived from the stories' own dependency edges and the primary estimates —
    // not from anything a model said the schedule should be.
    const topology = await computeTopology(ctx.run.projectId);
    await db.plan.update({
      where: { projectId: ctx.run.projectId },
      data: {
        waves: topology.waves,
        cycles: topology.cycles,
        criticalPathHours: topology.criticalPath.hours,
      },
    });

    return openGate(ctx, {
      gate: 'DEV_READINESS',
      title: 'Development readiness',
      summary:
        `${topology.waves.length} wave(s), critical path ${topology.criticalPath.hours}h. ` +
        (topology.cycles.length ? 'Cyclic story dependencies were detected — see below. ' : '') +
        delivery.summary,
      context: {
        waves: topology.waves,
        cycles: topology.cycles,
        criticalPath: topology.criticalPath,
        resourcePlan: resources.summary,
      },
    });
  },
};

async function computeTopology(projectId: string) {
  const stories = await db.story.findMany({
    where: { projectId },
    include: { estimates: { where: { estimatorKind: 'PRIMARY' }, select: { hours: true } } },
  });

  const nodes: DagNode[] = stories.map((story) => ({
    ref: story.ref,
    dependsOn: (story.dependsOn ?? []) as string[],
    estimateHours: story.estimates[0]?.hours ?? 0,
    priority: story.priority,
  }));

  return computeWaves(nodes);
}

// ── The pipeline ───────────────────────────────────────────────────────────

export const STAGES: Stage[] = [
  discovery,
  backlog,
  architecture,
  estimation,
  planning,
  development,
  quality,
];

export function stageByKey(key: string): Stage | undefined {
  return STAGES.find((stage) => stage.key === key);
}

export function nextStageKey(key: string): string | undefined {
  const index = STAGES.findIndex((stage) => stage.key === key);
  return index === -1 ? undefined : STAGES[index + 1]?.key;
}
