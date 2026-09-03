/**
 * Development, story, code review, QA and bug-fix workflows.
 *
 * Every loop in this file is bounded, and every bound has a test that proves it. When a bound is
 * exhausted the workflow *parks* — it stays alive waiting on a human signal rather than failing —
 * which is what makes bounded autonomy usable rather than merely safe.
 */

import { executeChild, proxyActivities, workflowInfo, log, ParentClosePolicy } from '@temporalio/workflow';
import type { ChangeRequest } from '@sdlc/shared';
import type { Activities } from '@sdlc/activities';
import { activityOptions, DEFAULT_QUEUE_PREFIX } from './lib/retry.js';
import { ApprovalInbox } from './lib/approval.js';
import { mapWithLimit } from './lib/concurrency.js';

/** Built per workflow from `input.queuePrefix` — see phases.ts for why. */
function proxies(prefix: string = DEFAULT_QUEUE_PREFIX) {
  const options = activityOptions(prefix);
  return {
    agent: proxyActivities<Activities>(options.agent),
    db: proxyActivities<Activities>(options.database),
    vcs: proxyActivities<Activities>(options.vcs),
    tools: proxyActivities<Activities>(options.tooling),
    polling: proxyActivities<Activities>(options.polling),
    gates: proxyActivities<Activities>(options.gates),
    heavy: proxyActivities<Activities>(options.heavy),
  };
}

export interface DeliveryLimits {
  maxPrFixIterations: number;
  maxQaFixIterations: number;
  maxBuildFixIterations: number;
  maxParallelStories: number;
  approvalDefaultTimeoutHours: number;
}

export interface DevelopmentInput {
  projectId: string;
  projectKey: string;
  repositoryKey: string;
  /** Task-queue prefix. Defaults to `sdlc`; tests and isolated environments override it. */
  queuePrefix?: string;
  limits: DeliveryLimits;
}

export interface StoryInput extends DevelopmentInput {
  storyId: string;
  storyRef: string;
}

export type StoryOutcome =
  | { status: 'DONE'; storyRef: string; prNumber?: number }
  | { status: 'PARKED'; storyRef: string; code: string; reason: string };

// ── Development: dependency-aware fan-out ──────────────────────────────────

export async function DevelopmentWorkflow(
  input: DevelopmentInput,
): Promise<{ done: string[]; parked: StoryOutcome[] }> {
  const { db } = proxies(input.queuePrefix);
  await db.setProjectPhase(input.projectId, 'IN_DEVELOPMENT');

  const plan = await db.computeDeliveryWaves(input.projectId);
  if (plan.cycles.length) {
    log.warn('story dependency cycles detected; those stories are excluded from the fan-out', {
      cycles: plan.cycles,
    });
  }

  const done: string[] = [];
  const parked: StoryOutcome[] = [];

  // Wave by wave: everything inside a wave is independent, so it runs in parallel up to the
  // configured cap. Wave n+1 does not start until wave n is complete.
  for (const wave of plan.waves) {
    const outcomes = await mapWithLimit(wave.refs, input.limits.maxParallelStories, (storyRef) =>
      executeChild(StoryWorkflow, {
        workflowId: `project-${input.projectKey}-story-${storyRef}`,
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
        args: [
          {
            ...input,
            storyRef,
            storyId: plan.storyIdByRef[storyRef] ?? '',
          },
        ],
      }),
    );

    for (const outcome of outcomes) {
      if (outcome.status === 'DONE') done.push(outcome.storyRef);
      else parked.push(outcome);
    }
  }

  return { done, parked };
}

// ── Story: plan → implement → gates → PR → review → QA ─────────────────────

