/**
 * Context Engine — docs/09 §3.
 *
 * Turns "agent X is about to do task Y on project P" into a token-budgeted package.
 *
 * Two properties matter more than anything else here:
 *   - Section order is stable and most-stable-first. That is a caching decision, not cosmetics:
 *     the provider prompt cache only hits if the prefix is byte-identical across runs.
 *   - The package is hashed. With the prompt hash, that is what makes a historical run
 *     reproducible and a bad output diagnosable.
 */

import type { PrismaClient } from '@sdlc/database';
import {
  FailureCode,
  PlatformError,
  type ArtifactRef,
  type ContextPackage,
  type ContextRecipe,
  type ContextSection,
  type RenderedSection,
} from '@sdlc/shared';
import { estimateTokens, sha256, stableStringify } from '@sdlc/ai-core';
import { getLogger } from '@sdlc/observability';
import { getRecipe } from './recipes.js';
import type { EmbeddingProvider } from './embeddings.js';

const log = getLogger({ component: 'context-engine' });

export interface BuildRequest {
  recipeKey: string;
  projectId: string;
  storyId?: string;
  /** Pinned input artifact versions supplied by the workflow — these become lineage edges. */
  inputRefs?: ArtifactRef[];
  /** Free-form extras a specific phase needs (change requests, blind option payloads, diffs). */
  variables?: Record<string, unknown>;
  /** Model context window, so the engine can shrink the budget when a smaller model is chosen. */
  modelContextWindow?: number;
}

export interface SectionResolverContext extends BuildRequest {
  prisma: PrismaClient;
  section: ContextSection;
  embeddings: EmbeddingProvider;
}

export type SectionResolver = (
  ctx: SectionResolverContext,
) => Promise<{ content: string; itemCount: number } | null>;

export interface ContextEngineDeps {
  prisma: PrismaClient;
  embeddings: EmbeddingProvider;
  /** Git/filesystem-backed sections are injected so this package performs no repo I/O itself. */
  gitResolvers?: Record<string, SectionResolver>;
}

export class ContextEngine {
  private resolvers: Record<string, SectionResolver>;

  constructor(private readonly deps: ContextEngineDeps) {
    this.resolvers = { ...builtinResolvers(), ...(deps.gitResolvers ?? {}) };
  }

  registerResolver(key: string, resolver: SectionResolver): void {
    this.resolvers[key] = resolver;
  }

  async build(request: BuildRequest): Promise<ContextPackage> {
    const recipe = getRecipe(request.recipeKey);
    const budget = this.effectiveBudget(recipe, request.modelContextWindow);

    // Sections resolve in parallel; ordering is applied afterwards so it stays deterministic
    // regardless of which query finishes first.
    const resolved = await Promise.all(
      recipe.sections.map(async (section) => {
        const resolver = this.resolvers[section.key];
        if (!resolver) {
          if (section.required) {
            throw new PlatformError({
              code: FailureCode.INVALID_CONTEXT,
              message: `required context section "${section.key}" has no resolver`,
              details: { recipe: recipe.key, section: section.key },
            });
          }
          return { section, rendered: null };
        }

        try {
          const result = await resolver({
            ...request,
            prisma: this.deps.prisma,
            embeddings: this.deps.embeddings,
            section,
          });
          return { section, rendered: result };
        } catch (error) {
          if (section.required) throw error;
          log.warn(
            { section: section.key, error: (error as Error).message },
            'optional context section failed; continuing without it',
          );
          return { section, rendered: null };
        }
      }),
    );

    const sections: RenderedSection[] = [];
    for (const { section, rendered } of resolved) {
      if (!rendered || !rendered.content.trim()) {
        if (section.required) {
          throw new PlatformError({
            code: FailureCode.INVALID_CONTEXT,
            message: `required context section "${section.key}" is empty`,
            details: { recipe: recipe.key, section: section.key, projectId: request.projectId },
          });
        }
        continue;
      }

      const capped = capToTokens(rendered.content, section.maxTokens);
      sections.push({
        key: section.key,
        content: capped.text,
        tokenCount: capped.tokens,
        truncated: capped.truncated,
        summarized: false,
        itemCount: rendered.itemCount,
      });
    }

    const { kept, dropped } = this.applyBudget(recipe, sections, budget);

    // Most-stable-first: the prompt cache only hits when this prefix is byte-identical.
    const ordered = orderByRecipe(recipe, kept);
    const tokenCount = ordered.reduce((sum, section) => sum + section.tokenCount, 0);

    return {
      recipeKey: recipe.key,
      sections: ordered,
      tokenCount,
      inputRefs: request.inputRefs ?? [],
      sha256: sha256(
        stableStringify({
          recipe: recipe.key,
          sections: ordered.map((s) => ({ key: s.key, content: s.content })),
        }),
      ),
      droppedSections: dropped,
    };
  }

