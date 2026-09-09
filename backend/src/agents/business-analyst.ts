/**
 * Business Analyst — turns approved requirements into a development-ready backlog.
 *
 * The interesting part is the last check: the agent reports its own doubts as `qualityFlags`, and
 * the platform re-derives them independently in `domain.ts`. A gate that only believes the model's
 * self-report is not a gate, so anything the scan finds and the agent missed is stored on the story
 * and shown to the approver.
 */

import { z } from 'zod';
import { db } from '../db.js';
import { analyseBacklog, type StoryLike } from '../domain.js';
import { DecisionSummary, Priority, Severity, defineAgent, fail, pass, renderChangeRequests } from './types.js';

const AcceptanceCriterion = z.object({
  kind: z.enum(['GWT', 'CHECKLIST']).default('GWT'),
  given: z.string().optional(),
  when: z.string().optional(),
  then: z.string().optional(),
  statement: z.string().optional(),
});

const QualityFlag = z.object({
  kind: z.enum([
    'DUPLICATE',
    'AMBIGUOUS',
    'TOO_LARGE',
    'MISSING_AC',
    'TECHNICAL_AS_BUSINESS',
    'MISSING_EDGE_CASES',
    'CONFLICTING',
    'UNTESTABLE',
  ]),
  detail: z.string(),
  severity: Severity,
});

const Story = z.object({
  ref: z.string().regex(/^US-\d+$/),
  title: z.string().min(3),
  userStory: z.string(),
  businessValue: z.string(),
  description: z.string(),
  priority: Priority,
  sizeSignal: z.enum(['XS', 'S', 'M', 'L', 'XL']),
  labels: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  edgeCases: z.array(z.string()).min(1),
  /// Refs of stories that must ship first. The delivery planner reads these as a DAG.
  dependsOn: z.array(z.string()).default([]),
  requirementRefs: z.array(z.string()).min(1),
  qualityFlags: z.array(QualityFlag).default([]),
});

const Output = z.object({
  stories: z.array(Story).min(1),
  openQuestions: z
    .array(z.object({ question: z.string(), blocksRefs: z.array(z.string()).default([]), severity: Severity }))
    .default([]),
  decisionSummary: DecisionSummary,
});

export type BusinessAnalystOutput = z.infer<typeof Output>;

function toStoryLike(story: z.infer<typeof Story>): StoryLike {
  return {
    ref: story.ref,
    title: story.title,
    userStory: story.userStory,
    description: story.description,
    sizeSignal: story.sizeSignal,
    acceptanceCriteria: story.acceptanceCriteria,
    edgeCases: story.edgeCases,
    requirementRefs: story.requirementRefs,
    labels: story.labels,
  };
}

