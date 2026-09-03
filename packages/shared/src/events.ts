/**
 * Domain events — docs/03 §39, persisted append-only to `domain_events` and relayed to Redis
 * Streams through the transactional outbox, so an event is never published for a transaction
 * that failed to commit.
 */

export const DomainEventType = {
  // Project lifecycle
  PROJECT_CREATED: 'PROJECT_CREATED',
  PROJECT_PHASE_CHANGED: 'PROJECT_PHASE_CHANGED',
  PROJECT_PAUSED: 'PROJECT_PAUSED',
  PROJECT_RESUMED: 'PROJECT_RESUMED',
  PROJECT_COMPLETED: 'PROJECT_COMPLETED',

  // Discovery & requirements
  MEETING_IMPORTED: 'MEETING_IMPORTED',
  DOCUMENT_INGESTED: 'DOCUMENT_INGESTED',
  REQUIREMENTS_CREATED: 'REQUIREMENTS_CREATED',

  // Backlog
  BACKLOG_CREATED: 'BACKLOG_CREATED',
  BACKLOG_REVISED: 'BACKLOG_REVISED',
  BACKLOG_APPROVED: 'BACKLOG_APPROVED',
  STORY_APPROVED: 'STORY_APPROVED',
  STORY_REJECTED: 'STORY_REJECTED',

  // Architecture
  ARCHITECTURE_CREATED: 'ARCHITECTURE_CREATED',
  ARCHITECTURE_EVALUATED: 'ARCHITECTURE_EVALUATED',
  ARCHITECTURE_APPROVED: 'ARCHITECTURE_APPROVED',
  ADR_CREATED: 'ADR_CREATED',
  ADR_SUPERSEDED: 'ADR_SUPERSEDED',

  // Estimation & planning
  ESTIMATION_CREATED: 'ESTIMATION_CREATED',
  ESTIMATION_VARIANCE_FLAGGED: 'ESTIMATION_VARIANCE_FLAGGED',
  ESTIMATION_APPROVED: 'ESTIMATION_APPROVED',
  RESOURCE_PLAN_CREATED: 'RESOURCE_PLAN_CREATED',
  DELIVERY_PLAN_CREATED: 'DELIVERY_PLAN_CREATED',
  READY_FOR_DEVELOPMENT: 'READY_FOR_DEVELOPMENT',

  // Development
  STORY_STARTED: 'STORY_STARTED',
  STORY_COMPLETED: 'STORY_COMPLETED',
  BRANCH_CREATED: 'BRANCH_CREATED',
  PR_CREATED: 'PR_CREATED',
  PR_REVIEW_REQUESTED: 'PR_REVIEW_REQUESTED',
  PR_CHANGES_REQUESTED: 'PR_CHANGES_REQUESTED',
  PR_APPROVED: 'PR_APPROVED',
  PR_MERGED: 'PR_MERGED',

  // Quality
  QA_STARTED: 'QA_STARTED',
  TEST_CASES_CREATED: 'TEST_CASES_CREATED',
  TEST_RUN_COMPLETED: 'TEST_RUN_COMPLETED',
  QA_PASSED: 'QA_PASSED',
  QA_FAILED: 'QA_FAILED',
  BUG_CREATED: 'BUG_CREATED',
  BUG_FIXED: 'BUG_FIXED',

  // Agents & orchestration
  AGENT_STARTED: 'AGENT_STARTED',
  AGENT_COMPLETED: 'AGENT_COMPLETED',
  AGENT_FAILED: 'AGENT_FAILED',
  MODEL_FALLBACK_USED: 'MODEL_FALLBACK_USED',
  TOOL_CALL_DENIED: 'TOOL_CALL_DENIED',
  ARTIFACT_VERSION_CREATED: 'ARTIFACT_VERSION_CREATED',

  // Human in the loop
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_DECIDED: 'APPROVAL_DECIDED',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  HUMAN_INTERVENTION_REQUIRED: 'HUMAN_INTERVENTION_REQUIRED',
  HUMAN_INTERVENTION_RESOLVED: 'HUMAN_INTERVENTION_RESOLVED',

  // Cost
  COST_UPDATED: 'COST_UPDATED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
} as const;

export type DomainEventType = (typeof DomainEventType)[keyof typeof DomainEventType];

/** `agent:<key>` | `user:<id>` | `system` — every event says who caused it. */
export type EventActor = `agent:${string}` | `user:${string}` | 'system';

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  projectId: string;
  type: DomainEventType;
  payload: T;
  actor: EventActor;
  workflowId?: string;
  agentRunId?: string;
  occurredAt: string;
  sequence?: bigint;
}

export interface DomainEventInput<T = Record<string, unknown>> {
  projectId: string;
  type: DomainEventType;
  payload: T;
  actor: EventActor;
  workflowId?: string;
  agentRunId?: string;
}

/** Ephemeral SSE frames that are *not* persisted — progress ticks from a running agent. */
export interface AgentProgressFrame {
  type: 'agent.progress';
  agentRunId: string;
  projectId: string;
  step: string;
  iteration: number;
  tokensUsed: number;
  costUsd: number;
  elapsedMs: number;
}
