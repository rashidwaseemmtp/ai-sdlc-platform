/**
 * Agent execution activity — the bridge between a deterministic workflow and a non-deterministic
 * model call.
 *
 * Heartbeats on every runtime step, so Temporal can tell a slow agent from a dead worker, and so a
 * crashed attempt is rescheduled rather than hanging until the start-to-close timeout.
 */

import { Context } from '@temporalio/activity';
import type { AgentInvocation, AgentKey, AgentRunResult, ArtifactRef } from '@sdlc/shared';
import { getLogger } from '@sdlc/observability';
import type { ActivityDeps } from './context.js';

const log = getLogger({ component: 'agent-activity' });

export interface RunAgentInput {
  agentKey: AgentKey;
  projectId: string;
  phase?: string;
  subjectRef?: string;
  inputRefs?: ArtifactRef[];
  input: Record<string, unknown>;
  /** Ceilings the parent workflow imposes on top of the agent's own budget. */
  workflowCeilings?: { maxCostUsd?: number; maxWallClockSeconds?: number };
}

export function agentActivities(deps: ActivityDeps) {
  return {
    /**
     * Run one agent. Returns an ArtifactRef and a spend report — never a document body, so the
     * workflow history stays small (invariant I4).
     */
    async runAgent(input: RunAgentInput): Promise<AgentRunResult> {
      const activity = Context.current();
      const { workflowExecution, activityId, attempt } = activity.info;
      // workflowExecution is optional in the Temporal typings (a local activity has none), but an
      // agent run is always scheduled from a workflow. Fall back rather than assert.
      const workflowId = workflowExecution?.workflowId ?? 'unknown';
      const workflowRunId = workflowExecution?.runId ?? 'unknown';

      const invocation: AgentInvocation = {
        agentKey: input.agentKey,
        projectId: input.projectId,
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.subjectRef ? { subjectRef: input.subjectRef } : {}),
        inputRefs: input.inputRefs ?? [],
        input: input.input,
        workflowId,
        workflowRunId,
        activityId,
        attempt,
        ...(input.workflowCeilings ? { workflowCeilings: input.workflowCeilings } : {}),
      };

      // The runtime calls back on every step; that is what keeps the heartbeat alive during a long
      // tool loop and what feeds the live agent view in the dashboard.
      const heartbeat = (progress: unknown): void => {
        activity.heartbeat(progress);
      };

      const runtimeWithProgress = deps.runtime;
      log.info(
        { agentKey: input.agentKey, projectId: input.projectId, attempt },
        'starting agent run',
      );

      const result = await runtimeWithProgress.execute(invocation);
      heartbeat({ step: 'completed', costUsd: result.costUsd });

      await deps.publish('agent.completed', {
        projectId: input.projectId,
        agentRunId: result.agentRunId,
        agentKey: input.agentKey,
        status: result.status,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });

      return result;
    },

    /** Cancel a running agent (used by the API and by workflow cancellation). */
    async cancelAgentRun(agentRunId: string): Promise<void> {
      await deps.prisma.agentRun.update({
        where: { id: agentRunId },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
    },
  };
}