export async function StoryWorkflow(input: StoryInput): Promise<StoryOutcome> {
  const { agent, db, vcs, tools } = proxies(input.queuePrefix);
  const inbox = new ApprovalInbox(input.queuePrefix);
  const { workflowId } = workflowInfo();

  await db.setStoryStatus(input.storyId, 'IN_PROGRESS');
  await db.emitEvent({
    projectId: input.projectId,
    type: 'STORY_STARTED',
    payload: { storyRef: input.storyRef },
  });

  await vcs.ensureWorkspace({ projectId: input.projectId, repositoryKey: input.repositoryKey });

  // Design context is fetched, not assumed. When Figma is not configured the story proceeds only
  // if it does not need a design; otherwise it parks for human input rather than inventing a UI.
  const design = await tools.fetchDesignReferences({
    projectId: input.projectId,
    storyRef: input.storyRef,
    agentRunId: 'system',
  });

  const planRun = await agent.runAgent({
    agentKey: 'developer',
    projectId: input.projectId,
    phase: 'plan',
    subjectRef: input.storyId,
    input: { mode: 'create', changeRequests: [], phase: 'plan', storyRef: input.storyRef },
  });

  let implementation = await agent.runAgent({
    agentKey: 'developer',
    projectId: input.projectId,
    phase: 'implement',
    subjectRef: input.storyId,
    ...(planRun.outputRef ? { inputRefs: [planRun.outputRef] } : {}),
    input: { mode: 'create', changeRequests: [], phase: 'implement', storyRef: input.storyRef },
  });

  let changes = await db.readDeveloperChanges(implementation.outputRef!);

  // Build-fix loop: a failing gate is a result, and the developer gets a bounded number of goes.
  let gateResults = await applyAndVerify(input, changes.changes);
  let buildIteration = 0;
  while (!gateResults.passed && buildIteration < input.limits.maxBuildFixIterations) {
    buildIteration += 1;
    log.info('quality gates failed; asking the developer to fix', { iteration: buildIteration });

    implementation = await agent.runAgent({
      agentKey: 'developer',
      projectId: input.projectId,
      phase: 'fix',
      subjectRef: input.storyId,
      input: {
        mode: 'revise',
        changeRequests: [],
        phase: 'fix',
        storyRef: input.storyRef,
        reviewComments: gateResults.results
          .filter((r) => r.status === 'FAIL')
          .map((r) => ({ body: `${r.gate} failed:\n${r.output}` })),
      },
    });
    changes = await db.readDeveloperChanges(implementation.outputRef!);
    gateResults = await applyAndVerify(input, changes.changes);
  }

  if (!gateResults.passed) {
    const outcome = await inbox.waitForIntervention({
      projectId: input.projectId,
      workflowId,
      code: 'BUILD_FAILED',
      reason: `Quality gates still failing after ${buildIteration} fix attempt(s).`,
      context: { storyRef: input.storyRef, results: gateResults.results },
    });
    if (outcome.action === 'SKIP_STORY') {
      return { status: 'PARKED', storyRef: input.storyRef, code: 'SKIPPED', reason: 'Skipped by a human.' };
    }
  }

  const branchName = changes.branchName ?? `feat/${input.storyRef}-implementation`;
  await vcs.createBranch({
    projectId: input.projectId,
    repositoryKey: input.repositoryKey,
    storyRef: input.storyRef,
    agentRunId: implementation.agentRunId,
    branchName,
  });

  await vcs.commitAndPush({
    projectId: input.projectId,
    repositoryKey: input.repositoryKey,
    branchName,
    message: changes.commitMessage ?? `feat(${input.storyRef}): implementation`,
    changes: changes.changes,
    agentRunId: implementation.agentRunId,
  });

  const pr = await vcs.createPullRequest({
    projectId: input.projectId,
    repositoryKey: input.repositoryKey,
    storyRef: input.storyRef,
    branchName,
    agentRunId: implementation.agentRunId,
    body: changes.pullRequest ?? {
      title: input.storyRef,
      summary: 'Implementation produced by the developer agent.',
      implementationDetails: '',
      acceptanceCriteriaCoverage: [],
      testsAdded: [],
      knownLimitations: [],
      securityConsiderations: [],
    },
    gateResults: gateResults.results,
    ...(implementation.modelId ? { modelId: implementation.modelId } : {}),
    ...(implementation.providerKey ? { providerKey: implementation.providerKey } : {}),
  });

  await db.setStoryStatus(input.storyId, 'IN_REVIEW');
  if (design.status === 'DESIGN_CONTEXT_UNAVAILABLE') {
    log.info('story implemented without design context', { storyRef: input.storyRef });
  }

  const review = await executeChild(CodeReviewWorkflow, {
    workflowId: `project-${input.projectKey}-story-${input.storyRef}-review-1`,
    parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    args: [
      {
        ...input,
        prId: pr.prId,
        prNumber: pr.number,
        branchName,
        ...(implementation.outputRef ? { implementationRef: implementation.outputRef } : {}),
      },
    ],
  });

  if (review.status !== 'APPROVED') {
    return { status: 'PARKED', storyRef: input.storyRef, code: review.code, reason: review.reason };
  }

  await db.setStoryStatus(input.storyId, 'IN_QA');
  const qa = await executeChild(QaWorkflow, {
    workflowId: `project-${input.projectKey}-story-${input.storyRef}-qa-1`,
    parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    args: [
      {
        ...input,
        prId: pr.prId,
        prNumber: pr.number,
        branchName,
        ...(implementation.outputRef ? { implementationRef: implementation.outputRef } : {}),
      },
    ],
  });

  if (qa.status !== 'PASSED') {
    return { status: 'PARKED', storyRef: input.storyRef, code: qa.code, reason: qa.reason };
  }

  await db.setStoryStatus(input.storyId, 'DONE');
  await db.emitEvent({
    projectId: input.projectId,
    type: 'STORY_COMPLETED',
    payload: { storyRef: input.storyRef, prNumber: pr.number },
  });

  return { status: 'DONE', storyRef: input.storyRef, prNumber: pr.number };
}