export const businessAnalyst = defineAgent<BusinessAnalystOutput>({
  key: 'business-analyst',
  name: 'Business Analyst',
  role: 'Turns approved requirements into a development-ready backlog with testable criteria.',
  context: ['documents', 'requirements', 'stories'],
  schema: Output,

  task: (input) =>
    [
      input.mode === 'create'
        ? 'Decompose the requirements into a complete backlog.'
        : 'Revise the existing backlog. Keep the refs of stories you are not changing.',
      renderChangeRequests(input),
    ].join('\n'),

  checks: [
    {
      code: 'UNIQUE_STORY_REFS',
      severity: 'HARD',
      description: 'story refs are unique',
      run: (output) => {
        const seen = new Set<string>();
        const duplicates = output.stories.filter((s) => !seen.add(s.ref)).map((s) => s.ref);
        return duplicates.length ? fail(`duplicate story refs: ${duplicates.join(', ')}`) : pass();
      },
    },
    {
      code: 'REQUIREMENT_TRACE',
      severity: 'HARD',
      description: 'every story traces to at least one requirement',
      run: (output) => {
        const untraced = output.stories.filter((s) => s.requirementRefs.length === 0).map((s) => s.ref);
        return untraced.length ? fail(`stories with no requirement trace: ${untraced.join(', ')}`) : pass();
      },
    },
    {
      code: 'GWT_WELL_FORMED',
      severity: 'HARD',
      description: 'Given/When/Then criteria have all three parts',
      run: (output) => {
        const broken: string[] = [];
        for (const story of output.stories) {
          for (const [index, criterion] of story.acceptanceCriteria.entries()) {
            if (criterion.kind !== 'GWT') continue;
            if (!criterion.given?.trim() || !criterion.when?.trim() || !criterion.then?.trim()) {
              broken.push(`${story.ref}/AC-${index + 1}`);
            }
          }
        }
        return broken.length ? fail(`incomplete Given/When/Then criteria: ${broken.join(', ')}`) : pass();
      },
    },
    {
      code: 'DEPENDENCIES_RESOLVE',
      severity: 'HARD',
      description: 'declared dependencies point at stories in this backlog',
      run: (output) => {
        const known = new Set(output.stories.map((s) => s.ref));
        const dangling = output.stories.flatMap((s) =>
          s.dependsOn.filter((ref) => !known.has(ref)).map((ref) => `${s.ref} -> ${ref}`),
        );
        return dangling.length ? fail(`dependencies on unknown stories: ${dangling.join(', ')}`) : pass();
      },
    },
    {
      code: 'OVERSIZED_MUST_BE_FLAGGED',
      severity: 'HARD',
      description: 'XL stories are flagged for splitting',
      run: (output) => {
        const unflagged = output.stories
          .filter((s) => s.sizeSignal === 'XL' && !s.qualityFlags.some((f) => f.kind === 'TOO_LARGE'))
          .map((s) => s.ref);
        return unflagged.length
          ? fail(`XL stories must be flagged TOO_LARGE and proposed for splitting: ${unflagged.join(', ')}`)
          : pass();
      },
    },
    {
      // The independent verification. SOFT because the finding goes to the human, not the bin.
      code: 'INDEPENDENT_QUALITY_SCAN',
      severity: 'SOFT',
      description: 'issues the platform detected that the agent did not flag',
      run: (output) => {
        const detected = analyseBacklog(output.stories.map(toStoryLike));
        const selfReported = new Set(
          output.stories.flatMap((s) => s.qualityFlags.map((f) => `${s.ref}:${f.kind}`)),
        );
        const missed = detected.filter((d) => !selfReported.has(`${d.storyRef}:${d.kind}`));
        return missed.length
          ? fail(
              `${missed.length} issue(s) the agent did not flag: ` +
                missed.slice(0, 8).map((m) => `${m.storyRef} ${m.kind} — ${m.detail}`).join('; '),
            )
          : pass();
      },
    },
  ],

  async persist(output, input) {
    const detected = analyseBacklog(output.stories.map(toStoryLike));

    for (const [index, story] of output.stories.entries()) {
      // The stored flags are the union: what the agent admitted plus what the scan found. The
      // approver sees one list and does not have to know which half came from where.
      const platformFlags = detected
        .filter((flag) => flag.storyRef === story.ref)
        .filter((flag) => !story.qualityFlags.some((own) => own.kind === flag.kind))
        .map((flag) => ({ kind: flag.kind, detail: flag.detail, severity: flag.severity, source: 'platform' }));

      const data = {
        title: story.title,
        userStory: story.userStory,
        businessValue: story.businessValue,
        description: story.description,
        priority: story.priority,
        sizeSignal: story.sizeSignal,
        labels: story.labels,
        acceptanceCriteria: story.acceptanceCriteria,
        edgeCases: story.edgeCases,
        requirementRefs: story.requirementRefs,
        dependsOn: story.dependsOn,
        qualityFlags: [
          ...story.qualityFlags.map((flag) => ({ ...flag, source: 'agent' })),
          ...platformFlags,
        ],
        orderIndex: index,
      };

      await db.story.upsert({
        where: { projectId_ref: { projectId: input.projectId, ref: story.ref } },
        create: { projectId: input.projectId, ref: story.ref, status: 'REVIEW', ...data },
        update: data,
      });
    }
  },

  summary: (output) => {
    const flags = output.stories.reduce((sum, s) => sum + s.qualityFlags.length, 0);
    return `${output.stories.length} stories, ${flags} self-reported quality flags. ${output.decisionSummary.summary}`;
  },
});
