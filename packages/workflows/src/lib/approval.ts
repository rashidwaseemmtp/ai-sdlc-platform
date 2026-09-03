/**
 * The approval primitive — docs/08 §1.
 *
 * The whole point: a workflow suspends here, durably and indefinitely, across worker restarts,
 * until a human decides. No polling, no timer that auto-approves, no state lost if every process
 * dies in between.
 */

import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type {
  ApprovalOutcome,
  ArtifactRef,
  GateKey,
  InterventionAction,
  InterventionOutcome,
} from '@sdlc/shared';
import type { Activities } from '@sdlc/activities';
import { activityOptions, DEFAULT_QUEUE_PREFIX } from './retry.js';

export const approvalSignal = defineSignal<[ApprovalOutcome]>('approval');
export const interventionSignal = defineSignal<[InterventionOutcome]>('intervention');

export interface WaitForApprovalInput {
  gate: GateKey;
  projectId: string;
  workflowId: string;
  title: string;
  summary?: string;
  artifactRef?: ArtifactRef;
  context?: Record<string, unknown>;
  timeoutHours: number;
}

/**
 * A per-workflow inbox for approval signals.
 *
 * The handler is registered once, at workflow start, and *before* any request row exists — a human
 * approving within milliseconds of the request appearing must not lose the signal to a race.
 */
export class ApprovalInbox {
  private decisions = new Map<string, ApprovalOutcome>();
  private interventions = new Map<string, InterventionOutcome>();
  private readonly acts: Activities;

  constructor(queuePrefix: string = DEFAULT_QUEUE_PREFIX) {
    this.acts = proxyActivities<Activities>(activityOptions(queuePrefix).database);

    setHandler(approvalSignal, (decision) => {
      this.decisions.set(decision.requestId, decision);
    });
    setHandler(interventionSignal, (outcome) => {
      this.interventions.set(outcome.requestId, outcome);
    });
  }

  async waitForApproval(input: WaitForApprovalInput): Promise<ApprovalOutcome> {
    const requestId = await this.acts.createApprovalRequest({
      projectId: input.projectId,
      gate: input.gate,
      workflowId: input.workflowId,
      ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.context ? { context: input.context } : {}),
    });

    const settled = await condition(() => this.decisions.has(requestId), `${input.timeoutHours}h`);

    if (!settled) {
      // The API may have committed a decision and died before signalling. The signal is the fast
      // path; the database is the truth.
      const reconciled = await this.acts.reconcileApproval(requestId);
      if (reconciled) {
        await this.acts.settleApprovalRequest(
          requestId,
          reconciled.decision as 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED',
        );
        return reconciled;
      }
      await this.acts.expireApprovalRequest(requestId);
      return { gate: input.gate, requestId, decision: 'EXPIRED' };
    }

    const decision = this.decisions.get(requestId)!;
    this.decisions.delete(requestId);
    await this.acts.settleApprovalRequest(
      requestId,
      decision.decision as 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED',
    );
    return decision;
  }

  /**
   * Park the workflow and wait for a human. This is what every bounded loop falls back to when it
   * exhausts its attempts: the workflow stays alive, so nothing is lost while it waits.
   */
  async waitForIntervention(input: {
    projectId: string;
    workflowId: string;
    code: string;
    reason: string;
    context?: Record<string, unknown>;
  }): Promise<InterventionOutcome> {
    const requestId = await this.acts.createInterventionRequest({
      projectId: input.projectId,
      workflowId: input.workflowId,
      code: input.code,
      reason: input.reason,
      context: input.context ?? {},
    });

    // No timeout: an intervention waits as long as it takes.
    await condition(() => this.interventions.has(requestId));

    const outcome = this.interventions.get(requestId)!;
    this.interventions.delete(requestId);
    await this.acts.resolveIntervention(requestId, outcome.action);
    return outcome;
  }
}

export type { InterventionAction };
