/**
 * Agent contract — docs/04-agent-architecture.md.
 *
 * An agent is a contract, not a prompt: schemas, permissions, budget, context recipe and the
 * artifact kinds it is allowed to write. The runtime enforces every field here.
 */

import type { ModelPolicy } from './model.js';
import type { McpPermission } from './mcp.js';
import type { ArtifactKind, ArtifactRef } from './artifact.js';
import type { ContextRecipeKey } from './context.js';

export type AgentKey =
  | 'product-owner'
  | 'business-analyst'
  | 'architect'
  | 'architecture-critic'
  | 'estimator'
  | 'resource-planner'
  | 'delivery-planner'
  | 'developer'
  | 'code-reviewer'
  | 'security-reviewer'
  | 'qa'
  | 'bug-analyzer'
  | 'echo';

/** Domain-level RBAC — docs/07 §3. Note that no agent is ever seeded with an `approve_*` value. */
export type AgentPermission =
  | 'read_project'
  | 'write_project'
  | 'read_requirements'
  | 'write_requirements'
  | 'read_backlog'
  | 'write_backlog'
  | 'approve_backlog'
  | 'read_architecture'
  | 'write_architecture'
  | 'approve_architecture'
  | 'read_estimation'
  | 'write_estimation'
  | 'approve_estimation'
  | 'create_branch'
  | 'write_code'
  | 'push_code'
  | 'create_pr'
  | 'merge_pr'
  | 'run_tests'
  | 'approve_qa'
  | 'release';

/** Anti-infinite-loop controls — docs/59. Every field is a hard stop, not a hint. */
export interface AgentBudget {
  maxCostUsd: number;
  maxTokens: number;
  maxToolCalls: number;
  maxIterations: number;
  maxWallClockSeconds: number;
}

export interface PromptRef {
  agentKey: AgentKey;
  version: string;
  path: string;
  sha256: string;
}

export interface QualityCheckResult {
  passed: boolean;
  severity: 'HARD' | 'SOFT';
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface QualityCheck<O> {
  code: string;
  severity: 'HARD' | 'SOFT';
  description: string;
  run(output: O, ctx: QualityCheckContext): Promise<QualityCheckResult> | QualityCheckResult;
}

export interface QualityCheckContext {
  projectId: string;
  agentKey: AgentKey;
  inputRefs: ArtifactRef[];
}

export interface AgentDefinition<I = unknown, O = unknown> {
  key: AgentKey;
  version: number;
  name: string;
  role: string;
  enabled: boolean;

  promptRef: PromptRef;
  modelPolicy: ModelPolicy;
  contextRecipe: ContextRecipeKey;

  mcpServers: McpPermission[];
  permissions: AgentPermission[];
  /** Artifact kinds this agent may create. Persistence rejects anything else (docs/04 §1). */
  writes: ArtifactKind[];

  inputSchema: unknown; // ZodSchema<I> at runtime; kept structural to avoid a zod dep in types
  outputSchema: unknown; // ZodSchema<O>
  qualityChecks: QualityCheck<O>[];

  maxRetries: number;
  timeoutSeconds: number;
  budget: AgentBudget;

  __input?: I;
  __output?: O;
}

export interface AgentInvocation {
  agentKey: AgentKey;
  projectId: string;
  phase?: string;
  subjectRef?: string;
  /** Pinned input artifact versions. These become lineage edges — agents cannot forge them. */
  inputRefs: ArtifactRef[];
  input: Record<string, unknown>;
  workflowId?: string;
  workflowRunId?: string;
  activityId?: string;
  attempt: number;
  /** Ceilings from the parent workflow, intersected with the agent's own budget. */
  workflowCeilings?: Partial<AgentBudget>;
}

/**
 * The auditable explanation shown to human approvers. Deliberately *not* chain-of-thought:
 * the runtime never requests, logs or persists raw reasoning traces (invariant I9).
 */
export interface DecisionSummary {
  summary: string;
  evidence: ArtifactRef[];
  assumptions: string[];
  risks: { description: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }[];
  tradeoffs: string[];
  openQuestions: string[];
  confidence: number;
}

export const AgentRunStatus = {
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
} as const;
export type AgentRunStatus = (typeof AgentRunStatus)[keyof typeof AgentRunStatus];

/**
 * What crosses the workflow boundary. Never a document body — invariant I4 caps activity
 * payloads, and this is the shape that keeps histories small.
 */
export interface AgentRunResult {
  agentRunId: string;
  status: AgentRunStatus;
  outputRef?: ArtifactRef;
  decisionSummary?: DecisionSummary;
  qualityWarnings: QualityCheckResult[];
  costUsd: number;
  costUnknown: boolean;
  quotaUnits: number;
  tokens: number;
  durationMs: number;
  modelId?: string;
  providerKey?: string;
  error?: { code: string; message: string };
}
