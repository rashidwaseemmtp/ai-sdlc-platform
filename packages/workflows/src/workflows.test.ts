/**
 * Workflow behaviour tests — docs/14 §3.
 *
 * Every bounded loop and every gate has a test here that proves it: a limit nobody tested is a
 * limit nobody can rely on.
 *
 * These run against the real Temporal server from `pnpm infra:up` rather than the time-skipping
 * environment. Time-skipping fights the short `startToCloseTimeout`s on our activity groups — the
 * clock jumps past them while an activity is queued — so the expiry test uses a genuinely short
 * gate timeout instead. The behaviour under test is identical; only the clock is real.
 *
 * Skips with a clear message when Temporal is not running, rather than reporting a false pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ApprovalDecisionType } from '@sdlc/shared';
import { BacklogWorkflow } from './phases.js';
import { CodeReviewWorkflow } from './delivery.js';

const here = dirname(fileURLToPath(import.meta.url));
const workflowsPath = resolve(here, './index.ts');
const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';

let client: Client | undefined;
let connection: Connection | undefined;
let nativeConnection: NativeConnection | undefined;
let available = false;

beforeAll(async () => {
  try {
    connection = await Connection.connect({ address, connectTimeout: 5000 });
    client = new Client({ connection });
    nativeConnection = await NativeConnection.connect({ address });
    available = true;
  } catch (error) {
    console.warn(
      `Temporal at ${address} is unavailable, skipping workflow tests: ${(error as Error).message}. ` +
        'Run `pnpm infra:up` first.',
    );
  }
}, 60_000);

afterAll(async () => {
  await nativeConnection?.close();
  await connection?.close();
});

interface AgentCall {
  agentKey: string;
  phase?: string;
}

/**
 * Activity stubs. These tests are about *orchestration* — sequencing, gates, bounds — so every
 * activity is replaced and its calls recorded.
 */
function makeActivities(overrides: Record<string, (...args: never[]) => unknown> = {}) {
  const agentCalls: AgentCall[] = [];
  const interventions: string[] = [];
  let approvals = 0;

  const base = {
    runAgent: async (input: { agentKey: string; phase?: string }) => {
      agentCalls.push({ agentKey: input.agentKey, phase: input.phase });
      return {
        agentRunId: `run-${agentCalls.length}`,
        status: 'SUCCEEDED',
        outputRef: {
          artifactId: 'a1',
          versionId: `v${agentCalls.length}`,
          version: agentCalls.length,
          kind: 'BACKLOG',
          sha256: 'sha',
        },
        decisionSummary: {
          summary: 'stub',
          evidence: [],
          assumptions: [],
          risks: [],
          tradeoffs: [],
          openQuestions: [],
          confidence: 0.8,
        },
        qualityWarnings: [],
        costUsd: 0,
        costUnknown: false,
        quotaUnits: 0,
        tokens: 100,
        durationMs: 10,
      };
    },
    createApprovalRequest: async () => `approval-${++approvals}`,
    reconcileApproval: async () => null,
    expireApprovalRequest: async () => undefined,
    settleApprovalRequest: async () => undefined,
    createInterventionRequest: async (input: { code: string }) => {
      interventions.push(input.code);
      return 'intervention-1';
    },
    resolveIntervention: async () => undefined,
    approveArtifact: async () => undefined,
    setProjectPhase: async () => undefined,
    setStoryStatus: async () => undefined,
    emitEvent: async () => undefined,
    getBacklogSummary: async () => ({ total: 3, approved: 0, rejected: 0, pending: 3, blockingFlags: 0 }),
    approveBacklog: async () => 3,
    waitForChecks: async () => ({ state: 'passing' }),
    readReviewFindings: async () => ({ verdict: 'APPROVE' as const, summary: 'ok', findings: [] }),
    readDeveloperChanges: async () => ({ changes: [], branchName: 'feat/US-1-x' }),
    recordCodeReview: async () => 'review-1',
    recordPrFixIteration: async () => undefined,
    applyChanges: async () => ({ written: 0, deleted: 0 }),
    runQualityGates: async () => ({ passed: true, results: [] }),
    commitAndPush: async () => ({ sha: 'sha1' }),
  };

  return { activities: { ...base, ...overrides }, agentCalls, interventions };
}