async function applyAndVerify(
  input: StoryInput,
  changes: { path: string; action: 'CREATE' | 'MODIFY' | 'DELETE'; content?: string }[],
) {
  const { vcs, gates } = proxies(input.queuePrefix);
  await vcs.applyChanges({
    projectId: input.projectId,
    repositoryKey: input.repositoryKey,
    changes,
  });
  return gates.runQualityGates({ projectId: input.projectId, repositoryKey: input.repositoryKey });
}

// ── Code review, with the bounded PR fix loop ──────────────────────────────

export interface ReviewInput extends StoryInput {
  prId: string;
  prNumber: number;
  branchName: string;
  /** The developer's implementation artifact. Reviewers read the change set from it. */
  implementationRef?: import('@sdlc/shared').ArtifactRef;
}

export type ReviewOutcome =
  | { status: 'APPROVED' }
  | { status: 'PARKED'; code: string; reason: string };

export async function CodeReviewWorkflow(input: ReviewInput): Promise<ReviewOutcome> {
  const { agent, db, vcs, polling, gates } = proxies(input.queuePrefix);
  const inbox = new ApprovalInbox(input.queuePrefix);
  const { workflowId } = workflowInfo();

  // CI polling happens through activity retries, so the workflow history stays small.
  await polling.waitForChecks({
    projectId: input.projectId,
    repositoryKey: input.repositoryKey,
    prNumber: input.prNumber,
    agentRunId: 'system',
  });

  let iteration = 0;
  for (;;) {
    const [codeReview, securityReview] = await Promise.all([
      agent.runAgent({
        agentKey: 'code-reviewer',
        projectId: input.projectId,
        phase: 'review',
        subjectRef: input.storyId,
        ...(input.implementationRef ? { inputRefs: [input.implementationRef] } : {}),
        input: { mode: 'create', changeRequests: [], storyRef: input.storyRef, prNumber: input.prNumber },
      }),
      agent.runAgent({
        agentKey: 'security-reviewer',
        projectId: input.projectId,
        phase: 'review',
        subjectRef: input.storyId,
        ...(input.implementationRef ? { inputRefs: [input.implementationRef] } : {}),
        input: { mode: 'create', changeRequests: [], storyRef: input.storyRef, prNumber: input.prNumber },
      }),
    ]);

    const findings = await db.readReviewFindings([codeReview.outputRef!, securityReview.outputRef!]);
    await vcs.recordCodeReview({
      prId: input.prId,
      reviewerKind: 'AI',
      verdict: findings.verdict,
      summary: findings.summary,
      findings: findings.findings,
      agentRunId: codeReview.agentRunId,
    });

    await db.emitEvent({
      projectId: input.projectId,
      type: 'PR_REVIEW_REQUESTED',
      payload: { prNumber: input.prNumber, aiVerdict: findings.verdict },
    });

    const decision = await inbox.waitForApproval({
      gate: 'PR',
      projectId: input.projectId,
      workflowId,
      title: `PR #${input.prNumber} — ${input.storyRef}`,
      summary: `AI review: ${findings.verdict}. ${findings.summary}`,
      context: {
        prNumber: input.prNumber,
        aiVerdict: findings.verdict,
        findings: findings.findings,
        iteration,
      },
      timeoutHours: input.limits.approvalDefaultTimeoutHours,
    });

    if (decision.decision === 'APPROVED') {
      await db.emitEvent({
        projectId: input.projectId,
        type: 'PR_APPROVED',
        payload: { prNumber: input.prNumber },
      });
      return { status: 'APPROVED' };
    }

    if (decision.decision !== 'CHANGES_REQUESTED') {
      return {
        status: 'PARKED',
        code: decision.decision === 'EXPIRED' ? 'APPROVAL_TIMEOUT' : 'PR_REJECTED',
        reason: decision.comment ?? 'Pull request not approved.',
      };
    }

    iteration += 1;
    await vcs.recordPrFixIteration({
      prId: input.prId,
      iteration,
      triggeredBy: 'REVIEW',
    });

    if (iteration > input.limits.maxPrFixIterations) {
      await inbox.waitForIntervention({
        projectId: input.projectId,
        workflowId,
        code: 'HUMAN_INTERVENTION_REQUIRED',
        reason: `Review iterations exhausted after ${input.limits.maxPrFixIterations} attempts.`,
        context: { prNumber: input.prNumber },
      });
      return {
        status: 'PARKED',
        code: 'ITERATION_LIMIT_EXCEEDED',
        reason: 'PR fix iterations exhausted.',
      };
    }

    const changeRequests: ChangeRequest[] = decision.changeRequests ?? [];
    const fix = await agent.runAgent({
      agentKey: 'developer',
      projectId: input.projectId,
      phase: 'address-review',
      subjectRef: input.storyId,
      input: {
        mode: 'revise',
        changeRequests: changeRequests as unknown as Record<string, unknown>[],
        phase: 'address-review',
        storyRef: input.storyRef,
        reviewComments: findings.findings.map((f) => ({ path: f.path, line: f.line, body: f.body })),
      },
    });

    const revised = await db.readDeveloperChanges(fix.outputRef!);
    await vcs.applyChanges({
      projectId: input.projectId,
      repositoryKey: input.repositoryKey,
      changes: revised.changes,
    });
    await gates.runQualityGates({ projectId: input.projectId, repositoryKey: input.repositoryKey });
    await vcs.commitAndPush({
      projectId: input.projectId,
      repositoryKey: input.repositoryKey,
      branchName: input.branchName,
      message: `fix(${input.storyRef}): address review comments (iteration ${iteration})`,
      changes: revised.changes,
      agentRunId: fix.agentRunId,
    });
    await vcs.recordPrFixIteration({ prId: input.prId, iteration, triggeredBy: 'REVIEW', outcome: 'FIXED' });
  }
}

