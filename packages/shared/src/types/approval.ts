/**
 * Human approval — docs/08-approvals.md.
 *
 * Approval is a workflow primitive: a DB row for the UI plus a Temporal signal for the workflow.
 * Nothing here polls, and nothing auto-approves on timeout.
 */

import type { ArtifactRef } from './artifact.js';
import type { DecisionSummary, QualityCheckResult } from './agent.js';

export const GateKey = {
  BACKLOG: 'BACKLOG',
  ARCHITECTURE: 'ARCHITECTURE',
  ESTIMATION: 'ESTIMATION',
  DEV_READINESS: 'DEV_READINESS',
  PR: 'PR',
  QA: 'QA',
  RELEASE: 'RELEASE',
} as const;
export type GateKey = (typeof GateKey)[keyof typeof GateKey];

export const UserRole = {
  ADMIN: 'ADMIN',
  PRODUCT: 'PRODUCT',
  ARCHITECT: 'ARCHITECT',
  ENGINEER: 'ENGINEER',
  QA: 'QA',
  VIEWER: 'VIEWER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const ApprovalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export type ApprovalDecisionType = 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';

/** Structured feedback the revising agent consumes as typed input, not as a chat transcript. */
export interface ChangeRequest {
  target: {
    kind: 'story' | 'criterion' | 'option' | 'estimate' | 'section' | 'pr';
    ref: string;
  };
  instruction: string;
  severity: 'MUST' | 'SHOULD' | 'CONSIDER';
}

export interface ApprovalGateConfig {
  key: GateKey;
  enabled: boolean;
  requiredRole: UserRole;
  timeoutHours: number;
  autoApprove: boolean;
}

export interface CreateApprovalRequestInput {
  projectId: string;
  gate: GateKey;
  workflowId: string;
  workflowRunId?: string;
  artifactRef?: ArtifactRef;
  title: string;
  summary?: string;
  context?: Record<string, unknown>;
}

/** The signal payload. `decision: 'EXPIRED'` is produced by the workflow, never by a human. */
export interface ApprovalOutcome {
  gate: GateKey;
  requestId: string;
  decision: ApprovalDecisionType | 'EXPIRED';
  userId?: string;
  comment?: string;
  changeRequests?: ChangeRequest[];
  decidedAt?: string;
}

export interface ApprovalPresentation {
  requestId: string;
  gate: GateKey;
  status: ApprovalStatus;
  requiredRole: UserRole;
  requestedAt: string;
  expiresAt?: string;
  artifact?: { kind: string; version: number; content: unknown };
  diff?: unknown;
  decisionSummary?: DecisionSummary;
  qualityWarnings: QualityCheckResult[];
  provenance: {
    agentKey?: string;
    agentVersion?: number;
    promptVersion?: string;
    modelId?: string;
    providerKey?: string;
    costUsd?: number;
    durationMs?: number;
  };
  lineage: ArtifactRef[];
  actions: Array<'APPROVE' | 'REJECT' | 'REQUEST_CHANGES' | 'COMMENT'>;
}

/** Raised when a workflow parks. Shares the signal mechanism with approvals (docs/08 §6). */
export type InterventionAction =
  | 'RETRY'
  | 'RETRY_WITH_CHANGES'
  | 'SKIP_STORY'
  | 'ABORT_PHASE'
  | 'RAISE_BUDGET';

export interface InterventionOutcome {
  requestId: string;
  action: InterventionAction;
  userId: string;
  comment?: string;
  changeRequests?: ChangeRequest[];
  raisedBudgetUsd?: number;
}
