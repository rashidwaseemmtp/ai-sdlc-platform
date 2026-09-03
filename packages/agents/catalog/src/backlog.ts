/**
 * Business Analyst agent — docs/04 §6.
 *
 * Produces the development-ready backlog. Its quality checks are the interesting part: the agent
 * reports its own doubts as `qualityFlags`, and the platform independently verifies them with the
 * pure analysis in `@sdlc/domain`. Trusting only the model's self-report would not be a gate.
 */

import { z } from 'zod';
import { ArtifactKind, type ModelRequest } from '@sdlc/shared';
import type { RegisteredAgent } from '@sdlc/agent-runtime';
import { analyseBacklog, type StoryLike } from '@sdlc/domain';
import {
  BaseInput,
  DecisionSummary,
  POLICY,
  Priority,
  Severity,
  check,
  defineAgent,
  demoSummary,
  fail,
  mcp,
  pass,
  readJsonSection,
} from './common.js';

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
  epicRef: z.string().optional(),
  title: z.string().min(3),
  userStory: z.string(),
  businessValue: z.string(),
  description: z.string(),
  priority: Priority,
  sizeSignal: z.enum(['XS', 'S', 'M', 'L', 'XL']),
  labels: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  functionalRequirements: z.array(z.string()).default([]),
  nonFunctionalRequirements: z
    .array(z.object({ category: z.string(), requirement: z.string(), measure: z.string().optional() }))
    .default([]),
  edgeCases: z.array(z.string()).min(1),
  dependencies: z
    .array(z.object({ storyRef: z.string(), kind: z.enum(['BLOCKS', 'RELATES']) }))
    .default([]),
  risks: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  businessRules: z.array(z.string()).default([]),
  definitionOfReady: z.array(z.object({ item: z.string(), met: z.boolean() })).default([]),
  requirementRefs: z.array(z.string()).min(1),
  qualityFlags: z.array(QualityFlag).default([]),
});

export const BusinessAnalystOutput = z.object({
  epics: z
    .array(z.object({ ref: z.string(), title: z.string(), goal: z.string(), orderIndex: z.number() }))
    .default([]),
  stories: z.array(Story).min(1),
  openQuestions: z
    .array(z.object({ question: z.string(), blocksRefs: z.array(z.string()).default([]), severity: Severity }))
    .default([]),
  decisionSummary: DecisionSummary,
});

export type BusinessAnalystOutput = z.infer<typeof BusinessAnalystOutput>;

const BusinessAnalystInput = BaseInput.extend({
  storyRefs: z.array(z.string()).optional().describe('Revise only these stories'),
});

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

export const businessAnalystAgent: RegisteredAgent<
  z.infer<typeof BusinessAnalystInput>,
  BusinessAnalystOutput