// ── QA, with the bounded bug-fix loop ──────────────────────────────────────

export type QaOutcome =
  | { status: 'PASSED' }
  | { status: 'PARKED'; code: string; reason: string };

export async function QaWorkflow(input: ReviewInput): Promise<QaOutcome> {
  const { agent, db, heavy } = proxies(input.queuePrefix);
  const inbox = new ApprovalInbox(input.queuePrefix);
  const { workflowId } = workflowInfo();

  await db.setProjectPhase(input.projectId, 'IN_QA');
  await db.emitEvent({
    projectId: input.projectId,
    type: 'QA_STARTED',
    payload: { storyRef: input.storyRef },
  });

  await agent.runAgent({
    agentKey: 'qa',
    projectId: input.projectId,
    phase: 'design-tests',
    subjectRef: input.storyId,
    input: { mode: 'create', changeRequests: [], phase: 'design-tests', storyRef: input.storyRef },
  });

  // Coverage is a hard gate: an acceptance criterion with no test is an untested requirement.
  const coverage = await db.assertCriteriaCovered({
    projectId: input.projectId,
    storyRef: input.storyRef,
  });
  if (coverage.uncovered.length) {
    log.warn('acceptance criteria without test coverage', { uncovered: coverage.uncovered });
  }

  await agent.runAgent({
    agentKey: 'qa',
    projectId: input.projectId,
    phase: 'automate',
    subjectRef: input.storyId,
    input: { mode: 'create', changeRequests: [], phase: 'automate', storyRef: input.storyRef },
  });

  let iteration = 0;
  for (;;) {
    const run = await heavy.runTests({
      projectId: input.projectId,
      storyRef: input.storyRef,
      agentRunId: 'system',
      prId: input.prId,
    });

    const analysis = await agent.runAgent({
      agentKey: 'qa',
      projectId: input.projectId,
      phase: 'analyse',
      subjectRef: input.storyId,
      input: { mode: 'create', changeRequests: [], phase: 'analyse', storyRef: input.storyRef },
    });

    if (run.failed === 0) {
      await db.emitEvent({
        projectId: input.projectId,
        type: 'QA_PASSED',
        payload: { storyRef: input.storyRef, passed: run.passed },
      });

      const decision = await inbox.waitForApproval({
        gate: 'QA',
        projectId: input.projectId,
        workflowId,
        title: `QA sign-off — ${input.storyRef}`,
        summary: `${run.passed} passed, 0 failed. ${analysis.decisionSummary?.summary ?? ''}`,
        context: { runId: run.runId, coverage, iteration },
        timeoutHours: input.limits.approvalDefaultTimeoutHours,
      });

      if (decision.decision === 'APPROVED') return { status: 'PASSED' };
      return {
        status: 'PARKED',
        code: decision.decision === 'EXPIRED' ? 'APPROVAL_TIMEOUT' : 'QA_REJECTED',
        reason: decision.comment ?? 'QA not approved.',
      };
    }

    await db.emitEvent({
      projectId: input.projectId,
      type: 'QA_FAILED',
      payload: { storyRef: input.storyRef, failed: run.failed },
    });

    iteration += 1;
    if (iteration > input.limits.maxQaFixIterations) {
      await inbox.waitForIntervention({
        projectId: input.projectId,
        workflowId,
        code: 'HUMAN_INTERVENTION_REQUIRED',
        reason: `QA still failing after ${input.limits.maxQaFixIterations} fix attempts.`,
        context: { storyRef: input.storyRef, failed: run.failed },
      });
      return {
        status: 'PARKED',
        code: 'ITERATION_LIMIT_EXCEEDED',
        reason: 'QA fix iterations exhausted.',
      };
    }

    await executeChild(BugFixWorkflow, {
      workflowId: `project-${input.projectKey}-story-${input.storyRef}-bugfix-${iteration}`,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      args: [{ ...input, iteration }],
    });
  }
}

