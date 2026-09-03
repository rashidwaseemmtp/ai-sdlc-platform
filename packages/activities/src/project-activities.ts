/**
 * Project, discovery and planning activities — the database side effects a workflow orchestrates.
 *
 * These are deliberately small and idempotent: a Temporal retry must not double-write, so every
 * one of them is either an upsert, a create with a natural key, or a computation over existing
 * rows.
 */

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@sdlc/database';
import {
  FailureCode,
  PlatformError,
  type ArtifactRef,
  type ProjectPhase,
} from '@sdlc/shared';
import { chunkDocument } from '@sdlc/context';
import {
  blindOptions,
  computeVariance,
  computeWaves,
  recommend,
  summariseEstimates,
  type DagNode,
  type EstimateInput,
  type OptionScores,
} from '@sdlc/domain';
import { getLogger } from '@sdlc/observability';
import type { ActivityDeps } from './context.js';
import { recordEvent } from './approval-activities.js';

const log = getLogger({ component: 'project-activity' });

export function projectActivities(deps: ActivityDeps) {
  const prisma: PrismaClient = deps.prisma;

  return {
    async setProjectPhase(projectId: string, phase: ProjectPhase): Promise<void> {
      await prisma.project.update({ where: { id: projectId }, data: { phase } });
      await recordEvent(prisma, deps, {
        projectId,
        type: 'PROJECT_PHASE_CHANGED',
        payload: { phase },
      });
    },

    async getProjectKey(projectId: string): Promise<string> {
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        throw new PlatformError({
          code: FailureCode.NOT_FOUND,
          message: `project ${projectId} not found`,
        });
      }
      return project.key;
    },

    async recordWorkflowRun(input: {
      projectId: string;
      workflowId: string;
      runId: string;
      type: string;
      taskQueue: string;
      storyId?: string;
      parentWorkflowId?: string;
    }): Promise<void> {
      await prisma.workflowRun.upsert({
        where: { workflowId_runId: { workflowId: input.workflowId, runId: input.runId } },
        create: {
          projectId: input.projectId,
          workflowId: input.workflowId,
          runId: input.runId,
          type: input.type,
          taskQueue: input.taskQueue,
          ...(input.storyId ? { storyId: input.storyId } : {}),
          ...(input.parentWorkflowId ? { parentWorkflowId: input.parentWorkflowId } : {}),
        },
        update: {},
      });
    },

    async closeWorkflowRun(workflowId: string, runId: string, status: 'COMPLETED' | 'FAILED' | 'PARKED'): Promise<void> {
      await prisma.workflowRun.updateMany({
        where: { workflowId, runId },
        data: { status, closedAt: new Date() },
      });
    },

    // ── discovery ────────────────────────────────────────────────────────

    async listUningestedDocuments(projectId: string): Promise<string[]> {
      const documents = await prisma.sourceDocument.findMany({
        where: { projectId, ingestedAt: null },
        select: { id: true },
      });
      return documents.map((d) => d.id);
    },

    /** Chunk and embed one document. Idempotent: re-ingesting replaces the chunks. */
    async ingestDocument(documentId: string): Promise<{ chunks: number }> {
      const document = await prisma.sourceDocument.findUnique({ where: { id: documentId } });
      if (!document) {
        throw new PlatformError({ code: FailureCode.NOT_FOUND, message: `document ${documentId} not found` });
      }

      const chunks = chunkDocument(document.content);
      await prisma.documentChunk.deleteMany({ where: { documentId } });

      // Embeddings go in through raw SQL: Prisma cannot yet write the pgvector type directly.
      const embeddings = await deps.embeddings.embed(chunks.map((c) => c.content));

      for (const [index, chunk] of chunks.entries()) {
        const vector = embeddings[index];
        const created = await prisma.documentChunk.create({
          data: {
            documentId,
            ordinal: index,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
            embeddingModel: deps.embeddings.model,
          },
        });
        if (vector) {
          await prisma.$executeRawUnsafe(
            'UPDATE document_chunks SET embedding = $1::vector WHERE id = $2',
            `[${vector.join(',')}]`,
            created.id,
          );
        }
      }

      await prisma.sourceDocument.update({
        where: { id: documentId },
        data: { ingestedAt: new Date() },
      });

      await recordEvent(prisma, deps, {
        projectId: document.projectId,
        type: 'DOCUMENT_INGESTED',
        payload: { documentId, chunks: chunks.length },
      });

      return { chunks: chunks.length };
    },

    // ── backlog ──────────────────────────────────────────────────────────

    async getBacklogSummary(projectId: string): Promise<{
      total: number;
      approved: number;
      rejected: number;
      pending: number;
      blockingFlags: number;
    }> {
      const stories = await prisma.story.findMany({
        where: { projectId },
        select: { status: true, qualityFlags: { where: { resolved: false }, select: { severity: true } } },
      });

      return {
        total: stories.length,
        approved: stories.filter((s) => s.status === 'APPROVED').length,
        rejected: stories.filter((s) => s.status === 'REJECTED').length,
        pending: stories.filter((s) => s.status === 'REVIEW' || s.status === 'CHANGES_REQUESTED').length,
        blockingFlags: stories.reduce(
          (sum, s) => sum + s.qualityFlags.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length,
          0,
        ),
      };
    },

    async approveBacklog(projectId: string, userId: string): Promise<number> {
      const result = await prisma.story.updateMany({
        where: { projectId, status: { in: ['REVIEW', 'CHANGES_REQUESTED'] } },
        data: { status: 'APPROVED' },
      });
      await prisma.requirement.updateMany({
        where: { projectId, status: 'REVIEW' },
        data: { status: 'APPROVED' },
      });
      await recordEvent(prisma, deps, {
        projectId,
        type: 'BACKLOG_APPROVED',
        payload: { stories: result.count },
        actor: `user:${userId}`,
      });
      return result.count;
    },

    // ── architecture ─────────────────────────────────────────────────────

    /** Strip authorship and shuffle labels before the critic sees the options (docs/04 §4). */
    async prepareBlindOptions(
      projectId: string,
      round: number,
      seed: string,
    ): Promise<{ blind: unknown[]; mapping: Record<string, string>; labels: string[] }> {
      const options = await prisma.architectureOption.findMany({
        where: { projectId, round },
        orderBy: { variant: 'asc' },
      });
      if (options.length < 2) {
        throw new PlatformError({
          code: FailureCode.VALIDATION_ERROR,
          message: `expected at least 2 architecture options, found ${options.length}`,
        });
      }

      const payload = options.map((option) => ({
        optionId: option.id,
        variant: option.variant,
        name: option.name,
        overview: option.overview,
        components: option.components,
        dataFlow: option.dataFlow,
        apiStrategy: option.apiStrategy,
        databaseStrategy: option.databaseStrategy,
        cachingStrategy: option.cachingStrategy,
        security: option.security,
        scalability: option.scalability,
        observability: option.observability,
        deployment: option.deployment,
        costConsiderations: option.costConsiderations,
        developmentComplexity: option.developmentComplexity,
        operationalComplexity: option.operationalComplexity,
        advantages: option.advantages,
        disadvantages: option.disadvantages,
        risks: option.risks,
      }));

      const { blind, mapping } = blindOptions(payload, seed);
      return { blind, mapping, labels: Object.keys(mapping) };
    },

    /**
     * Persist the critic's scores and compute the recommendation. The arithmetic is done here, in
     * pure domain code, rather than trusted to a model.
     */
    async computeRecommendation(input: {
      projectId: string;
      agentRunId: string;
      mapping: Record<string, string>;
      evaluations: {
        label: string;
        scores: { criterion: string; score: number; reasoning: string }[];
      }[];
    }): Promise<{ recommendedOptionId: string; ranked: unknown[]; closeCall: boolean; needsRegeneration: boolean }> {
      const scored: OptionScores[] = [];

      for (const evaluation of input.evaluations) {
        const optionId = input.mapping[evaluation.label];
        if (!optionId) continue;
        const option = await prisma.architectureOption.findUnique({ where: { id: optionId } });
        if (!option) continue;

        for (const score of evaluation.scores) {
          await prisma.architectureEvaluation.upsert({
            where: {
              optionId_criterion: {
                optionId,
                criterion: score.criterion as 'SECURITY',
              },
            },
            create: {
              optionId,
              criterion: score.criterion as 'SECURITY',
              score: score.score,
              reasoning: score.reasoning,
              agentRunId: input.agentRunId,
            },
            update: { score: score.score, reasoning: score.reasoning, agentRunId: input.agentRunId },
          });
        }

        scored.push({
          optionId,
          variant: option.variant,
          name: option.name,
          scores: evaluation.scores.map((s) => ({
            criterion: s.criterion as 'SECURITY',
            score: s.score,
            reasoning: s.reasoning,
          })),
        });
      }

      const recommendation = recommend(scored);
      const needsRegeneration = recommendation.ranked.every((option) => option.weightedScore < 5);

      await prisma.architectureRecommendation.create({
        data: {
          projectId: input.projectId,
          recommendedOptionId: recommendation.recommendedOptionId,
          reasoning: recommendation.reasoning,
          tradeoffs: [] as object,
          risks: [] as object,
          switchConditions: [] as object,
          scores: recommendation.ranked as object,
          agentRunId: input.agentRunId,
        },
      });

      await recordEvent(prisma, deps, {
        projectId: input.projectId,
        type: 'ARCHITECTURE_EVALUATED',
        payload: {
          recommendedOptionId: recommendation.recommendedOptionId,
          closeCall: recommendation.closeCall,
        },
      });

      return {
        recommendedOptionId: recommendation.recommendedOptionId,
        ranked: recommendation.ranked,
        closeCall: recommendation.closeCall,
        needsRegeneration,
      };
    },

    /** Create the ADR. Immutable from the moment it is approved (invariant I3). */
    async createAdr(input: {
      projectId: string;
      optionId: string;
      approvedByUserId: string;
      title?: string;
    }): Promise<{ adrId: string; number: number }> {
      const option = await prisma.architectureOption.findUniqueOrThrow({ where: { id: input.optionId } });
      const others = await prisma.architectureOption.findMany({
        where: { projectId: input.projectId, id: { not: input.optionId } },
        select: { variant: true, name: true, overview: true },
      });
      const last = await prisma.adr.findFirst({
        where: { projectId: input.projectId },
        orderBy: { number: 'desc' },
      });
      const number = (last?.number ?? 0) + 1;

      const adr = await prisma.adr.create({
        data: {
          projectId: input.projectId,
          number,
          title: input.title ?? `Adopt ${option.name}`,
          status: 'APPROVED',
          context: option.overview,
          problem: 'Select an architecture that satisfies the approved backlog and its non-functional requirements.',
          optionsConsidered: others as object,
          decision: `Adopt option ${option.variant}: ${option.name}.`,
          rationale: 'Selected by an independent critic scorecard and approved by a human architect.',
          consequences: option.disadvantages as object,
          risks: option.risks as object,
          alternativesRejected: others.map((o) => `${o.variant}: ${o.name}`) as object,
          optionId: option.id,
          approvedByUserId: input.approvedByUserId,
          approvedAt: new Date(),
        },
      });

      await recordEvent(prisma, deps, {
        projectId: input.projectId,
        type: 'ADR_CREATED',
        payload: { adrId: adr.id, number, optionId: option.id },
        actor: `user:${input.approvedByUserId}`,
      });

      return { adrId: adr.id, number };
    },

    // ── estimation ───────────────────────────────────────────────────────

    /**
     * Variance between the two independent estimators. A disagreement over the threshold sets
     * ESTIMATION_REVIEW_REQUIRED, which forces a human to reconcile rather than averaging.
     */
    async computeEstimationVariance(projectId: string): Promise<{
      reviewRequired: string[];
      summary: unknown;
    }> {
      const estimates = await prisma.estimate.findMany({
        where: { projectId },
        include: { story: { select: { ref: true } } },
      });

      const byStory = new Map<string, { primary?: EstimateInput; independent?: EstimateInput }>();
      for (const estimate of estimates) {
        const entry = byStory.get(estimate.storyId) ?? {};
        const value: EstimateInput = {
          storyRef: estimate.story.ref,
          estimatorKind: estimate.estimatorKind,
          hoursEngineering: estimate.hoursEngineering,
          confidence: estimate.confidence,
          riskLevel: estimate.riskLevel,
          rangeLowHours: estimate.rangeLowHours,
          rangeHighHours: estimate.rangeHighHours,
        };
        if (estimate.estimatorKind === 'PRIMARY') entry.primary = value;
        if (estimate.estimatorKind === 'INDEPENDENT') entry.independent = value;
        byStory.set(estimate.storyId, entry);
      }

      const reviewRequired: string[] = [];
      const variances = [];

      for (const [storyId, pair] of byStory) {
        if (!pair.primary || !pair.independent) continue;
        const variance = computeVariance(
          pair.primary,
          pair.independent,
          deps.limits.estimationVarianceThreshold,
        );
        variances.push(variance);

        await prisma.estimateReview.upsert({
          where: { storyId },
          create: {
            projectId,
            storyId,
            primaryHours: variance.primaryHours,
            independentHours: variance.independentHours,
            variancePct: variance.variancePct,
            status: variance.status,
            notes: variance.rationale,
          },
          update: {
            primaryHours: variance.primaryHours,
            independentHours: variance.independentHours,
            variancePct: variance.variancePct,
            status: variance.status,
            notes: variance.rationale,
          },
        });

        if (variance.status === 'ESTIMATION_REVIEW_REQUIRED') reviewRequired.push(variance.storyRef);
      }

      const summary = summariseEstimates(
        [...byStory.values()].flatMap((pair) => (pair.primary ? [pair.primary] : [])),
        variances,
      );

      if (reviewRequired.length) {
        await recordEvent(prisma, deps, {
          projectId,
          type: 'ESTIMATION_VARIANCE_FLAGGED',
          payload: { stories: reviewRequired },
        });
      }

      return { reviewRequired, summary };
    },

    // ── delivery planning ────────────────────────────────────────────────

    /**
     * Dependency waves for the development fan-out. Pure computation in an activity so the
     * workflow stays deterministic while the query does not.
     */
    async computeDeliveryWaves(projectId: string): Promise<{
      waves: { index: number; refs: string[] }[];
      cycles: string[][];
      criticalPath: { refs: string[]; hours: number };
      storyIdByRef: Record<string, string>;
    }> {
      const stories = await prisma.story.findMany({
        where: { projectId, status: { in: ['APPROVED', 'PLANNED', 'IN_PROGRESS'] } },
        include: {
          dependenciesFrom: { include: { to: { select: { ref: true } } } },
          estimates: { where: { estimatorKind: 'PRIMARY' }, select: { hoursEngineering: true } },
        },
      });

      const nodes: DagNode[] = stories.map((story) => ({
        ref: story.ref,
        dependsOn: story.dependenciesFrom.filter((d) => d.kind === 'BLOCKS').map((d) => d.to.ref),
        estimateHours: story.estimates[0]?.hoursEngineering ?? 0,
        priority: story.priority,
      }));

      const result = computeWaves(nodes);
      if (result.cycles.length) {
        log.warn({ projectId, cycles: result.cycles }, 'cyclic story dependencies detected');
      }

      return {
        waves: result.waves,
        cycles: result.cycles,
        criticalPath: result.criticalPath,
        storyIdByRef: Object.fromEntries(stories.map((s) => [s.ref, s.id])),
      };
    },

    async setStoryStatus(storyId: string, status: string): Promise<void> {
      await prisma.story.update({
        where: { id: storyId },
        data: { status: status as 'DONE' },
      });
    },

    /**
     * Read the critic's evaluations back out of its artifact. The workflow needs the scores to
     * compute the recommendation, but must not carry the document body through its history —
     * so it passes the ref and gets back only what it needs (invariant I4).
     */
    async readEvaluations(ref: ArtifactRef): Promise<
      { label: string; scores: { criterion: string; score: number; reasoning: string }[] }[]
    > {
      const content = await deps.artifacts.read<{
        evaluations?: {
          label: string;
          scores: { criterion: string; score: number; reasoning: string }[];
        }[];
      }>(ref);
      return content.evaluations ?? [];
    },

    /**
     * Read the developer's structured change set out of its artifact. The workflow orchestrates
     * apply/commit/PR as separate steps, so it needs the change list — but as a value it fetches,
     * never as something carried through workflow history.
     */
    async readDeveloperChanges(ref: ArtifactRef): Promise<{
      changes: { path: string; action: 'CREATE' | 'MODIFY' | 'DELETE'; content?: string }[];
      branchName?: string;
      commitMessage?: string;
      pullRequest?: {
        title: string;
        summary: string;
        implementationDetails: string;
        acceptanceCriteriaCoverage: { criterionRef: string; satisfiedBy: string; satisfied: boolean }[];
        testsAdded: string[];
        knownLimitations: string[];
        securityConsiderations: string[];
      };
    }> {
      const content = await deps.artifacts.read<{
        changes?: { path: string; action: 'CREATE' | 'MODIFY' | 'DELETE'; content?: string }[];
        tests?: { path: string; content?: string }[];
        branchName?: string;
        commitMessage?: string;
        pullRequest?: {
          title: string;
          summary: string;
          implementationDetails: string;
          acceptanceCriteriaCoverage: { criterionRef: string; satisfiedBy: string; satisfied: boolean }[];
          testsAdded: string[];
          knownLimitations: string[];
          securityConsiderations: string[];
        };
      }>(ref);

      // Test files are changes too; keeping them in one list means one apply step and one commit.
      const testChanges = (content.tests ?? []).map((test) => ({
        path: test.path,
        action: 'CREATE' as const,
        ...(test.content ? { content: test.content } : {}),
      }));

      return {
        changes: [...(content.changes ?? []), ...testChanges],
        ...(content.branchName ? { branchName: content.branchName } : {}),
        ...(content.commitMessage ? { commitMessage: content.commitMessage } : {}),
        ...(content.pullRequest ? { pullRequest: content.pullRequest } : {}),
      };
    },

    /** Merge the code and security reviews into one verdict for the PR gate. */
    async readReviewFindings(refs: ArtifactRef[]): Promise<{
      verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT' | 'COMMENT';
      summary: string;
      findings: { path: string; line?: number; severity: string; category: string; body: string }[];
    }> {
      const reviews = [];
      for (const ref of refs) {
        reviews.push(
          await deps.artifacts.read<{
            verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT' | 'COMMENT';
            summary?: string;
            findings?: { path: string; line?: number; severity: string; category: string; body: string }[];
          }>(ref),
        );
      }

      const findings = reviews.flatMap((review) => review.findings ?? []);
      // The strictest verdict wins: a security rejection is not softened by a code approval.
      const verdict = reviews.some((r) => r.verdict === 'REJECT')
        ? 'REJECT'
        : reviews.some((r) => r.verdict === 'REQUEST_CHANGES')
          ? 'REQUEST_CHANGES'
          : 'APPROVE';

      return {
        verdict,
        summary: reviews.map((r) => r.summary ?? '').filter(Boolean).join(' '),
        findings,
      };
    },

    async getLatestArtifactRef(
      projectId: string,
      kind: string,
      scopeRef?: string,
    ): Promise<ArtifactRef | null> {
      const found = await deps.artifacts.latest(projectId, kind as 'BACKLOG', scopeRef);
      return found?.ref ?? null;
    },

    async emitEvent(input: {
      projectId: string;
      type: string;
      payload: Record<string, unknown>;
      workflowId?: string;
    }): Promise<void> {
      await recordEvent(prisma, deps, input);
    },

    /** Deterministic seed for the blind-label shuffle, derived from stable inputs only. */
    async blindingSeed(projectId: string, round: number): Promise<string> {
      return createHash('sha256').update(`${projectId}:${round}`).digest('hex').slice(0, 16);
    },
  };
}
