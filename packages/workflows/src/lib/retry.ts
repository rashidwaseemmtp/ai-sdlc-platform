/**
 * Retry policies — docs/03 §5.
 *
 * Different activity groups need genuinely different policies. An LLM call that times out should
 * back off; a failing build should not be retried at all, because a failure there is a *result*
 * that drives the bounded fix loop rather than an error to paper over.
 */

import type { ActivityOptions, RetryPolicy } from '@temporalio/workflow';
import { NON_RETRYABLE_CODES } from '@sdlc/shared';

const NEVER_RETRY = [...NON_RETRYABLE_CODES];

const llm: RetryPolicy = {
  maximumAttempts: 3,
  initialInterval: '5s',
  backoffCoefficient: 2,
  maximumInterval: '60s',
  nonRetryableErrorTypes: NEVER_RETRY,
};

const database: RetryPolicy = {
  maximumAttempts: 5,
  initialInterval: '200ms',
  backoffCoefficient: 2,
  maximumInterval: '5s',
  nonRetryableErrorTypes: ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT'],
};

const vcs: RetryPolicy = {
  maximumAttempts: 5,
  initialInterval: '2s',
  backoffCoefficient: 2,
  maximumInterval: '60s',
  nonRetryableErrorTypes: ['NOT_FOUND', 'PERMISSION_DENIED'],
};

const tooling: RetryPolicy = {
  maximumAttempts: 3,
  initialInterval: '1s',
  backoffCoefficient: 2,
  maximumInterval: '20s',
  nonRetryableErrorTypes: ['MCP_DISABLED', 'PERMISSION_DENIED'],
};

const heavy: RetryPolicy = {
  maximumAttempts: 2,
  initialInterval: '10s',
  backoffCoefficient: 2,
  maximumInterval: '60s',
  nonRetryableErrorTypes: ['BUILD_FAILED', 'PERMISSION_DENIED'],
};

/** CI polling: many attempts with a long total span, because the retry *is* the poll loop. */
const polling: RetryPolicy = {
  maximumAttempts: 60,
  initialInterval: '10s',
  backoffCoefficient: 1.2,
  maximumInterval: '60s',
  nonRetryableErrorTypes: ['NOT_FOUND', 'PERMISSION_DENIED'],
};

export const DEFAULT_QUEUE_PREFIX = 'sdlc';

export const TASK_QUEUES = {
  MAIN: 'sdlc-main',
  AGENTS: 'sdlc-agents',
  TOOLS: 'sdlc-tools',
  HEAVY: 'sdlc-heavy',
} as const;

/**
 * Activity options for a given queue prefix.
 *
 * The prefix is a workflow *input*, not a constant, so a test (or a second environment sharing a
 * namespace) can run on isolated queues. Without this, a test worker and the dev worker both poll
 * `sdlc-main` and silently steal each other's activities — which is exactly what happened the
 * first time these tests ran.
 */
export function activityOptions(prefix: string = DEFAULT_QUEUE_PREFIX) {
  const q = {
    MAIN: `${prefix}-main`,
    AGENTS: `${prefix}-agents`,
    TOOLS: `${prefix}-tools`,
    HEAVY: `${prefix}-heavy`,
  };

  return {
    agent: { ...ACTIVITY_OPTIONS.agent, taskQueue: q.AGENTS },
    database: { ...ACTIVITY_OPTIONS.database, taskQueue: q.MAIN },
    vcs: { ...ACTIVITY_OPTIONS.vcs, taskQueue: q.TOOLS },
    tooling: { ...ACTIVITY_OPTIONS.tooling, taskQueue: q.TOOLS },
    heavy: { ...ACTIVITY_OPTIONS.heavy, taskQueue: q.HEAVY },
    polling: { ...ACTIVITY_OPTIONS.polling, taskQueue: q.TOOLS },
    gates: { ...ACTIVITY_OPTIONS.gates, taskQueue: q.HEAVY },
  } as const;
}

export const ACTIVITY_OPTIONS = {
  agent: {
    taskQueue: TASK_QUEUES.AGENTS,
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '2 minutes',
    scheduleToCloseTimeout: '90 minutes',
    retry: llm,
  } satisfies ActivityOptions,

  database: {
    taskQueue: TASK_QUEUES.MAIN,
    startToCloseTimeout: '30 seconds',
    scheduleToCloseTimeout: '5 minutes',
    retry: database,
  } satisfies ActivityOptions,

  vcs: {
    taskQueue: TASK_QUEUES.TOOLS,
    startToCloseTimeout: '5 minutes',
    scheduleToCloseTimeout: '30 minutes',
    retry: vcs,
  } satisfies ActivityOptions,

  tooling: {
    taskQueue: TASK_QUEUES.TOOLS,
    startToCloseTimeout: '5 minutes',
    scheduleToCloseTimeout: '20 minutes',
    retry: tooling,
  } satisfies ActivityOptions,

  heavy: {
    taskQueue: TASK_QUEUES.HEAVY,
    startToCloseTimeout: '30 minutes',
    heartbeatTimeout: '5 minutes',
    scheduleToCloseTimeout: '70 minutes',
    retry: heavy,
  } satisfies ActivityOptions,

  polling: {
    taskQueue: TASK_QUEUES.TOOLS,
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '60 minutes',
    retry: polling,
  } satisfies ActivityOptions,

  /**
   * Build and test gates run exactly once. A failing build is a result the fix loop consumes, and
   * retrying it would burn the loop's budget re-running a deterministic failure.
   */
  gates: {
    taskQueue: TASK_QUEUES.HEAVY,
    startToCloseTimeout: '20 minutes',
    scheduleToCloseTimeout: '25 minutes',
    retry: { maximumAttempts: 1 },
  } satisfies ActivityOptions,
} as const;