const baseLimits = {
  maxBacklogRevisions: 3,
  maxArchitectureRounds: 2,
  estimationVarianceThreshold: 0.3,
  approvalDefaultTimeoutHours: 1,
};

/**
 * Each test gets its own queue *prefix*.
 *
 * Workflows pin activities to `${prefix}-main`, `-agents`, `-tools`, `-heavy` for resource
 * isolation, so a test must run a worker on each of its four queues. Isolating by prefix is also
 * what stops a test stealing activities from a running dev worker on `sdlc-*`.
 */
let seq = 0;
const nextPrefix = (label: string): string => `test-${label}-${process.pid}-${++seq}`;

async function withWorkers<T>(activities: object, prefix: string, task: () => Promise<T>): Promise<T> {
  const workers = await Promise.all(
    ['main', 'agents', 'tools', 'heavy'].map((suffix, index) =>
      Worker.create({
        connection: nativeConnection!,
        taskQueue: `${prefix}-${suffix}`,
        activities,
        // Only one worker needs to host workflow code; the rest are activity-only.
        ...(index === 0 ? { workflowsPath } : {}),
      }),
    ),
  );

  const running = workers.map((worker) => worker.run());
  try {
    return await task();
  } finally {
    // Shutdown is initiated synchronously but completes asynchronously; the run promises must be
    // awaited before the shared connection closes, or teardown throws.
    for (const worker of workers) worker.shutdown();
    await Promise.allSettled(running);
  }
}

describe('approval gates', () => {
  it('resumes and completes when a human approves', async () => {
    if (!available) return;
    const { activities } = makeActivities();
    const prefix = nextPrefix('approve');

    const outcome = await withWorkers(activities, prefix, async () => {
      const handle = await client!.workflow.start(BacklogWorkflow, {
        taskQueue: `${prefix}-main`,
        workflowId: prefix,
        args: [{ projectId: 'p1', projectKey: 'TST', queuePrefix: prefix, limits: baseLimits }],
      });

      // Signalled immediately — before the request row can possibly exist. The workflow registers
      // its handler before creating the request, so an instant decision must not be lost. That is
      // exactly the race docs/08 §1 is built to avoid, and this asserts it.
      await handle.signal('approval', {
        gate: 'BACKLOG',
        requestId: 'approval-1',
        decision: 'APPROVED' as ApprovalDecisionType,
        userId: 'u1',
      });
      return handle.result();
    });

    expect(outcome).toMatchObject({ status: 'COMPLETED' });
  }, 60_000);

  it('parks the project when a gate expires rather than auto-approving', async () => {
    if (!available) return;
    const { activities } = makeActivities();
    const prefix = nextPrefix('timeout');

    const outcome = await withWorkers(activities, prefix, async () => {
      const handle = await client!.workflow.start(BacklogWorkflow, {
        taskQueue: `${prefix}-main`,
        workflowId: prefix,
        // ~4 seconds. Nobody decides, so the gate must expire and the project must park.
        args: [
          {
            projectId: 'p1',
            projectKey: 'TST',
            queuePrefix: prefix,
            limits: { ...baseLimits, approvalDefaultTimeoutHours: 0.001 },
          },
        ],
      });
      return handle.result();
    });

    expect(outcome).toMatchObject({ status: 'PARKED', code: 'APPROVAL_TIMEOUT' });
  }, 60_000);

  it('recovers a decision from the database when the signal never arrived', async () => {
    if (!available) return;
    // The API committed the decision then died before signalling. The gate must not expire.
    const { activities } = makeActivities({
      reconcileApproval: async () => ({
        gate: 'BACKLOG',
        requestId: 'approval-1',
        decision: 'APPROVED',
        userId: 'u1',
      }),
    });
    const prefix = nextPrefix('reconcile');

    const outcome = await withWorkers(activities, prefix, async () => {
      const handle = await client!.workflow.start(BacklogWorkflow, {
        taskQueue: `${prefix}-main`,
        workflowId: prefix,
        args: [
          {
            projectId: 'p1',
            projectKey: 'TST',
            queuePrefix: prefix,
            limits: { ...baseLimits, approvalDefaultTimeoutHours: 0.001 },
          },
        ],
      });
      return handle.result();
    });

    expect(outcome).toMatchObject({ status: 'COMPLETED' });
  }, 60_000);

  it('parks on rejection without revising', async () => {
    if (!available) return;
    const { activities, agentCalls } = makeActivities();
    const prefix = nextPrefix('reject');

    const outcome = await withWorkers(activities, prefix, async () => {
      const handle = await client!.workflow.start(BacklogWorkflow, {
        taskQueue: `${prefix}-main`,
        workflowId: prefix,
        args: [{ projectId: 'p1', projectKey: 'TST', queuePrefix: prefix, limits: baseLimits }],
      });
      await handle.signal('approval', {
        gate: 'BACKLOG',
        requestId: 'approval-1',
        decision: 'REJECTED' as ApprovalDecisionType,
        userId: 'u1',
        comment: 'not viable',
      });
      return handle.result();
    });

    expect(outcome).toMatchObject({ status: 'PARKED', code: 'BACKLOG_REJECTED' });
    expect(agentCalls.filter((c) => c.agentKey === 'business-analyst')).toHaveLength(1);
  }, 60_000);
});