  /** Render a package into the message body an agent sees. */
  static render(pkg: ContextPackage): string {
    const parts: string[] = [];
    for (const section of pkg.sections) {
      parts.push(`<context section="${section.key}" items="${section.itemCount}">`);
      parts.push(section.content.trim());
      parts.push('</context>', '');
    }
    return parts.join('\n');
  }

  private effectiveBudget(recipe: ContextRecipe, modelContextWindow?: number): number {
    if (!modelContextWindow) return recipe.tokenBudget;
    // Leave room for the system prompt, tool schemas and the model's own output.
    return Math.min(recipe.tokenBudget, Math.floor(modelContextWindow * 0.6));
  }

  private applyBudget(
    recipe: ContextRecipe,
    sections: RenderedSection[],
    budget: number,
  ): { kept: RenderedSection[]; dropped: string[] } {
    const priorityOf = (key: string): number =>
      recipe.sections.find((s) => s.key === key)?.priority ?? 3;

    let total = sections.reduce((sum, s) => sum + s.tokenCount, 0);
    if (total <= budget) return { kept: sections, dropped: [] };

    const kept = [...sections];
    const dropped: string[] = [];

    for (const priority of [3, 2] as const) {
      // Largest first: dropping one 30k section beats dropping six 5k ones.
      const candidates = kept
        .filter((s) => priorityOf(s.key) === priority)
        .sort((a, b) => b.tokenCount - a.tokenCount);

      for (const candidate of candidates) {
        if (total <= budget) break;

        if (recipe.overflowStrategy === 'summarize') {
          const summarised = summariseSection(candidate);
          total -= candidate.tokenCount - summarised.tokenCount;
          kept[kept.indexOf(candidate)] = summarised;
          continue;
        }

        total -= candidate.tokenCount;
        kept.splice(kept.indexOf(candidate), 1);
        dropped.push(candidate.key);
      }
      if (total <= budget) break;
    }

    if (total > budget) {
      // Priority 1 is never dropped. Failing here is correct: an agent that silently saw half
      // its required input produces output that looks fine and is wrong.
      throw new PlatformError({
        code: FailureCode.INVALID_CONTEXT,
        message:
          `context for "${recipe.key}" is ${total} tokens against a ${budget} budget even after ` +
          'dropping every optional section. Priority-1 sections are never dropped.',
        details: {
          recipe: recipe.key,
          total,
          budget,
          priorityOne: kept.filter((s) => priorityOf(s.key) === 1).map((s) => s.key),
        },
      });
    }

    return { kept, dropped };
  }
}

function orderByRecipe(recipe: ContextRecipe, sections: RenderedSection[]): RenderedSection[] {
  const order = new Map(recipe.sections.map((section, index) => [section.key, index]));
  return [...sections].sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));
}

function capToTokens(text: string, maxTokens: number): { text: string; tokens: number; truncated: boolean } {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return { text, tokens, truncated: false };
  const maxChars = Math.floor(maxTokens * 3.4);
  const clipped = `${text.slice(0, maxChars)}\n… [truncated to fit the section budget]`;
  return { text: clipped, tokens: estimateTokens(clipped), truncated: true };
}