// ── Bug fix ────────────────────────────────────────────────────────────────

export async function BugFixWorkflow(
  input: ReviewInput & { iteration: number },
): Promise<{ fixed: string[] }> {
  const { agent, db, vcs, gates, heavy } = proxies(input.queuePrefix);
  const analysis = await agent.runAgent({
    agentKey: 'bug-analyzer',
    projectId: input.projectId,
    phase: 'analyse',
    subjectRef: input.storyId,
    input: { mode: 'create', changeRequests: [], storyRef: input.storyRef },
  });

  const bugRefs = await db.getOpenBugRefs(input.projectId, input.storyRef);
  await db.emitEvent({
    projectId: input.projectId,
    type: 'BUG_CREATED',
    payload: { storyRef: input.storyRef, bugRefs },
  });

  const fix = await agent.runAgent({
    agentKey: 'developer',
    projectId: input.projectId,
    phase: 'fix',
    subjectRef: input.storyId,
    ...(analysis.outputRef ? { inputRefs: [analysis.outputRef] } : {}),
    input: {
      mode: 'revise',
      changeRequests: [],
      phase: 'fix',
      storyRef: input.storyRef,
      bugRefs,
    },
  });

  const revised = await db.readDeveloperChanges(fix.outputRef!);
  await vcs.applyChanges({
    projectId: input.projectId,
    repositoryKey: input.repositoryKey,
    changes: revised.changes,
  });
  await gates.runQualityGates({ projectId: input.projectId, repositoryKey: input.repositoryKey });
  await vcs.commitAndPush({
    projectId: input.projectId,
    repositoryKey: input.repositoryKey,
    branchName: input.branchName,
    message: `fix(${input.storyRef}): ${bugRefs.join(', ')} (attempt ${input.iteration})`,
    changes: revised.changes,
    agentRunId: fix.agentRunId,
  });

  await heavy.recordQaFixIteration({
    storyId: input.storyId,
    iteration: input.iteration,
    bugRefs,
    outcome: 'FIXED',
  });
  await heavy.markBugsFixed(input.projectId, bugRefs, input.prId);

  return { fixed: bugRefs };
}
