/**
 * Workflow-facing types — docs/03-workflows.md.
 *
 * Everything here must be serialisable and small: it travels through Temporal history.
 */

export const TaskQueue = {
  MAIN: 'sdlc-main',
  AGENTS: 'sdlc-agents',
  TOOLS: 'sdlc-tools',
  HEAVY: 'sdlc-heavy',
} as const;
export type TaskQueue = (typeof TaskQueue)[keyof typeof TaskQueue];

export const ProjectPhase = {
  DISCOVERY: 'DISCOVERY',
  REQUIREMENTS: 'REQUIREMENTS',
  BACKLOG_DRAFT: 'BACKLOG_DRAFT',
  BACKLOG_REVIEW: 'BACKLOG_REVIEW',
  BACKLOG_APPROVED: 'BACKLOG_APPROVED',
  ARCHITECTURE: 'ARCHITECTURE',
  ARCHITECTURE_APPROVED: 'ARCHITECTURE_APPROVED',
  ESTIMATION: 'ESTIMATION',
  PLANNING: 'PLANNING',
  READY_FOR_DEVELOPMENT: 'READY_FOR_DEVELOPMENT',
  IN_DEVELOPMENT: 'IN_DEVELOPMENT',
  IN_QA: 'IN_QA',
  RELEASE: 'RELEASE',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  HUMAN_INTERVENTION_REQUIRED: 'HUMAN_INTERVENTION_REQUIRED',
} as const;
export type ProjectPhase = (typeof ProjectPhase)[keyof typeof ProjectPhase];

/** Deterministic workflow ids — how the API finds a running workflow with no lookup table. */
export const workflowIds = {
  project: (projectKey: string) => `project-${projectKey}`,
  phase: (projectKey: string, phase: string) => `project-${projectKey}-${phase.toLowerCase()}`,
  story: (projectKey: string, storyRef: string) => `project-${projectKey}-story-${storyRef}`,
  codeReview: (projectKey: string, storyRef: string, n: number) =>
    `project-${projectKey}-story-${storyRef}-review-${n}`,
  qa: (projectKey: string, storyRef: string, n: number) =>
    `project-${projectKey}-story-${storyRef}-qa-${n}`,
} as const;

export interface ProjectWorkflowState {
  phase: ProjectPhase;
  activeChildren: string[];
  pendingApprovals: string[];
  spendUsd: number;
  iteration: Record<string, number>;
  lastError?: { code: string; message: string };
  parked: boolean;
}

export interface WorkflowLimits {
  maxPrFixIterations: number;
  maxQaFixIterations: number;
  maxBuildFixIterations: number;
  maxBacklogRevisions: number;
  maxArchitectureRounds: number;
  maxParallelStories: number;
  maxWorkflowCostUsd: number;
  estimationVarianceThreshold: number;
  approvalDefaultTimeoutHours: number;
}