> = {
  definition: defineAgent({
    key: 'business-analyst',
    name: 'Business Analyst',
    role: 'Turns approved requirements into a development-ready backlog with testable criteria.',
    modelPolicy: POLICY.frontierReasoning(),
    contextRecipe: 'business-analyst',
    mcpServers: [
      mcp('product', ['get_*'], ['product.read']),
      mcp('ba', ['*'], ['backlog.read', 'backlog.write']),
    ],
    permissions: ['read_project', 'read_requirements', 'read_backlog', 'write_backlog'],
    writes: [ArtifactKind.BACKLOG, ArtifactKind.STORY],
    inputSchema: BusinessAnalystInput,
    outputSchema: BusinessAnalystOutput,
    budget: { maxCostUsd: 4, maxToolCalls: 80 },
    qualityChecks: [
      check<BusinessAnalystOutput>(
        'UNIQUE_STORY_REFS',
        'HARD',
        'story refs are unique',
        (output) => {
          const seen = new Set<string>();
          const duplicates = output.stories.filter((s) => !seen.add(s.ref)).map((s) => s.ref);
          return duplicates.length ? fail('duplicate story refs', { duplicates }) : pass();
        },
      ),
      check<BusinessAnalystOutput>(
        'REQUIREMENT_TRACE',
        'HARD',
        'every story traces to at least one requirement',
        (output) => {
          const untraced = output.stories.filter((s) => s.requirementRefs.length === 0);
          return untraced.length
            ? fail('stories with no requirement trace', { refs: untraced.map((s) => s.ref) })
            : pass();
        },
      ),
      check<BusinessAnalystOutput>(
        'GWT_WELL_FORMED',
        'HARD',
        'Given/When/Then criteria have all three parts',
        (output) => {
          const broken: string[] = [];
          for (const story of output.stories) {
            for (const [index, criterion] of story.acceptanceCriteria.entries()) {
              if (criterion.kind !== 'GWT') continue;
              if (!criterion.given?.trim() || !criterion.when?.trim() || !criterion.then?.trim()) {
                broken.push(`${story.ref}/AC-${index + 1}`);
              }
            }
          }
          return broken.length ? fail('incomplete Given/When/Then criteria', { broken }) : pass();
        },
      ),
      check<BusinessAnalystOutput>(
        'OVERSIZED_MUST_BE_FLAGGED',
        'HARD',
        'XL stories are flagged for splitting',
        (output) => {
          const unflagged = output.stories.filter(
            (s) => s.sizeSignal === 'XL' && !s.qualityFlags.some((f) => f.kind === 'TOO_LARGE'),
          );
          return unflagged.length
            ? fail('XL stories must be flagged TOO_LARGE and proposed for splitting', {
                refs: unflagged.map((s) => s.ref),
              })
            : pass();
        },
      ),
      check<BusinessAnalystOutput>(
        'DEPENDENCIES_RESOLVE',
        'HARD',
        'declared dependencies point at stories in this backlog',
        (output) => {
          const known = new Set(output.stories.map((s) => s.ref));
          const dangling = output.stories.flatMap((s) =>
            s.dependencies.filter((d) => !known.has(d.storyRef)).map((d) => `${s.ref} -> ${d.storyRef}`),
          );
          return dangling.length ? fail('dependencies on unknown stories', { dangling }) : pass();
        },
      ),
      // The independent verification: the platform re-derives quality flags rather than trusting
      // the agent's self-report, and reports anything the agent missed.
      check<BusinessAnalystOutput>(
        'INDEPENDENT_QUALITY_SCAN',
        'SOFT',
        'platform-detected issues the agent did not flag',
        (output) => {
          const detected = analyseBacklog(output.stories.map(toStoryLike));
          const selfReported = new Set(
            output.stories.flatMap((s) => s.qualityFlags.map((f) => `${s.ref}:${f.kind}`)),
          );
          const missed = detected.filter((d) => !selfReported.has(`${d.storyRef}:${d.kind}`));
          return missed.length
            ? fail(`${missed.length} issue(s) detected that the agent did not flag`, {
                missed: missed.map((m) => `${m.storyRef}: ${m.kind} — ${m.detail}`),
              })
            : pass();
        },
      ),
    ],
  }),
  inputSchema: BusinessAnalystInput,
  outputSchema: BusinessAnalystOutput,

  toArtifacts: (output) => [{ kind: ArtifactKind.BACKLOG, name: 'backlog', content: output }],

  contextVariables: (invocation) => ({
    changeRequests: (invocation.input as { changeRequests?: unknown }).changeRequests ?? [],
    retrievalQuery: 'user workflows, acceptance criteria, business rules, edge cases',
  }),

  async project(output, { prisma, invocation }) {
    const projectId = invocation.projectId;

    for (const epic of output.epics) {
      await prisma.epic.upsert({
        where: { projectId_ref: { projectId, ref: epic.ref } },
        create: { projectId, ...epic },
        update: { title: epic.title, goal: epic.goal, orderIndex: epic.orderIndex },
      });
    }

    for (const [index, story] of output.stories.entries()) {
      const epic = story.epicRef
        ? await prisma.epic.findUnique({ where: { projectId_ref: { projectId, ref: story.epicRef } } })
        : null;

      const data = {
        title: story.title,
        userStory: story.userStory,
        businessValue: story.businessValue,
        description: story.description,
        priority: story.priority,
        sizeSignal: story.sizeSignal,
        labels: story.labels,
        functionalRequirements: story.functionalRequirements as object,
        nonFunctionalRequirements: story.nonFunctionalRequirements as object,
        edgeCases: story.edgeCases as object,
        risks: story.risks as object,
        assumptions: story.assumptions as object,
        businessRules: story.businessRules as object,
        definitionOfReady: story.definitionOfReady as object,
        orderIndex: index,
        ...(epic ? { epicId: epic.id } : {}),
      };

      const record = await prisma.story.upsert({
        where: { projectId_ref: { projectId, ref: story.ref } },
        create: { projectId, ref: story.ref, status: 'REVIEW', ...data },
        update: data,
      });

      // Acceptance criteria are replaced wholesale on a revision: they are the story's contract,
      // and a partial merge would leave stale criteria behind that QA would then test against.
      await prisma.acceptanceCriterion.deleteMany({ where: { storyId: record.id } });
      await prisma.acceptanceCriterion.createMany({
        data: story.acceptanceCriteria.map((criterion, i) => ({
          storyId: record.id,
          ref: `AC-${i + 1}`,
          kind: criterion.kind,
          ...(criterion.given ? { given: criterion.given } : {}),
          ...(criterion.when ? { whenText: criterion.when } : {}),
          ...(criterion.then ? { thenText: criterion.then } : {}),
          ...(criterion.statement ? { statement: criterion.statement } : {}),
          orderIndex: i,
        })),
      });

      await prisma.storyQualityFlag.deleteMany({ where: { storyId: record.id, resolved: false } });
      if (story.qualityFlags.length) {
        await prisma.storyQualityFlag.createMany({
          data: story.qualityFlags.map((flag) => ({
            storyId: record.id,
            kind: flag.kind,
            detail: flag.detail,
            severity: flag.severity,
          })),
        });
      }

      const requirements = await prisma.requirement.findMany({
        where: { projectId, ref: { in: story.requirementRefs } },
        select: { id: true },
      });
      await prisma.storyRequirement.createMany({
        data: requirements.map((r) => ({ storyId: record.id, requirementId: r.id })),
        skipDuplicates: true,
      });
    }

    // Dependencies resolve in a second pass, once every story exists.
    for (const story of output.stories) {
      const from = await prisma.story.findUnique({
        where: { projectId_ref: { projectId, ref: story.ref } },
      });
      if (!from) continue;
      for (const dependency of story.dependencies) {
        const to = await prisma.story.findUnique({
          where: { projectId_ref: { projectId, ref: dependency.storyRef } },
        });
        if (!to) continue;
        await prisma.storyDependency.upsert({
          where: { fromId_toId_kind: { fromId: from.id, toId: to.id, kind: dependency.kind } },
          create: { fromId: from.id, toId: to.id, kind: dependency.kind },
          update: {},
        });
      }
    }

    for (const question of output.openQuestions) {
      await prisma.openQuestion.create({
        data: {
          projectId,
          question: question.question,
          severity: question.severity,
          blocksRefs: question.blocksRefs as object,
        },
      });
    }
  },
};