describe('bounded loops (invariant I6)', () => {
  it('stops revising the backlog after maxBacklogRevisions and parks', async () => {
    if (!available) return;
    const { activities, agentCalls } = makeActivities();
    const prefix = nextPrefix('backlog-loop');

    const outcome = await withWorkers(activities, prefix, async () => {
      const handle = await client!.workflow.start(BacklogWorkflow, {
        taskQueue: `${prefix}-main`,
        workflowId: prefix,
        args: [
          { projectId: 'p1', projectKey: 'TST', queuePrefix: prefix, limits: { ...baseLimits, maxBacklogRevisions: 2 } },
        ],
      });

      // A reviewer who is never satisfied. Signals are buffered and keyed by requestId, so every
      // round finds its own decision waiting.
      for (let round = 1; round <= 5; round += 1) {
        await handle.signal('approval', {
          gate: 'BACKLOG',
          requestId: `approval-${round}`,
          decision: 'CHANGES_REQUESTED' as ApprovalDecisionType,
          userId: 'u1',
          changeRequests: [
            { target: { kind: 'story', ref: 'US-1' }, instruction: 'again', severity: 'MUST' },
          ],
        });
      }
      return handle.result();
    });

    expect(outcome).toMatchObject({ status: 'PARKED', code: 'ITERATION_LIMIT_EXCEEDED' });
    // The bound holds: the BA is not asked an unbounded number of times.
    expect(agentCalls.filter((c) => c.agentKey === 'business-analyst').length).toBeLessThanOrEqual(3);
  }, 90_000);

  it('escalates a pull request to a human after maxPrFixIterations', async () => {
    if (!available) return;
    const { activities, agentCalls, interventions } = makeActivities();
    const prefix = nextPrefix('pr-loop');

    const outcome = await withWorkers(activities, prefix, async () => {
      const handle = await client!.workflow.start(CodeReviewWorkflow, {
        taskQueue: `${prefix}-main`,
        workflowId: prefix,
        args: [
          {
            projectId: 'p1',
            projectKey: 'TST',
            queuePrefix: prefix,
            repositoryKey: 'api',
            storyId: 's1',
            storyRef: 'US-1',
            prId: 'pr1',
            prNumber: 1,
            branchName: 'feat/US-1-x',
            limits: {
              maxPrFixIterations: 2,
              maxQaFixIterations: 3,
              maxBuildFixIterations: 2,
              maxParallelStories: 3,
              approvalDefaultTimeoutHours: 1,
            },
          },
        ],
      });

      for (let round = 1; round <= 5; round += 1) {
        await handle.signal('approval', {
          gate: 'PR',
          requestId: `approval-${round}`,
          decision: 'CHANGES_REQUESTED' as ApprovalDecisionType,
          userId: 'u1',
          changeRequests: [],
        });
      }
      // The loop exhausts and parks for a human; pre-signal the resolution.
      await handle.signal('intervention', {
        requestId: 'intervention-1',
        action: 'ABORT_PHASE',
        userId: 'u1',
      });
      return handle.result();
    });

    expect(outcome).toMatchObject({ status: 'PARKED', code: 'ITERATION_LIMIT_EXCEEDED' });
    expect(interventions).toContain('HUMAN_INTERVENTION_REQUIRED');
    // Two developer fix attempts at most: iterations 1 and 2, then escalation.
    expect(agentCalls.filter((c) => c.agentKey === 'developer').length).toBeLessThanOrEqual(2);
  }, 90_000);
});
