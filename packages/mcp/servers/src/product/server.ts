#!/usr/bin/env node
/**
 * Product MCP — local (PostgreSQL) backend.
 *
 * Implements the capability contract from docs/06 §4.1. The contract is the point: a Jira or
 * Linear backend exposes the same tool names and schemas, so the PO and BA agents are
 * byte-identical regardless of which backend an installation runs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPrisma } from '@sdlc/database';

const prisma = getPrisma();
const server = new McpServer({ name: 'sdlc-product', version: '0.1.0' });

const projectId = z.string().describe('Project id');

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

// ── Project ────────────────────────────────────────────────────────────────

server.registerTool(
  'get_project',
  {
    description: 'Fetch a project with its phase, status and settings.',
    inputSchema: { projectId },
  },
  async ({ projectId: id }) => {
    const project = await prisma.project.findUnique({
      where: { id },
      include: { repositories: true, integrations: true },
    });
    return ok(project);
  },
);

server.registerTool(
  'update_project',
  {
    description: 'Update a project name, description or settings.',
    inputSchema: {
      projectId,
      name: z.string().optional(),
      description: z.string().optional(),
      settings: z.record(z.unknown()).optional(),
    },
  },
  async ({ projectId: id, name, description, settings }) => {
    const project = await prisma.project.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(settings !== undefined ? { settings: settings as object } : {}),
      },
    });
    return ok(project);
  },
);

// ── Product vision ─────────────────────────────────────────────────────────

server.registerTool(
  'get_product_vision',
  { description: 'Fetch the product vision.', inputSchema: { projectId } },
  async ({ projectId: id }) => ok(await prisma.productVision.findUnique({ where: { projectId: id } })),
);

server.registerTool(
  'update_product_vision',
  {
    description: 'Create or replace the product vision.',
    inputSchema: {
      projectId,
      statement: z.string(),
      problem: z.string(),
      valueProposition: z.string(),
      targetUsers: z.array(z.string()).default([]),
      successMetrics: z.array(z.string()).default([]),
    },
  },
  async ({ projectId: id, statement, problem, valueProposition, targetUsers, successMetrics }) => {
    const vision = await prisma.productVision.upsert({
      where: { projectId: id },
      create: {
        projectId: id,
        statement,
        problem,
        valueProposition,
        targetUsers,
        successMetrics,
      },
      update: {
        statement,
        problem,
        valueProposition,
        targetUsers,
        successMetrics,
        version: { increment: 1 },
      },
    });
    return ok(vision);
  },
);

// ── Business goals & stakeholders ──────────────────────────────────────────

server.registerTool(
  'get_business_goals',
  { description: 'List business goals.', inputSchema: { projectId } },
  async ({ projectId: id }) =>
    ok(await prisma.businessGoal.findMany({ where: { projectId: id }, orderBy: { ref: 'asc' } })),
);

server.registerTool(
  'create_business_goal',
  {
    description: 'Create a business goal.',
    inputSchema: {
      projectId,
      ref: z.string(),
      title: z.string(),
      description: z.string(),
      metric: z.string().optional(),
      targetValue: z.string().optional(),
      priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']).default('SHOULD'),
    },
  },
  async (args) => {
    const { projectId: id, ...rest } = args;
    return ok(await prisma.businessGoal.create({ data: { projectId: id, ...rest } }));
  },
);

server.registerTool(
  'get_stakeholders',
  { description: 'List stakeholders.', inputSchema: { projectId } },
  async ({ projectId: id }) => ok(await prisma.stakeholder.findMany({ where: { projectId: id } })),
);

server.registerTool(
  'create_stakeholder',
  {
    description: 'Create a stakeholder.',
    inputSchema: {
      projectId,
      name: z.string(),
      role: z.string(),
      interests: z.array(z.string()).default([]),
      concerns: z.array(z.string()).default([]),
      influence: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
    },
  },
  async (args) => {
    const { projectId: id, ...rest } = args;
    return ok(await prisma.stakeholder.create({ data: { projectId: id, ...rest } }));
  },
);

// ── Requirements ───────────────────────────────────────────────────────────

server.registerTool(
  'get_requirements',
  {
    description: 'List requirements, optionally filtered by type, priority or status.',
    inputSchema: {
      projectId,
      type: z.enum(['FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT']).optional(),
      status: z.enum(['DRAFT', 'REVIEW', 'APPROVED', 'SUPERSEDED', 'REJECTED']).optional(),
    },
  },
  async ({ projectId: id, type, status }) =>
    ok(
      await prisma.requirement.findMany({
        where: { projectId: id, ...(type ? { type } : {}), ...(status ? { status } : {}) },
        orderBy: { ref: 'asc' },
      }),
    ),
);

server.registerTool(
  'create_requirement',
  {
    description:
      'Create a requirement. sourceRefs is mandatory: every requirement must trace back to the ' +
      'document span that produced it.',
    inputSchema: {
      projectId,
      ref: z.string(),
      type: z.enum(['FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT']),
      priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']).default('SHOULD'),
      statement: z.string(),
      rationale: z.string().optional(),
      confidence: z.number().min(0).max(1).default(0.5),
      sourceRefs: z
        .array(z.object({ documentId: z.string(), span: z.array(z.number()).length(2).optional() }))
        .min(1),
    },
  },
  async (args) => {
    const { projectId: id, sourceRefs, ...rest } = args;
    return ok(
      await prisma.requirement.create({ data: { projectId: id, sourceRefs: sourceRefs as object, ...rest } }),
    );
  },
);

server.registerTool(
  'update_requirement',
  {
    description: 'Update a requirement.',
    inputSchema: {
      requirementId: z.string(),
      statement: z.string().optional(),
      rationale: z.string().optional(),
      priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']).optional(),
      status: z.enum(['DRAFT', 'REVIEW', 'APPROVED', 'SUPERSEDED', 'REJECTED']).optional(),
    },
  },
  async ({ requirementId, ...rest }) => {
    const data = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    return ok(await prisma.requirement.update({ where: { id: requirementId }, data }));
  },
);

server.registerTool(
  'get_priorities',
  { description: 'Requirement refs grouped by MoSCoW priority.', inputSchema: { projectId } },
  async ({ projectId: id }) => {
    const requirements = await prisma.requirement.findMany({
      where: { projectId: id },
      select: { ref: true, priority: true, statement: true },
    });
    const grouped: Record<string, { ref: string; statement: string }[]> = {};
    for (const r of requirements) {
      (grouped[r.priority] ??= []).push({ ref: r.ref, statement: r.statement });
    }
    return ok(grouped);
  },
);

// ── Decisions & open questions ─────────────────────────────────────────────

server.registerTool(
  'create_product_decision',
  {
    description: 'Record a product decision.',
    inputSchema: {
      projectId,
      ref: z.string(),
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      rationale: z.string(),
      decidedBy: z.string().optional(),
    },
  },
  async (args) => {
    const { projectId: id, ...rest } = args;
    return ok(await prisma.productDecision.create({ data: { projectId: id, ...rest } }));
  },
);

server.registerTool(
  'get_product_decisions',
  { description: 'List product decisions.', inputSchema: { projectId } },
  async ({ projectId: id }) =>
    ok(await prisma.productDecision.findMany({ where: { projectId: id }, orderBy: { decidedAt: 'asc' } })),
);

server.registerTool(
  'get_open_questions',
  {
    description: 'List open questions, unanswered by default.',
    inputSchema: { projectId, includeAnswered: z.boolean().default(false) },
  },
  async ({ projectId: id, includeAnswered }) =>
    ok(
      await prisma.openQuestion.findMany({
        where: { projectId: id, ...(includeAnswered ? {} : { answeredAt: null }) },
      }),
    ),
);

server.registerTool(
  'create_open_question',
  {
    description: 'Raise an open question that blocks progress.',
    inputSchema: {
      projectId,
      question: z.string(),
      askedOf: z.string().optional(),
      blocksRefs: z.array(z.string()).default([]),
      severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    },
  },
  async (args) => {
    const { projectId: id, blocksRefs, ...rest } = args;
    return ok(
      await prisma.openQuestion.create({ data: { projectId: id, blocksRefs: blocksRefs as object, ...rest } }),
    );
  },
);

await server.connect(new StdioServerTransport());
