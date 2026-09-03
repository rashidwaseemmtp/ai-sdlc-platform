/**
 * Artifact persistence — docs/09 §5–6.
 *
 * Insert-only, content-addressed, lineage-writing. Three rules are enforced here rather than by
 * convention:
 *
 *   - An agent may only create artifact kinds its definition declares (`writes`). A schema-valid
 *     attempt to write something else is rejected at persistence, which is what "agents never
 *     silently mutate unrelated project state" actually means in code.
 *   - Lineage edges are written by the runtime from the workflow's `inputRefs`, never by the
 *     agent — so an agent cannot forge or omit its own provenance (invariant I10).
 *   - Approved versions are never mutated. A revision is version n+1 (invariant I3, also enforced
 *     by a database trigger).
 */

import type { PrismaClient } from '@sdlc/database';
import {
  FailureCode,
  PlatformError,
  type AgentKey,
  type ArtifactKind,
  type ArtifactRef,
  type ArtifactScope,
  type LineageRelation,
} from '@sdlc/shared';
import { sha256, stableStringify } from '@sdlc/ai-core';

export interface PersistArtifactInput {
  projectId: string;
  kind: ArtifactKind;
  scope?: ArtifactScope;
  scopeRef?: string;
  name: string;
  content: unknown;
  producedByRunId: string;
  agentKey: AgentKey;
  /** The artifact kinds this agent is permitted to write. */
  allowedKinds: ArtifactKind[];
  inputRefs: ArtifactRef[];
  lineageRelation?: LineageRelation;
  qualityWarnings?: unknown[];
}

export class ArtifactStore {
  constructor(private readonly prisma: PrismaClient) {}

  async persist(input: PersistArtifactInput): Promise<ArtifactRef> {
    if (!input.allowedKinds.includes(input.kind)) {
      throw new PlatformError({
        code: FailureCode.PERMISSION_DENIED,
        message:
          `agent "${input.agentKey}" is not permitted to write artifacts of kind ${input.kind}. ` +
          `Declared writes: ${input.allowedKinds.join(', ') || 'none'}.`,
        details: { agentKey: input.agentKey, kind: input.kind, allowed: input.allowedKinds },
      });
    }

    const contentSha256 = sha256(stableStringify(input.content));
    const scope = input.scope ?? 'PROJECT';

    return this.prisma.$transaction(async (tx) => {
      const artifact = await tx.artifact.upsert({
        where: {
          projectId_kind_scope_scopeRef: {
            projectId: input.projectId,
            kind: input.kind,
            scope,
            scopeRef: input.scopeRef ?? '',
          },
        },
        create: {
          projectId: input.projectId,
          kind: input.kind,
          scope,
          scopeRef: input.scopeRef ?? '',
          name: input.name,
        },
        update: {},
      });

      // Content-addressing deduplicates identical regenerations: a re-run that produces the same
      // bytes returns the existing version rather than inflating the history.
      const identical = await tx.artifactVersion.findUnique({
        where: { artifactId_contentSha256: { artifactId: artifact.id, contentSha256 } },
      });
      if (identical) {
        return {
          artifactId: artifact.id,
          versionId: identical.id,
          version: identical.version,
          kind: input.kind,
          sha256: contentSha256,
        };
      }

      const previous = await tx.artifactVersion.findFirst({
        where: { artifactId: artifact.id },
        orderBy: { version: 'desc' },
      });
      const nextVersion = (previous?.version ?? 0) + 1;

      const version = await tx.artifactVersion.create({
        data: {
          artifactId: artifact.id,
          version: nextVersion,
          contentJson: input.content as object,
          contentSha256,
          status: 'DRAFT',
          producedByRunId: input.producedByRunId,
          qualityWarnings: (input.qualityWarnings ?? []) as object,
        },
      });

      await tx.artifact.update({
        where: { id: artifact.id },
        data: { currentVersionId: version.id },
      });

      // Provenance, written by the platform rather than claimed by the agent.
      const edges = input.inputRefs.map((ref) => ({
        childVersionId: version.id,
        parentVersionId: ref.versionId,
        relation: input.lineageRelation ?? ('DERIVED_FROM' as LineageRelation),
      }));
      if (previous) {
        edges.push({
          childVersionId: version.id,
          parentVersionId: previous.id,
          relation: 'REVISION_OF' as LineageRelation,
        });
      }
      if (edges.length) {
        await tx.artifactLineage.createMany({ data: edges, skipDuplicates: true });
      }

      return {
        artifactId: artifact.id,
        versionId: version.id,
        version: nextVersion,
        kind: input.kind,
        sha256: contentSha256,
      };
    });
  }

  async read<T = unknown>(ref: ArtifactRef): Promise<T> {
    const version = await this.prisma.artifactVersion.findUnique({ where: { id: ref.versionId } });
    if (!version) {
      throw new PlatformError({
        code: FailureCode.NOT_FOUND,
        message: `artifact version ${ref.versionId} not found`,
        details: { ref },
      });
    }
    return version.contentJson as T;
  }

  async latest<T = unknown>(
    projectId: string,
    kind: ArtifactKind,
    scopeRef?: string,
  ): Promise<{ ref: ArtifactRef; content: T } | null> {
    const artifact = await this.prisma.artifact.findFirst({
      where: { projectId, kind, ...(scopeRef ? { scopeRef } : {}) },
      include: { currentVersion: true },
    });
    if (!artifact?.currentVersion) return null;

    return {
      ref: {
        artifactId: artifact.id,
        versionId: artifact.currentVersion.id,
        version: artifact.currentVersion.version,
        kind,
        sha256: artifact.currentVersion.contentSha256,
      },
      content: artifact.currentVersion.contentJson as T,
    };
  }

  /** Approving pins the version. From here it is immutable; the DB trigger is the backstop. */
  async approve(ref: ArtifactRef, userId: string): Promise<void> {
    await this.prisma.artifactVersion.update({
      where: { id: ref.versionId },
      data: { status: 'APPROVED', approvedByUserId: userId, approvedAt: new Date() },
    });
  }

  async supersede(ref: ArtifactRef): Promise<void> {
    await this.prisma.artifactVersion.update({
      where: { id: ref.versionId },
      data: { status: 'SUPERSEDED' },
    });
  }

  /** Walk lineage upward — the query behind the project trace view. */
  async lineage(versionId: string, depth = 10): Promise<{ from: string; to: string; relation: string }[]> {
    const edges: { from: string; to: string; relation: string }[] = [];
    let frontier = [versionId];
    const seen = new Set<string>();

    for (let level = 0; level < depth && frontier.length; level += 1) {
      const rows = await this.prisma.artifactLineage.findMany({
        where: { childVersionId: { in: frontier } },
      });
      frontier = [];
      for (const row of rows) {
        const key = `${row.childVersionId}->${row.parentVersionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: row.childVersionId, to: row.parentVersionId, relation: row.relation });
        frontier.push(row.parentVersionId);
      }
    }
    return edges;
  }
}
