/**
 * Approval activities — docs/08.
 *
 * The signal is the fast path; the database is the truth. `reconcileApproval` exists for exactly
 * one case: the API committed a decision and died before signalling. Without it, that decision
 * would sit in the database while the workflow waited out its timeout.
 */

import type { PrismaClient } from '@sdlc/database';
import {
  FailureCode,
  PlatformError,
  type ApprovalOutcome,
  type ArtifactRef,
  type CreateApprovalRequestInput,
  type GateKey,
  type InterventionAction,
} from '@sdlc/shared';
import { getLogger } from '@sdlc/observability';
import type { ActivityDeps } from './context.js';

const log = getLogger({ component: 'approval-activity' });

export function approvalActivities(deps: ActivityDeps) {
  const prisma: PrismaClient = deps.prisma;

  return {
    async createApprovalRequest(input: CreateApprovalRequestInput): Promise<string> {
      const gate = await prisma.approvalGate.findUnique({
        where: { projectId_key: { projectId: input.projectId, key: input.gate } },
      });

      if (gate && !gate.enabled) {
        throw new PlatformError({
          code: FailureCode.GATE_DISABLED,
          message: `approval gate ${input.gate} is disabled for this project`,
          details: { gate: input.gate },
        });
      }

      const timeoutHours = gate?.timeoutHours ?? deps.limits.approvalDefaultTimeoutHours;
      const requiredRole = gate?.requiredRole ?? 'ADMIN';

      const request = await prisma.approvalRequest.create({
        data: {
          projectId: input.projectId,
          gateKey: input.gate,
          workflowId: input.workflowId,
          ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
          ...(input.artifactRef ? { artifactVersionId: input.artifactRef.versionId } : {}),
          requiredRole,
          title: input.title,
          ...(input.summary ? { summary: input.summary } : {}),
          context: (input.context ?? {}) as object,
          expiresAt: new Date(Date.now() + timeoutHours * 3600_000),
        },
      });

      await recordEvent(prisma, deps, {
        projectId: input.projectId,
        type: 'APPROVAL_REQUESTED',
        payload: { requestId: request.id, gate: input.gate, requiredRole },
        workflowId: input.workflowId,
      });

      log.info({ requestId: request.id, gate: input.gate }, 'approval requested');
      return request.id;
    },

    /**
     * Belt and braces for the crash window between the API commit and the signal. Returns the
     * decision if one was recorded, otherwise null so the workflow can expire the gate.
     */
    async reconcileApproval(requestId: string): Promise<ApprovalOutcome | null> {
      const request = await prisma.approvalRequest.findUnique({
        where: { id: requestId },
        include: { decision: true },
      });
      if (!request?.decision) return null;

      log.warn({ requestId }, 'approval decision recovered from the database, not from a signal');
      return {
        gate: request.gateKey as GateKey,
        requestId,
        decision: request.decision.decision,
        userId: request.decision.userId,
        ...(request.decision.comment ? { comment: request.decision.comment } : {}),
        changeRequests: (request.decision.changeRequests ?? []) as unknown as ApprovalOutcome['changeRequests'],
        decidedAt: request.decision.decidedAt.toISOString(),
      };
    },

    async expireApprovalRequest(requestId: string): Promise<void> {
      const request = await prisma.approvalRequest.update({
        where: { id: requestId },
        data: { status: 'EXPIRED', resolvedAt: new Date() },
      });

      await recordEvent(prisma, deps, {
        projectId: request.projectId,
        type: 'APPROVAL_EXPIRED',
        payload: { requestId, gate: request.gateKey },
        workflowId: request.workflowId,
      });
    },

    /** Marks the request resolved once the workflow has consumed the signal. */
    async settleApprovalRequest(requestId: string, status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED'): Promise<void> {
      await prisma.approvalRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data: { status, resolvedAt: new Date() },
      });
    },

    /** Approving an artifact pins its version: from here it is immutable (invariant I3). */
    async approveArtifact(ref: ArtifactRef, userId: string): Promise<void> {
      await deps.artifacts.approve(ref, userId);
    },

    /**
     * Park the workflow. This is not a failure state — the workflow stays alive waiting on a
     * signal, so a human can unblock it hours later without losing any progress.
     */
    async createInterventionRequest(input: {
      projectId: string;
      workflowId: string;
      reason: string;
      code: string;
      context: Record<string, unknown>;
    }): Promise<string> {
      const request = await prisma.approvalRequest.create({
        data: {
          projectId: input.projectId,
          gateKey: 'RELEASE', // interventions reuse the approval mechanism; the gate is nominal
          workflowId: input.workflowId,
          signalName: 'intervention',
          requiredRole: 'ADMIN',
          title: `Human intervention required: ${input.code}`,
          summary: input.reason,
          context: { ...input.context, intervention: true, code: input.code } as object,
        },
      });

      await prisma.project.update({
        where: { id: input.projectId },
        data: { phase: 'HUMAN_INTERVENTION_REQUIRED' },
      });

      await recordEvent(prisma, deps, {
        projectId: input.projectId,
        type: 'HUMAN_INTERVENTION_REQUIRED',
        payload: { requestId: request.id, code: input.code, reason: input.reason },
        workflowId: input.workflowId,
      });

      return request.id;
    },

    async resolveIntervention(requestId: string, action: InterventionAction): Promise<void> {
      const request = await prisma.approvalRequest.update({
        where: { id: requestId },
        data: { status: 'APPROVED', resolvedAt: new Date() },
      });

      await recordEvent(prisma, deps, {
        projectId: request.projectId,
        type: 'HUMAN_INTERVENTION_RESOLVED',
        payload: { requestId, action },
        workflowId: request.workflowId,
      });
    },

    async seedApprovalGates(projectId: string, gates: Record<string, unknown>): Promise<void> {
      for (const [key, config] of Object.entries(gates)) {
        const gate = config as {
          enabled?: boolean;
          requiredRole?: string;
          timeoutHours?: number;
          autoApprove?: boolean;
        };
        await prisma.approvalGate.upsert({
          where: { projectId_key: { projectId, key: key as GateKey } },
          create: {
            projectId,
            key: key as GateKey,
            enabled: gate.enabled ?? true,
            requiredRole: (gate.requiredRole ?? 'ADMIN') as 'ADMIN',
            timeoutHours: gate.timeoutHours ?? 72,
            autoApprove: gate.autoApprove ?? false,
          },
          update: {},
        });
      }
    },
  };
}

export async function recordEvent(
  prisma: PrismaClient,
  deps: ActivityDeps,
  event: {
    projectId: string;
    type: string;
    payload: Record<string, unknown>;
    actor?: string;
    workflowId?: string;
    agentRunId?: string;
  },
): Promise<void> {
  // Event and outbox row land in one transaction: an event is never published for work that did
  // not commit, and never lost for work that did.
  await prisma.$transaction(async (tx) => {
    const created = await tx.domainEvent.create({
      data: {
        projectId: event.projectId,
        type: event.type,
        payload: event.payload as object,
        actor: event.actor ?? 'system',
        ...(event.workflowId ? { workflowId: event.workflowId } : {}),
        ...(event.agentRunId ? { agentRunId: event.agentRunId } : {}),
      },
    });
    await tx.outbox.create({
      data: {
        eventId: created.id,
        topic: event.type,
        payload: { ...event.payload, projectId: event.projectId, type: event.type } as object,
      },
    });
  });

  await deps.publish(event.type, { ...event.payload, projectId: event.projectId });
}
