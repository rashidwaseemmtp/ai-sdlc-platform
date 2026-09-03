#!/usr/bin/env node
/**
 * Business Analyst MCP — local (PostgreSQL) backend.
 *
 * Capability contract from docs/06 §4.2. `search_backlog` is deliberately part of the contract:
 * it is how the BA agent detects duplicates without pulling the entire backlog into context.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPrisma, type Prisma } from '@sdlc/database';

const prisma = getPrisma();
const server = new McpServer({ name: 'sdlc-ba', version: '0.1.0' });

const projectId = z.string().describe('Project id');
const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const acceptanceCriterionInput = z.object({
  kind: z.enum(['GWT', 'CHECKLIST']).default('GWT'),
  given: z.string().optional(),
  when: z.string().optional(),
  then: z.string().optional(),
  statement: z.string().optional(),
});

// ── Requirements (read-through so the BA sees the same statements the PO wrote) ──

server.registerTool(
  'get_requirements',
  { description: 'List requirements for the project.', inputSchema: { projectId } },
  async ({ projectId: id }) =>
    ok(await prisma.requirement.findMany({ where: { projectId: id }, orderBy: { ref: 'asc' } })),
);

server.registerTool(
  'create_requirement',
  {
    description: 'Create a requirement discovered during analysis.',
    inputSchema: {
      projectId,
      ref: z.string(),
      type: z.enum(['FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT']),
      statement: z.string(),
      priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']).default('SHOULD'),
      sourceRefs: z.array(z.record(z.unknown())).default([]),
    },
  },
  async ({ projectId: id, sourceRefs, ...rest }) =>
    ok(await prisma.requirement.create({ data: { projectId: id, sourceRefs: sourceRefs as object, ...rest } })),
);

server.registerTool(
  'update_requirement',
  {
    description: 'Update a requirement.',
    inputSchema: { requirementId: z.string(), statement: z.string().optional(), status: z.string().optional() },
  },
  async ({ requirementId, statement, status }) =>
    ok(
      await prisma.requirement.update({
        where: { id: requirementId },
        data: {
          ...(statement ? { statement } : {}),
          ...(status ? { status: status as Prisma.RequirementUpdateInput['status'] } : {}),
        },
      }),
    ),
);

// ── Stories ────────────────────────────────────────────────────────────────

server.registerTool(
  'get_stories',
  {
    description: 'List backlog stories with their acceptance criteria.',
    inputSchema: {
      projectId,
      status: z.string().optional(),
      epicRef: z.string().optional(),
      limit: z.number().int().positive().max(200).default(100),
    },
  },
  async ({ projectId: id, status, epicRef, limit }) => {
    const stories = await prisma.story.findMany({
      where: {
        projectId: id,
        ...(status ? { status: status as Prisma.StoryWhereInput['status'] } : {}),
        ...(epicRef ? { epic: { ref: epicRef } } : {}),
      },
      include: { acceptanceCriteria: true, qualityFlags: true, epic: true },
      orderBy: [{ orderIndex: 'asc' }, { ref: 'asc' }],
      take: limit,
    });
    return ok(stories);
  },
);

server.registerTool(
  'create_story',
  {
    description:
      'Create a backlog story. At least one acceptance criterion is required — a story without ' +
      'one is not development-ready and the BA quality gate will reject it.',
    inputSchema: {
      projectId,
      ref: z.string(),
      epicRef: z.string().optional(),
      title: z.string(),
      userStory: z.string(),
      businessValue: z.string(),
      description: z.string(),
      priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']).default('SHOULD'),
      sizeSignal: z.enum(['XS', 'S', 'M', 'L', 'XL']).default('M'),
      labels: z.array(z.string()).default([]),
      acceptanceCriteria: z.array(acceptanceCriterionInput).min(1),
      functionalRequirements: z.array(z.string()).default([]),
      nonFunctionalRequirements: z.array(z.record(z.unknown())).default([]),
      edgeCases: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
      assumptions: z.array(z.string()).default([]),
      businessRules: z.array(z.string()).default([]),
      definitionOfReady: z.array(z.record(z.unknown())).default([]),
      requirementRefs: z.array(z.string()).default([]),
    },
  },
  async (args) => {
    const { projectId: id, epicRef, acceptanceCriteria, requirementRefs, ...rest } = args;

    const epic = epicRef
      ? await prisma.epic.findUnique({ where: { projectId_ref: { projectId: id, ref: epicRef } } })
      : null;

    const story = await prisma.story.create({
      data: {
        projectId: id,
        ...(epic ? { epicId: epic.id } : {}),
        ...rest,
        nonFunctionalRequirements: rest.nonFunctionalRequirements as object,
        definitionOfReady: rest.definitionOfReady as object,
        functionalRequirements: rest.functionalRequirements as object,
        edgeCases: rest.edgeCases as object,
        risks: rest.risks as object,
        assumptions: rest.assumptions as object,
        businessRules: rest.businessRules as object,
        acceptanceCriteria: {
          create: acceptanceCriteria.map((criterion, index) => ({
            ref: `AC-${index + 1}`,
            kind: criterion.kind,
            ...(criterion.given ? { given: criterion.given } : {}),
            ...(criterion.when ? { whenText: criterion.when } : {}),
            ...(criterion.then ? { thenText: criterion.then } : {}),
            ...(criterion.statement ? { statement: criterion.statement } : {}),
            orderIndex: index,
          })),
        },
      },
      include: { acceptanceCriteria: true },
    });

    // Traceability: link the story to the requirements it satisfies.
    if (requirementRefs.length) {
      const requirements = await prisma.requirement.findMany({
        where: { projectId: id, ref: { in: requirementRefs } },
        select: { id: true },
      });
      await prisma.storyRequirement.createMany({
        data: requirements.map((r) => ({ storyId: story.id, requirementId: r.id })),
        skipDuplicates: true,
      });
    }

    return ok(story);
  },
);

server.registerTool(
  'update_story',
  {
    description: 'Update a story.',
    inputSchema: {
      storyId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']).optional(),
      status: z.string().optional(),
      sizeSignal: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
    },
  },
  async ({ storyId, status, ...rest }) => {
    const data = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    return ok(
      await prisma.story.update({
        where: { id: storyId },
        data: { ...data, ...(status ? { status: status as Prisma.StoryUpdateInput['status'] } : {}) },
      }),
    );
  },
);

server.registerTool(
  'split_story',
  {
    description:
      'Split an oversized story into children. The parent is marked REJECTED and each child ' +
      'records a SPLIT_FROM dependency, so the lineage survives.',
    inputSchema: {
      storyId: z.string(),
      children: z
        .array(
          z.object({
            ref: z.string(),
            title: z.string(),
            userStory: z.string(),
            description: z.string(),
            acceptanceCriteria: z.array(acceptanceCriterionInput).min(1),
          }),
        )
        .min(2),
    },
  },
  async ({ storyId, children }) => {
    const parent = await prisma.story.findUniqueOrThrow({ where: { id: storyId } });
    const created = [];

    for (const [index, child] of children.entries()) {
      const story = await prisma.story.create({
        data: {
          projectId: parent.projectId,
          epicId: parent.epicId,
          ref: child.ref,
          title: child.title,
          userStory: child.userStory,
          businessValue: parent.businessValue,
          description: child.description,
          priority: parent.priority,
          sizeSignal: 'S',
          orderIndex: parent.orderIndex + index,
          acceptanceCriteria: {
            create: child.acceptanceCriteria.map((criterion, i) => ({
              ref: `AC-${i + 1}`,
              kind: criterion.kind,
              ...(criterion.given ? { given: criterion.given } : {}),
              ...(criterion.when ? { whenText: criterion.when } : {}),
              ...(criterion.then ? { thenText: criterion.then } : {}),
              orderIndex: i,
            })),
          },
        },
      });
      await prisma.storyDependency.create({
        data: { fromId: story.id, toId: parent.id, kind: 'SPLIT_FROM' },
      });
      created.push(story);
    }

    await prisma.story.update({ where: { id: storyId }, data: { status: 'REJECTED' } });
    return ok({ parent: parent.ref, children: created });
  },
);

server.registerTool(
  'merge_stories',
  {
    description: 'Merge duplicate stories into a survivor, recording MERGED_INTO dependencies.',
    inputSchema: { survivorId: z.string(), mergedIds: z.array(z.string()).min(1) },
  },
  async ({ survivorId, mergedIds }) => {
    for (const mergedId of mergedIds) {
      await prisma.storyDependency.create({
        data: { fromId: mergedId, toId: survivorId, kind: 'MERGED_INTO' },
      });
      await prisma.story.update({ where: { id: mergedId }, data: { status: 'REJECTED' } });
    }
    return ok({ survivorId, merged: mergedIds.length });
  },
);

// ── Acceptance criteria, dependencies, rules ───────────────────────────────

server.registerTool(
  'get_acceptance_criteria',
  { description: 'List acceptance criteria for a story.', inputSchema: { storyId: z.string() } },
  async ({ storyId }) =>
    ok(await prisma.acceptanceCriterion.findMany({ where: { storyId }, orderBy: { orderIndex: 'asc' } })),
);

server.registerTool(
  'create_acceptance_criteria',
  {
    description: 'Append acceptance criteria to a story.',
    inputSchema: { storyId: z.string(), criteria: z.array(acceptanceCriterionInput).min(1) },
  },
  async ({ storyId, criteria }) => {
    const existing = await prisma.acceptanceCriterion.count({ where: { storyId } });
    const created = await prisma.acceptanceCriterion.createManyAndReturn({
      data: criteria.map((criterion, index) => ({
        storyId,
        ref: `AC-${existing + index + 1}`,
        kind: criterion.kind,
        ...(criterion.given ? { given: criterion.given } : {}),
        ...(criterion.when ? { whenText: criterion.when } : {}),
        ...(criterion.then ? { thenText: criterion.then } : {}),
        ...(criterion.statement ? { statement: criterion.statement } : {}),
        orderIndex: existing + index,
      })),
    });
    return ok(created);
  },
);

server.registerTool(
  'get_dependencies',
  { description: 'List story dependencies for a project.', inputSchema: { projectId } },
  async ({ projectId: id }) =>
    ok(
      await prisma.storyDependency.findMany({
        where: { from: { projectId: id } },
        include: { from: { select: { ref: true } }, to: { select: { ref: true } } },
      }),
    ),
);

server.registerTool(
  'create_dependency',
  {
    description: 'Record a dependency between two stories.',
    inputSchema: {
      fromStoryId: z.string(),
      toStoryId: z.string(),
      kind: z.enum(['BLOCKS', 'RELATES', 'SPLIT_FROM', 'MERGED_INTO']).default('BLOCKS'),
    },
  },
  async ({ fromStoryId, toStoryId, kind }) =>
    ok(await prisma.storyDependency.create({ data: { fromId: fromStoryId, toId: toStoryId, kind } })),
);

server.registerTool(
  'get_business_rules',
  { description: 'List business rules.', inputSchema: { projectId } },
  async ({ projectId: id }) => ok(await prisma.businessRule.findMany({ where: { projectId: id } })),
);

server.registerTool(
  'create_business_rule',
  {
    description: 'Record a business rule.',
    inputSchema: {
      projectId,
      ref: z.string(),
      statement: z.string(),
      appliesTo: z.string().optional(),
      rationale: z.string().optional(),
    },
  },
  async ({ projectId: id, ...rest }) =>
    ok(await prisma.businessRule.create({ data: { projectId: id, ...rest } })),
);

server.registerTool(
  'get_open_questions',
  { description: 'List unanswered questions.', inputSchema: { projectId } },
  async ({ projectId: id }) =>
    ok(await prisma.openQuestion.findMany({ where: { projectId: id, answeredAt: null } })),
);

server.registerTool(
  'create_open_question',
  {
    description: 'Raise an open question.',
    inputSchema: {
      projectId,
      question: z.string(),
      severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
      blocksRefs: z.array(z.string()).default([]),
    },
  },
  async ({ projectId: id, blocksRefs, ...rest }) =>
    ok(await prisma.openQuestion.create({ data: { projectId: id, blocksRefs: blocksRefs as object, ...rest } })),
);

// ── Duplicate detection ────────────────────────────────────────────────────

server.registerTool(
  'search_backlog',
  {
    description:
      'Full-text search across story titles and descriptions. Use this before creating a story ' +
      'to detect duplicates without loading the whole backlog into context.',
    inputSchema: { projectId, query: z.string(), limit: z.number().int().positive().max(50).default(10) },
  },
  async ({ projectId: id, query, limit }) => {
    const stories = await prisma.story.findMany({
      where: {
        projectId: id,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { userStory: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: { id: true, ref: true, title: true, status: true, userStory: true },
      take: limit,
    });
    return ok(stories);
  },
);

await server.connect(new StdioServerTransport());
