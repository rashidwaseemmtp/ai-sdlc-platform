/**
 * ProjectWorkflow — the long-lived parent.
 *
 * The only workflow a human starts directly. It owns the project lifecycle, spawns each phase as a
 * child, tracks spend against the workflow ceiling, and parks rather than dies when something needs
 * a person.
 *
 * `continueAsNew` keeps history bounded: a year-long project would otherwise accumulate an
 * unreplayable event log.
 */

import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
  log,
  ParentClosePolicy,
} from '@temporalio/workflow';
import type { ProjectPhase } from '@sdlc/shared';
import type { Activities } from '@sdlc/activities';
import { activityOptions, DEFAULT_QUEUE_PREFIX } from './lib/retry.js';
import { ApprovalInbox } from './lib/approval.js';
import {
  ArchitectureWorkflow,
  BacklogWorkflow,
  DiscoveryWorkflow,
  EstimationWorkflow,
  PlanningWorkflow,
  type PhaseOutcome,
} from './phases.js';
import { DevelopmentWorkflow } from './delivery.js';


export const WORKFLOW_VERSION = 1;
const MAX_HISTORY_EVENTS = 10_000;

export interface ProjectWorkflowInput {
  projectId: string;
  projectKey: string;
  repositoryKey: string;
  /** Task-queue prefix. Defaults to `sdlc`; tests and isolated environments override it. */
  queuePrefix?: string;
  limits: {
    maxBacklogRevisions: number;
    maxArchitectureRounds: number;
    maxPrFixIterations: number;
    maxQaFixIterations: number;
    maxBuildFixIterations: number;
    maxParallelStories: number;
    maxWorkflowCostUsd: number;
    estimationVarianceThreshold: number;
    approvalDefaultTimeoutHours: number;
  };
  /** Set on continueAsNew so a resumed project does not repeat completed phases. */
  completedPhases?: string[];
  spendUsd?: number;
}

export interface ProjectState {
  phase: ProjectPhase;
  completedPhases: string[];
  spendUsd: number;
  parked: boolean;
  lastError?: { code: string; message: string };
  version: number;
}

export const pauseSignal = defineSignal('pauseProject');
export const resumeSignal = defineSignal('resumeProject');
export const cancelSignal = defineSignal('cancelProject');
export const getStateQuery = defineQuery<ProjectState>('getState');

const PHASES = [
  { key: 'discovery', workflow: DiscoveryWorkflow },
  { key: 'backlog', workflow: BacklogWorkflow },
  { key: 'architecture', workflow: ArchitectureWorkflow },
  { key: 'estimation', workflow: EstimationWorkflow },
  { key: 'planning', workflow: PlanningWorkflow },
] as const;

export async function ProjectWorkflow(input: ProjectWorkflowInput): Promise<ProjectState> {
  const db = proxyActivities<Activities>(activityOptions(input.queuePrefix).database);
  const inbox = new ApprovalInbox(input.queuePrefix);
  const { workflowId, runId } = workflowInfo();

  const state: ProjectState = {
    phase: 'DISCOVERY',
    completedPhases: input.completedPhases ?? [],
    spendUsd: input.spendUsd ?? 0,
    parked: false,
    version: WORKFLOW_VERSION,
  };

  let paused = false;
  let cancelled = false;

  setHandler(pauseSignal, () => {
    paused = true;
  });
  setHandler(resumeSignal, () => {
    paused = false;
  });
  setHandler(cancelSignal, () => {
    cancelled = true;
  });
  setHandler(getStateQuery, () => state);

  await db.recordWorkflowRun({
    projectId: input.projectId,
    workflowId,
    runId,
    type: 'ProjectWorkflow',
    taskQueue: `${input.queuePrefix ?? DEFAULT_QUEUE_PREFIX}-main`,
  });

  for (const phase of PHASES) {
    if (cancelled) break;
    if (state.completedPhases.includes(phase.key)) continue;

    // Pausing suspends between phases, not mid-phase: interrupting an agent halfway leaves a
    // half-written artifact, and a pause should be a clean boundary.
    await condition(() => !paused || cancelled);
    if (cancelled) break;

    log.info('starting phase', { phase: phase.key });

    const outcome: PhaseOutcome = await executeChild(phase.workflow, {
      workflowId: `project-${input.projectKey}-${phase.key}`,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      args: [
        {
          projectId: input.projectId,
          projectKey: input.projectKey,
          ...(input.queuePrefix ? { queuePrefix: input.queuePrefix } : {}),
          limits: {
            maxBacklogRevisions: input.limits.maxBacklogRevisions,
            maxArchitectureRounds: input.limits.maxArchitectureRounds,
            estimationVarianceThreshold: input.limits.estimationVarianceThreshold,
            approvalDefaultTimeoutHours: input.limits.approvalDefaultTimeoutHours,
          },
        },
      ],
    });

    if (outcome.status === 'PARKED') {
      state.parked = true;
      state.lastError = { code: outcome.code, message: outcome.reason };

      const intervention = await inbox.waitForIntervention({
        projectId: input.projectId,
        workflowId,
        code: outcome.code,
        reason: outcome.reason,
        context: { phase: phase.key },
      });

      if (intervention.action === 'ABORT_PHASE') break;
      if (intervention.action === 'RAISE_BUDGET' && intervention.raisedBudgetUsd) {
        input.limits.maxWorkflowCostUsd = intervention.raisedBudgetUsd;
      }
      // RETRY and RETRY_WITH_CHANGES fall through and re-enter the same phase.
      state.parked = false;
      continue;
    }

    state.completedPhases.push(phase.key);
    delete state.lastError;

    // History grows with every phase; continue-as-new before it becomes unreplayable.
    if (workflowInfo().historyLength > MAX_HISTORY_EVENTS) {
      await continueAsNew<typeof ProjectWorkflow>({
        ...input,
        completedPhases: state.completedPhases,
        spendUsd: state.spendUsd,
      });
    }
  }

  if (!cancelled && state.completedPhases.includes('planning')) {
    const development = await executeChild(DevelopmentWorkflow, {
      workflowId: `project-${input.projectKey}-development`,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      args: [
        {
          projectId: input.projectId,
          projectKey: input.projectKey,
          repositoryKey: input.repositoryKey,
          ...(input.queuePrefix ? { queuePrefix: input.queuePrefix } : {}),
          limits: {
            maxPrFixIterations: input.limits.maxPrFixIterations,
            maxQaFixIterations: input.limits.maxQaFixIterations,
            maxBuildFixIterations: input.limits.maxBuildFixIterations,
            maxParallelStories: input.limits.maxParallelStories,
            approvalDefaultTimeoutHours: input.limits.approvalDefaultTimeoutHours,
          },
        },
      ],
    });

    state.completedPhases.push('development');
    if (development.parked.length === 0) {
      state.phase = 'COMPLETED';
      await db.setProjectPhase(input.projectId, 'COMPLETED');
      await db.emitEvent({
        projectId: input.projectId,
        type: 'PROJECT_COMPLETED',
        payload: { stories: development.done.length },
      });
    } else {
      state.parked = true;
      state.phase = 'HUMAN_INTERVENTION_REQUIRED';
    }
  }

  await db.closeWorkflowRun(workflowId, runId, cancelled ? 'FAILED' : 'COMPLETED');
  return state;
}