/** Demo handler — decomposes whatever requirements are actually in the project. */
export function businessAnalystDemoHandler(req: ModelRequest): BusinessAnalystOutput {
  const requirements =
    readJsonSection<{ ref: string; statement: string; type: string; priority: string }[]>(
      req,
      'approved-requirements',
    ) ?? [];

  const functional = requirements.filter((r) => r.type === 'FUNCTIONAL');
  const rules = requirements.filter((r) => r.type === 'BUSINESS_RULE');

  const stories: z.infer<typeof Story>[] = functional.map((requirement, index) => {
    const ref = `US-${101 + index}`;
    const isDeactivation = /deactivat/i.test(requirement.statement);

    return {
      ref,
      epicRef: 'EP-1',
      title: requirement.statement.replace(/^An? (administrator|support agent) can /i, '').replace(/\.$/, ''),
      userStory: isDeactivation
        ? 'As an account administrator, I want to deactivate a customer account, so that a departing customer immediately loses access'
        : `As an account administrator, I want to ${requirement.statement
            .replace(/^An? (administrator|support agent) can /i, '')
            .replace(/\.$/, '')}, so that customer data stays accurate and current`,
      businessValue: 'Supports the consolidated customer record and reduces support escalations.',
      description: requirement.statement,
      priority: (requirement.priority as 'MUST' | 'SHOULD' | 'COULD' | 'WONT') ?? 'SHOULD',
      sizeSignal: isDeactivation ? 'M' : 'S',
      labels: isDeactivation ? ['lifecycle'] : ['crud'],
      acceptanceCriteria: isDeactivation
        ? [
            {
              kind: 'GWT' as const,
              given: 'an active customer with no unpaid invoices',
              when: 'an administrator confirms deactivation',
              then: 'the account status becomes inactive and the customer can no longer sign in',
            },
            {
              kind: 'GWT' as const,
              given: 'a customer with at least one unpaid invoice',
              when: 'an administrator attempts deactivation',
              then: 'the action is blocked and the unpaid invoices are listed in the warning',
            },
            {
              kind: 'GWT' as const,
              given: 'a successful deactivation',
              when: 'the audit log is inspected',
              then: 'it records the actor, the customer id and the timestamp',
            },
          ]
        : [
            {
              kind: 'GWT' as const,
              given: 'an authenticated administrator',
              when: 'they submit the form with valid values',
              then: 'the record is persisted and shown in the customer list',
            },
            {
              kind: 'GWT' as const,
              given: 'an authenticated administrator',
              when: 'they submit the form with a missing required field',
              then: 'the field is highlighted and nothing is persisted',
            },
          ],
      functionalRequirements: [requirement.statement],
      nonFunctionalRequirements: [
        { category: 'Auditability', requirement: 'Change is written to the audit log', measure: '100% of changes' },
      ],
      edgeCases: isDeactivation
        ? [
            'customer is already inactive',
            'two administrators deactivate concurrently',
            'invoice service is unavailable when checking unpaid invoices',
          ]
        : ['record was deleted by another user mid-edit', 'duplicate email address'],
      dependencies: index === 0 ? [] : [{ storyRef: 'US-101', kind: 'BLOCKS' as const }],
      risks: isDeactivation ? ['Blocking rule may be bypassed if the invoice check fails open'] : [],
      assumptions: [],
      businessRules: isDeactivation ? rules.map((r) => r.statement) : [],
      definitionOfReady: [
        { item: 'Acceptance criteria agreed', met: true },
        { item: 'Design available', met: !isDeactivation },
      ],
      requirementRefs: [requirement.ref],
      qualityFlags: isDeactivation
        ? [
            {
              kind: 'AMBIGUOUS' as const,
              detail: 'The finance override path is referenced but its authorisation rule is unspecified.',
              severity: 'MEDIUM' as const,
            },
          ]
        : [],
    };
  });

  return {
    epics: [{ ref: 'EP-1', title: 'Customer lifecycle', goal: 'Manage customer records end to end', orderIndex: 0 }],
    stories: stories.length
      ? stories
      : [
          {
            ref: 'US-101',
            epicRef: 'EP-1',
            title: 'Placeholder story',
            userStory: 'As an administrator, I want a customer record, so that data is centralised',
            businessValue: 'Baseline capability',
            description: 'No approved requirements were available to decompose.',
            priority: 'SHOULD',
            sizeSignal: 'S',
            labels: [],
            acceptanceCriteria: [
              { kind: 'GWT', given: 'no requirements', when: 'the BA runs', then: 'a placeholder story is produced' },
            ],
            functionalRequirements: [],
            nonFunctionalRequirements: [],
            edgeCases: ['no requirements exist'],
            dependencies: [],
            risks: [],
            assumptions: [],
            businessRules: [],
            definitionOfReady: [],
            requirementRefs: ['REQ-001'],
            qualityFlags: [
              { kind: 'AMBIGUOUS', detail: 'No approved requirements were present.', severity: 'HIGH' },
            ],
          },
        ],
    openQuestions: [
      {
        question: 'Who authorises the finance override on deactivation?',
        blocksRefs: ['US-102'],
        severity: 'HIGH',
      },
    ],
    decisionSummary: demoSummary(
      `Decomposed ${functional.length} functional requirement(s) into ${stories.length} stories, ` +
        'each with Given/When/Then criteria and edge cases. One ambiguity flagged on the ' +
        'deactivation override rule.',
      0.76,
    ),
  };
}
