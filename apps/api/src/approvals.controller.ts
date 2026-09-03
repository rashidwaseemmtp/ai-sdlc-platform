/**
 * The human-in-the-loop surface — docs/08, docs/10.
 *
 * The decision path is: authorize → write the decision → update the request → signal the workflow.
 * The first three are one transaction; the signal comes after commit. If the process dies between
 * them the decision is still durable and the workflow's reconcile path recovers it, which is why
 * the signal is the fast path and the database is the truth.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Inject,
} from '@nestjs/common';
import { z } from 'zod';
import { getLogger } from '@sdlc/observability';
import { PrismaService, TemporalService } from './core.js';

const log = getLogger({ component: 'approvals' });

const Decide = z.object({
  userId: z.string(),
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  comment: z.string().optional(),
  changeRequests: z
    .array(
      z.object({
        target: z.object({ kind: z.string(), ref: z.string() }),
        instruction: z.string(),
        severity: z.enum(['MUST', 'SHOULD', 'CONSIDER']),
      }),
    )
    .default([]),
});

const Resolve = z.object({
  userId: z.string(),
  action: z.enum(['RETRY', 'RETRY_WITH_CHANGES', 'SKIP_STORY', 'ABORT_PHASE', 'RAISE_BUDGET']),
  comment: z.string().optional(),
  raisedBudgetUsd: z.number().positive().optional(),
});

@Controller('api/v1')
export class ApprovalsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TemporalService) private readonly temporal: TemporalService,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  /** The approvals inbox. */
  @Get('approvals')
  async list(@Query('status') status = 'PENDING', @Query('projectId') projectId?: string) {
    const requests = await this.db.approvalRequest.findMany({
      where: {
        ...(status === 'ALL' ? {} : { status: status as 'PENDING' }),
        ...(projectId ? { projectId } : {}),
      },
      include: {
        project: { select: { key: true, name: true } },
        decision: { include: { user: { select: { name: true, email: true } } } },
      },
      orderBy: { requestedAt: 'asc' },
    });

    return {
      data: requests.map((request) => ({
        id: request.id,
        gate: request.gateKey,
        status: request.status,
        title: request.title,
        summary: request.summary,
        requiredRole: request.requiredRole,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt,
        project: request.project,
        isIntervention: (request.context as { intervention?: boolean })?.intervention === true,
        decision: request.decision,
      })),
    };
  }

  /**
   * Everything an approver needs, and nothing they should not see: the artifact, the agent's
   * auditable decision summary, quality warnings, provenance and lineage — never raw reasoning
   * (invariant I9).
   */
  @Get('approvals/:id')
  async detail(@Param('id') id: string) {
    const request = await this.db.approvalRequest.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, key: true, name: true } },
        artifactVersion: { include: { artifact: true } },
        decision: true,
      },
    });
    if (!request) throw new NotFoundException(`approval ${id} not found`);

    const run = request.artifactVersion?.producedByRunId
      ? await this.db.agentRun.findUnique({
          where: { id: request.artifactVersion.producedByRunId },
          include: {
            promptVersion: { select: { version: true, sha256: true } },
            llmCalls: { select: { modelId: true, providerKey: true, costUsd: true, billingMode: true } },
          },
        })
      : null;

    // The previous approved version, so the UI can show what actually changed.
    const previous = request.artifactVersion
      ? await this.db.artifactVersion.findFirst({
          where: {
            artifactId: request.artifactVersion.artifactId,
            version: { lt: request.artifactVersion.version },
          },
          orderBy: { version: 'desc' },
        })
      : null;

    const lineage = request.artifactVersion
      ? await this.db.artifactLineage.findMany({
          where: { childVersionId: request.artifactVersion.id },
          include: { parent: { include: { artifact: { select: { kind: true, name: true } } } } },
        })
      : [];

    return {
      data: {
        requestId: request.id,
        gate: request.gateKey,
        status: request.status,
        requiredRole: request.requiredRole,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt,
        project: request.project,
        title: request.title,
        summary: request.summary,
        context: request.context,
        isIntervention: (request.context as { intervention?: boolean })?.intervention === true,
        artifact: request.artifactVersion
          ? {
              kind: request.artifactVersion.artifact.kind,
              version: request.artifactVersion.version,
              content: request.artifactVersion.contentJson,
              sha256: request.artifactVersion.contentSha256,
            }
          : null,
        previousVersion: previous ? { version: previous.version, content: previous.contentJson } : null,
        decisionSummary: run?.decisionSummary ?? null,
        qualityWarnings: request.artifactVersion?.qualityWarnings ?? [],
        provenance: run
          ? {
              agentKey: run.agentKey,
              agentVersion: run.agentVersion,
              promptVersion: run.promptVersion?.version,
              promptSha: run.promptVersion?.sha256,
              modelId: run.llmCalls[0]?.modelId,
              providerKey: run.llmCalls[0]?.providerKey,
              billingMode: run.llmCalls[0]?.billingMode,
              costUsd: run.totalCostUsd,
              tokens: run.totalTokens,
              durationMs: run.durationMs,
            }
          : null,
        lineage: lineage.map((edge) => ({
          relation: edge.relation,
          kind: edge.parent.artifact.kind,
          name: edge.parent.artifact.name,
          version: edge.parent.version,
        })),
        actions: request.status === 'PENDING' ? ['APPROVE', 'REJECT', 'REQUEST_CHANGES', 'COMMENT'] : [],
      },
    };
  }

  @Post('approvals/:id/decide')
  async decide(@Param('id') id: string, @Body() body: unknown) {
    const input = Decide.safeParse(body);
    if (!input.success) throw new BadRequestException(input.error.issues);

    const request = await this.db.approvalRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException(`approval ${id} not found`);
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`approval ${id} is already ${request.status}`);
    }

    const user = await this.db.user.findUnique({ where: { id: input.data.userId } });
    if (!user) throw new NotFoundException('user not found');

    // Role check. Humans outrank agents, and only the gate's required role may decide it.
    if (user.role !== 'ADMIN' && user.role !== request.requiredRole) {
      throw new ForbiddenException(
        `gate ${request.gateKey} requires role ${request.requiredRole}; ${user.email} is ${user.role}`,
      );
    }

    // One transaction: the decision and the status move together or not at all.
    await this.db.$transaction([
      this.db.approvalDecision.create({
        data: {
          requestId: id,
          userId: user.id,
          decision: input.data.decision,
          ...(input.data.comment ? { comment: input.data.comment } : {}),
          changeRequests: input.data.changeRequests as object,
        },
      }),
      this.db.approvalRequest.update({
        where: { id },
        data: { status: input.data.decision, resolvedAt: new Date() },
      }),
    ]);

    // Signal after commit. If this throws, the decision is still durable and the workflow's
    // reconcile path picks it up when its timeout fires.
    let signalled = false;
    try {
      await this.temporal.client.workflow.getHandle(request.workflowId).signal('approval', {
        gate: request.gateKey,
        requestId: id,
        decision: input.data.decision,
        userId: user.id,
        ...(input.data.comment ? { comment: input.data.comment } : {}),
        changeRequests: input.data.changeRequests,
        decidedAt: new Date().toISOString(),
      });
      signalled = true;
    } catch (error) {
      log.error(
        { requestId: id, workflowId: request.workflowId, error: (error as Error).message },
        'decision committed but signal failed; the workflow will reconcile from the database',
      );
    }

    return { data: { workflowId: request.workflowId, signalled } };
  }

  /** Parked workflows waiting on a human. */
  @Get('projects/:projectId/interventions')
  async interventions(@Param('projectId') projectId: string) {
    const requests = await this.db.approvalRequest.findMany({
      where: { projectId, status: 'PENDING', signalName: 'intervention' },
      orderBy: { requestedAt: 'asc' },
    });
    return { data: requests };
  }

  @Post('interventions/:id/resolve')
  async resolveIntervention(@Param('id') id: string, @Body() body: unknown) {
    const input = Resolve.safeParse(body);
    if (!input.success) throw new BadRequestException(input.error.issues);

    const request = await this.db.approvalRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException(`intervention ${id} not found`);

    await this.db.approvalRequest.update({
      where: { id },
      data: { status: 'APPROVED', resolvedAt: new Date() },
    });

    await this.temporal.client.workflow.getHandle(request.workflowId).signal('intervention', {
      requestId: id,
      action: input.data.action,
      userId: input.data.userId,
      ...(input.data.comment ? { comment: input.data.comment } : {}),
      ...(input.data.raisedBudgetUsd ? { raisedBudgetUsd: input.data.raisedBudgetUsd } : {}),
    });

    return { data: { action: input.data.action } };
  }

  @Get('projects/:projectId/approval-gates')
  async gates(@Param('projectId') projectId: string) {
    return { data: await this.db.approvalGate.findMany({ where: { projectId }, orderBy: { key: 'asc' } }) };
  }
}
