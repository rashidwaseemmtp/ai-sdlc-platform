/**
 * Context building.
 *
 * An agent never receives another agent's prose. It receives the *project state* — rows from
 * Postgres, rendered as labelled sections — so what it sees is exactly what a person would see on
 * the dashboard, and two runs over unchanged state get an identical prompt.
 *
 * The old platform chunked and embedded documents and retrieved the top-k. This reads the rows
 * whole. For a project's worth of requirements and stories that is a few thousand tokens against a
 * million-token window, and it removes a vector database, an embedding provider, and an entire
 * class of "the agent never saw the one paragraph that mattered" bug.
 */

import { db } from './db.js';

export type ContextSection =
  | 'documents'
  | 'requirements'
  | 'stories'
  | 'architecture'
  | 'estimates'
  | 'plan'
  /** The one story this run is about, resolved from `vars.storyRef`. */
  | 'story'
  /** The committed diff for that story, plus what the reviewers said about it. */
  | 'code'
  /** Test cases, their latest results, and any open bugs for that story. */
  | 'qa';

/** Characters of a source document to include. Beyond this a transcript is quoted, not pasted. */
const DOCUMENT_LIMIT = 40_000;

export async function buildContext(
  projectId: string,
  sections: ContextSection[],
  vars: Record<string, unknown> = {},
): Promise<string> {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const blocks: string[] = [
    section(
      'project',
      [`Key: ${project.key}`, `Name: ${project.name}`, `Description: ${project.description ?? '—'}`].join('\n'),
    ),
  ];

  for (const key of sections) {
    blocks.push(await renderSection(projectId, key, vars));
  }

  return blocks.filter(Boolean).join('\n\n');
}

async function renderSection(
  projectId: string,
  key: ContextSection,
  vars: Record<string, unknown>,
): Promise<string> {
  const storyRef = typeof vars.storyRef === 'string' ? vars.storyRef : undefined;

  switch (key) {
    case 'documents': {
      const documents = await db.document.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
      if (!documents.length) return '';
      const body = documents
        .map((doc) =>
          [
            `### ${doc.title}  (documentId: ${doc.id}, kind: ${doc.kind})`,
            doc.content.length > DOCUMENT_LIMIT
              ? `${doc.content.slice(0, DOCUMENT_LIMIT)}\n…[truncated]`
              : doc.content,
          ].join('\n'),
        )
        .join('\n\n');
      return section('source-documents', body);
    }

    case 'requirements': {
      const requirements = await db.requirement.findMany({
        where: { projectId },
        orderBy: { ref: 'asc' },
      });
      if (!requirements.length) return '';
      return section(
        'requirements',
        JSON.stringify(
          requirements.map((r) => ({
            ref: r.ref,
            type: r.type,
            priority: r.priority,
            statement: r.statement,
            confidence: r.confidence,
            status: r.status,
          })),
          null,
          2,
        ),
      );
    }

    case 'stories': {
      const stories = await db.story.findMany({ where: { projectId }, orderBy: { orderIndex: 'asc' } });
      if (!stories.length) return '';
      return section(
        'backlog',
        JSON.stringify(
          stories.map((s) => ({
            ref: s.ref,
            title: s.title,
            userStory: s.userStory,
            description: s.description,
            priority: s.priority,
            sizeSignal: s.sizeSignal,
            acceptanceCriteria: s.acceptanceCriteria,
            edgeCases: s.edgeCases,
            requirementRefs: s.requirementRefs,
            dependsOn: s.dependsOn,
            qualityFlags: s.qualityFlags,
          })),
          null,
          2,
        ),
      );
    }

    case 'architecture': {
      const adr = await db.adr.findFirst({ where: { projectId }, orderBy: { number: 'desc' } });
      const option = adr?.optionId
        ? await db.architectureOption.findUnique({ where: { id: adr.optionId } })
        : await db.architectureOption.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
      if (!option) return '';
      return section(
        'chosen-architecture',
        JSON.stringify({ name: option.name, overview: option.overview, detail: option.detail }, null, 2),
      );
    }

    case 'estimates': {
      const estimates = await db.estimate.findMany({
        where: { projectId },
        include: { story: { select: { ref: true } } },
      });
      if (!estimates.length) return '';
      return section(
        'estimates',
        JSON.stringify(
          estimates.map((e) => ({
            storyRef: e.story.ref,
            estimatorKind: e.estimatorKind,
            hours: e.hours,
            confidence: e.confidence,
            riskLevel: e.riskLevel,
            range: [e.rangeLowHours, e.rangeHighHours],
          })),
          null,
          2,
        ),
      );
    }

    case 'plan': {
      const plan = await db.plan.findUnique({ where: { projectId } });
      if (!plan) return '';
      return section('plan', JSON.stringify(plan.milestones, null, 2));
    }

    case 'story': {
      if (!storyRef) return '';
      const story = await db.story.findUnique({ where: { projectId_ref: { projectId, ref: storyRef } } });
      if (!story) return '';
      return section(
        'the-story',
        JSON.stringify(
          {
            ref: story.ref,
            title: story.title,
            userStory: story.userStory,
            businessValue: story.businessValue,
            description: story.description,
            acceptanceCriteria: story.acceptanceCriteria,
            edgeCases: story.edgeCases,
            requirementRefs: story.requirementRefs,
          },
          null,
          2,
        ),
      );
    }

    case 'code': {
      if (!storyRef) return '';
      const story = await db.story.findUnique({
        where: { projectId_ref: { projectId, ref: storyRef } },
        include: { pullRequests: true },
      });
      const pr = story?.pullRequests[0];
      if (!pr) return '';

      // The diff is the artefact under review; it is quoted whole up to a ceiling rather than
      // summarised, because a reviewer working from a summary is not reviewing.
      const diff = pr.diff.length > 120_000 ? `${pr.diff.slice(0, 120_000)}\n…[diff truncated]` : pr.diff;
      return [
        section('branch', `${pr.branch} — ${pr.title}`),
        section('diff', diff),
        section('previous-reviews', JSON.stringify(pr.reviews, null, 2)),
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    case 'qa': {
      if (!storyRef) return '';
      const story = await db.story.findUnique({
        where: { projectId_ref: { projectId, ref: storyRef } },
        include: { testCases: true, bugs: true },
      });
      if (!story) return '';

      return [
        story.testCases.length
          ? section(
              'test-cases',
              JSON.stringify(
                story.testCases.map((testCase) => ({
                  ref: testCase.ref,
                  title: testCase.title,
                  type: testCase.type,
                  steps: testCase.steps,
                  expectedResult: testCase.expectedResult,
                  result: testCase.result,
                  evidence: testCase.evidence,
                })),
                null,
                2,
              ),
            )
          : '',
        story.bugs.length
          ? section(
              'open-bugs',
              JSON.stringify(
                story.bugs.map((bug) => ({
                  ref: bug.ref,
                  title: bug.title,
                  severity: bug.severity,
                  rootCause: bug.rootCause,
                  status: bug.status,
                })),
                null,
                2,
              ),
            )
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    }
  }
}

function section(name: string, body: string): string {
  if (!body.trim()) return '';
  return `<context section="${name}">\n${body}\n</context>`;
}