/** Extractive, not generative: keep the first lines of each item rather than paraphrasing. */
function summariseSection(section: RenderedSection): RenderedSection {
  const lines = section.content.split('\n');
  const kept = lines.filter((line, index) => index < 40 || line.trim().startsWith('#'));
  const content = `${kept.join('\n')}\n… [${lines.length - kept.length} lines summarised out]`;
  return {
    ...section,
    content,
    tokenCount: estimateTokens(content),
    summarized: true,
  };
}

// ── built-in SQL and vector resolvers ──────────────────────────────────────

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function builtinResolvers(): Record<string, SectionResolver> {
  return {
    'project-card': async ({ prisma, projectId }) => {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { repositories: true },
      });
      if (!project) return null;
      const lines = [
        `# Project ${project.key} — ${project.name}`,
        project.description ?? '',
        `Phase: ${project.phase}    Status: ${project.status}`,
        project.repositories.length
          ? `Repositories: ${project.repositories.map((r) => `${r.key} (${r.role})`).join(', ')}`
          : 'Repositories: none attached',
        `Settings: ${JSON.stringify(project.settings)}`,
      ];
      return { content: lines.filter(Boolean).join('\n'), itemCount: 1 };
    },

    'source-documents': async ({ prisma, projectId }) => {
      const documents = await prisma.sourceDocument.findMany({
        where: { projectId },
        orderBy: { occurredAt: 'asc' },
      });
      if (!documents.length) return null;
      const content = documents
        .map(
          (doc) =>
            `## [${doc.id}] ${doc.kind} — ${doc.title}` +
            (doc.occurredAt ? ` (${doc.occurredAt.toISOString().slice(0, 10)})` : '') +
            `\n\n${doc.content}`,
        )
        .join('\n\n---\n\n');
      return { content, itemCount: documents.length };
    },

    'existing-requirements': async ({ prisma, projectId }) => {
      const requirements = await prisma.requirement.findMany({
        where: { projectId },
        orderBy: { ref: 'asc' },
      });
      return requirements.length ? { content: json(requirements), itemCount: requirements.length } : null;
    },

    'approved-requirements': async ({ prisma, projectId }) => {
      const requirements = await prisma.requirement.findMany({
        where: { projectId, status: { in: ['APPROVED', 'REVIEW', 'DRAFT'] } },
        orderBy: { ref: 'asc' },
      });
      return requirements.length ? { content: json(requirements), itemCount: requirements.length } : null;
    },

    'non-functional-requirements': async ({ prisma, projectId }) => {
      const requirements = await prisma.requirement.findMany({
        where: { projectId, type: 'NON_FUNCTIONAL' },
        orderBy: { ref: 'asc' },
      });
      return requirements.length ? { content: json(requirements), itemCount: requirements.length } : null;
    },

    'product-vision': async ({ prisma, projectId }) => {
      const vision = await prisma.productVision.findUnique({ where: { projectId } });
      return vision ? { content: json(vision), itemCount: 1 } : null;
    },

    'business-rules': async ({ prisma, projectId }) => {
      const rules = await prisma.businessRule.findMany({ where: { projectId } });
      return rules.length ? { content: json(rules), itemCount: rules.length } : null;
    },

    constraints: async ({ prisma, projectId }) => {
      const [constraints, assumptions] = await Promise.all([
        prisma.constraint.findMany({ where: { projectId } }),
        prisma.assumption.findMany({ where: { projectId } }),
      ]);
      if (!constraints.length && !assumptions.length) return null;
      return {
        content: json({ constraints, assumptions }),
        itemCount: constraints.length + assumptions.length,
      };
    },

    'product-decisions': async ({ prisma, projectId }) => {
      const decisions = await prisma.productDecision.findMany({ where: { projectId } });
      return decisions.length ? { content: json(decisions), itemCount: decisions.length } : null;
    },

    'open-questions': async ({ prisma, projectId }) => {
      const questions = await prisma.openQuestion.findMany({
        where: { projectId, answeredAt: null },
      });
      return questions.length ? { content: json(questions), itemCount: questions.length } : null;
    },

    'existing-backlog': async ({ prisma, projectId }) => {
      const stories = await prisma.story.findMany({
        where: { projectId, status: { not: 'REJECTED' } },
        include: { acceptanceCriteria: true, qualityFlags: true },
        orderBy: { ref: 'asc' },
      });
      return stories.length ? { content: json(stories), itemCount: stories.length } : null;
    },

    'approved-backlog': async ({ prisma, projectId }) => {
      const stories = await prisma.story.findMany({
        where: { projectId, status: { in: ['APPROVED', 'PLANNED', 'IN_PROGRESS'] } },
        include: { acceptanceCriteria: true, epic: true },
        orderBy: { ref: 'asc' },
      });
      return stories.length ? { content: json(stories), itemCount: stories.length } : null;
    },

    'backlog-summary': async ({ prisma, projectId }) => {
      const stories = await prisma.story.findMany({
        where: { projectId },
        select: { ref: true, title: true, priority: true, sizeSignal: true, status: true },
        orderBy: { ref: 'asc' },
      });
      return stories.length ? { content: json(stories), itemCount: stories.length } : null;
    },

    story: async ({ prisma, storyId }) => {
      if (!storyId) return null;
      const story = await prisma.story.findUnique({
        where: { id: storyId },
        include: { epic: true, requirementLinks: { include: { requirement: true } } },
      });
      return story ? { content: json(story), itemCount: 1 } : null;
    },

    'acceptance-criteria': async ({ prisma, storyId }) => {
      if (!storyId) return null;
      const criteria = await prisma.acceptanceCriterion.findMany({
        where: { storyId },
        orderBy: { orderIndex: 'asc' },
      });
      return criteria.length ? { content: json(criteria), itemCount: criteria.length } : null;
    },

    'story-dependencies': async ({ prisma, projectId }) => {
      const dependencies = await prisma.storyDependency.findMany({
        where: { from: { projectId } },
        include: { from: { select: { ref: true } }, to: { select: { ref: true } } },
      });
      return dependencies.length
        ? { content: json(dependencies), itemCount: dependencies.length }
        : null;
    },

    tasks: async ({ prisma, storyId }) => {
      if (!storyId) return null;
      const tasks = await prisma.task.findMany({ where: { storyId }, orderBy: { orderIndex: 'asc' } });
      return tasks.length ? { content: json(tasks), itemCount: tasks.length } : null;
    },

    'approved-architecture': async ({ prisma, projectId }) => {
      const adr = await prisma.adr.findFirst({
        where: { projectId, status: 'APPROVED' },
        orderBy: { number: 'desc' },
        include: { option: true },
      });
      return adr ? { content: json(adr), itemCount: 1 } : null;
    },

    'prior-adrs': async ({ prisma, projectId }) => {
      const adrs = await prisma.adr.findMany({
        where: { projectId },
        orderBy: { number: 'asc' },
        select: {
          number: true,
          title: true,
          status: true,
          decision: true,
          rationale: true,
          consequences: true,
        },
      });
      return adrs.length ? { content: json(adrs), itemCount: adrs.length } : null;
    },

    estimates: async ({ prisma, projectId }) => {
      const estimates = await prisma.estimate.findMany({
        where: { projectId },
        include: { story: { select: { ref: true, title: true, sizeSignal: true } } },
      });
      return estimates.length ? { content: json(estimates), itemCount: estimates.length } : null;
    },

    'historical-estimates': async ({ prisma, projectId }) => {
      // Cross-project actuals feed estimate calibration (docs/56).
      const reviews = await prisma.estimateReview.findMany({
        where: { projectId: { not: projectId } },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      return reviews.length ? { content: json(reviews), itemCount: reviews.length } : null;
    },

    'resource-plan': async ({ prisma, projectId }) => {
      const plan = await prisma.resourcePlan.findFirst({
        where: { projectId },
        orderBy: { version: 'desc' },
        include: { allocations: true },
      });
      return plan ? { content: json(plan), itemCount: 1 } : null;
    },

    repositories: async ({ prisma, projectId }) => {
      const repositories = await prisma.projectRepository.findMany({ where: { projectId } });
      return repositories.length
        ? { content: json(repositories), itemCount: repositories.length }
        : null;
    },

    'design-references': async ({ prisma, storyId }) => {
      if (!storyId) return null;
      const references = await prisma.designReference.findMany({ where: { storyId } });
      if (!references.length) {
        // Explicit, not silent: the workflow decides whether the story may proceed without design.
        return { content: json({ status: 'DESIGN_CONTEXT_UNAVAILABLE' }), itemCount: 0 };
      }
      return { content: json(references), itemCount: references.length };
    },

    'security-requirements': async ({ prisma, projectId }) => {
      const requirements = await prisma.requirement.findMany({
        where: {
          projectId,
          OR: [
            { statement: { contains: 'security', mode: 'insensitive' } },
            { statement: { contains: 'auth', mode: 'insensitive' } },
            { statement: { contains: 'permission', mode: 'insensitive' } },
          ],
        },
      });
      return requirements.length ? { content: json(requirements), itemCount: requirements.length } : null;
    },

    'failing-results': async ({ prisma, storyId }) => {
      if (!storyId) return null;
      const results = await prisma.testResult.findMany({
        where: { status: { in: ['FAIL', 'ERROR'] }, testCase: { storyId } },
        include: { testCase: true, evidence: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return results.length ? { content: json(results), itemCount: results.length } : null;
    },

    'test-evidence': async ({ prisma, storyId }) => {
      if (!storyId) return null;
      const evidence = await prisma.testEvidence.findMany({
        where: { result: { testCase: { storyId } } },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      return evidence.length ? { content: json(evidence), itemCount: evidence.length } : null;
    },

    /** Reviewer feedback arrives as typed change requests, never as a re-pasted chat thread. */
    'review-feedback': async ({ variables }) => {
      const changeRequests = variables?.changeRequests;
      if (!Array.isArray(changeRequests) || changeRequests.length === 0) return null;
      return { content: json(changeRequests), itemCount: changeRequests.length };
    },

    /** Options are handed to the critic author-blind, with labels shuffled per run. */
    'architecture-options-blind': async ({ variables }) => {
      const options = variables?.blindOptions;
      if (!Array.isArray(options) || options.length === 0) return null;
      return { content: json(options), itemCount: options.length };
    },

    'meeting-excerpts': async ({ prisma, projectId, embeddings, section, variables }) => {
      const query = typeof variables?.retrievalQuery === 'string' ? variables.retrievalQuery : null;
      const topK = section.query?.topK ?? 10;

      // Without a query there is nothing to rank against; fall back to the most recent documents
      // rather than returning an arbitrary slice of vector space.
      if (!query) {
        const chunks = await prisma.documentChunk.findMany({
          where: { document: { projectId } },
          take: topK,
          orderBy: { createdAt: 'desc' },
          include: { document: { select: { title: true, kind: true } } },
        });
        return chunks.length
          ? {
              content: chunks
                .map((c) => `## ${c.document.title} [${c.document.kind}]\n${c.content}`)
                .join('\n\n'),
              itemCount: chunks.length,
            }
          : null;
      }

      const [vector] = await embeddings.embed([query]);
      if (!vector) return null;

      const rows = await prisma.$queryRawUnsafe<
        { content: string; title: string; kind: string; distance: number }[]
      >(
        `SELECT c.content, d.title, d.kind, c.embedding <=> $1::vector AS distance
           FROM document_chunks c
           JOIN source_documents d ON d.id = c."documentId"
          WHERE d."projectId" = $2 AND c.embedding IS NOT NULL
          ORDER BY distance ASC
          LIMIT $3`,
        `[${vector.join(',')}]`,
        projectId,
        topK,
      );

      return rows.length
        ? {
            content: rows.map((r) => `## ${r.title} [${r.kind}]\n${r.content}`).join('\n\n'),
            itemCount: rows.length,
          }
        : null;
    },
  };
}
