/**
 * The HTTP surface.
 *
 * One router, one file. Every endpoint is a thin read or write over Prisma — there is no service
 * layer, because there is nothing for it to do that the query does not already say plainly.
 *
 * Three endpoints carry real behaviour: `POST /projects/:key/start` creates the run row the runner
 * claims, `POST /approvals/:id/decide` records a decision and makes the project claimable again,
 * and `POST /mcp/servers/:key/test` connects to a tool server and records what it advertises.
 * Everything else is a query.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { db, logEvent } from './db.js';
import { AGENTS } from './agents/index.js';
import { STAGES } from './pipeline.js';
import { discoverTools } from './mcp.js';
import { probeCli } from './llm.js';
import { PROVIDERS, allPairs } from './providers.js';
import { GATE_KEYS, getSettings, redact, saveSettings } from './settings.js';

export const api = Router();

/** Express 4 does not catch a rejected promise from a handler, so every handler goes through this. */
const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Projects are addressed by their human key (`CMS`) or their id, whichever the caller has. */
async function resolveProject(idOrKey: string) {
  const project = await db.project.findFirst({
    where: { OR: [{ id: idOrKey }, { key: idOrKey.toUpperCase() }] },
    include: { run: true },
  });
  if (!project) throw new HttpError(404, `No project "${idOrKey}".`);
  return project;
}

// ── Platform ───────────────────────────────────────────────────────────────

api.get(
  '/health',
  handle(async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', stages: STAGES.map((stage) => stage.key) });
  }),
);

/**
 * The agent catalogue, read-only by design — these are code, not configuration.
 *
 * The grants are attached because "what can this agent reach" is the question people actually have
 * when they open this page, and the answer lives on the MCP page rather than in the agent.
 */
api.get(
  '/agents',
  handle(async (_req, res) => {
    const grants = await db.mcpGrant.findMany({ include: { server: { select: { name: true, enabled: true } } } });

    res.json(
      AGENTS.map((agent) => ({
        key: agent.key,
        name: agent.name,
        role: agent.role,
        context: agent.context,
        checks: (agent.checks ?? []).map((check) => ({
          code: check.code,
          severity: check.severity,
          description: check.description,
        })),
        grants: grants
          .filter((grant) => grant.agentKey === agent.key)
          .map((grant) => ({
            serverKey: grant.serverKey,
            serverName: grant.server.name,
            toolPatterns: grant.toolPatterns,
            enabled: grant.enabled && grant.server.enabled,
            maxCallsPerRun: grant.maxCallsPerRun,
          })),
      })),
    );
  }),
);

api.get(
  '/settings',
  handle(async (_req, res) => {
    res.json({
      settings: redact(await getSettings()),
      /** The whole matrix, so the dashboard can render a card per pair without hardcoding any of it. */
      providers: PROVIDERS.map((provider) => ({
        key: provider.key,
        displayName: provider.displayName,
        modes: provider.modes.map((mode) => ({
          mode: mode.mode,
          label: mode.label,
          summary: mode.summary,
          needsApiKey: mode.needsApiKey,
          supportsTools: mode.supportsTools,
          suggestedModels: mode.suggestedModels,
          defaultBaseUrl: mode.defaultBaseUrl ?? '',
          cli: mode.cli
            ? { command: mode.cli.command, loginCommand: mode.cli.loginCommand, plans: mode.cli.plans }
            : null,
        })),
      })),
      gates: GATE_KEYS,
    });
  }),
);

api.put(
  '/settings',
  handle(async (req, res) => {
    res.json({ settings: redact(await saveSettings(req.body)) });
  }),
);

/**
 * Is the CLI behind a subscription pair actually installed in this container?
 *
 * Worth its own endpoint because "subscription mode is selected" and "the CLI exists and is signed
 * in" are different facts, and only the second one makes a run possible.
 */
api.get(
  '/providers/probe',
  handle(async (_req, res) => {
    const settings = await getSettings();
    const results = [];

    for (const pair of allPairs()) {
      if (!pair.spec.cli) continue;
      const configured = settings.providers[pair.id];
      const command = configured?.command || pair.spec.cli.command;
      const probe = await probeCli(
        command,
        pair.spec.cli.probeArgs,
        pair.spec.cli.statusArgs,
        pair.spec.cli.signedOutMarkers,
      );
      results.push({
        id: pair.id,
        provider: pair.providerKey,
        command,
        installed: probe.installed,
        detail: probe.detail,
        signedIn: probe.signedIn,
        status: probe.status,
        loginCommand: pair.spec.cli.loginCommand,
        plans: pair.spec.cli.plans,
      });
    }
    res.json(results);
  }),
);

// ── MCP ────────────────────────────────────────────────────────────────────

const ServerInput = z.object({
  key: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens'),
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  url: z.string().default(''),
  enabled: z.boolean().default(true),
});

/** Environment values are secrets (tokens, paths) — the browser is told they exist, not what they are. */
function redactServer(server: {
  env: unknown;
  [key: string]: unknown;
}): Record<string, unknown> {
  return { ...server, env: Object.keys((server.env ?? {}) as object) };
}

api.get(
  '/mcp/servers',
  handle(async (_req, res) => {
    const servers = await db.mcpServer.findMany({ orderBy: { key: 'asc' } });
    res.json(servers.map(redactServer));
  }),
);

api.post(
  '/mcp/servers',
  handle(async (req, res) => {
    const input = ServerInput.parse(req.body);
    if (await db.mcpServer.findUnique({ where: { key: input.key } })) {
      throw new HttpError(409, `A server with the key "${input.key}" already exists.`);
    }
    const server = await db.mcpServer.create({ data: input });
    res.status(201).json(redactServer(server));
  }),
);

api.put(
  '/mcp/servers/:key',
  handle(async (req, res) => {
    const existing = await db.mcpServer.findUnique({ where: { key: req.params.key! } });
    if (!existing) throw new HttpError(404, 'No such server.');

    const input = ServerInput.partial().parse(req.body);
    // A blank env from the browser means "leave what is stored" — it never received the values.
    const env = input.env && Object.keys(input.env).length ? input.env : (existing.env as object);

    const server = await db.mcpServer.update({
      where: { key: req.params.key! },
      data: { ...input, key: existing.key, env: env as object },
    });
    res.json(redactServer(server));
  }),
);

api.delete(
  '/mcp/servers/:key',
  handle(async (req, res) => {
    await db.mcpServer.delete({ where: { key: req.params.key! } });
    res.json({ deleted: req.params.key });
  }),
);

/** Connect, list the tools, and store them. This is what makes the grant editor useful. */
api.post(
  '/mcp/servers/:key/test',
  handle(async (req, res) => {
    res.json(await discoverTools(req.params.key!));
  }),
);

api.get(
  '/mcp/grants',
  handle(async (_req, res) => {
    res.json(await db.mcpGrant.findMany({ orderBy: [{ agentKey: 'asc' }, { serverKey: 'asc' }] }));
  }),
);

const GrantInput = z.object({
  agentKey: z.string().min(1),
  serverKey: z.string().min(1),
  toolPatterns: z.array(z.string().min(1)).min(1).default(['*']),
  enabled: z.boolean().default(true),
  maxCallsPerRun: z.number().int().min(1).max(500).default(50),
});

api.put(
  '/mcp/grants',
  handle(async (req, res) => {
    const input = GrantInput.parse(req.body);
    if (!AGENTS.some((agent) => agent.key === input.agentKey)) {
      throw new HttpError(400, `No agent called "${input.agentKey}".`);
    }
    if (!(await db.mcpServer.findUnique({ where: { key: input.serverKey } }))) {
      throw new HttpError(400, `No MCP server called "${input.serverKey}".`);
    }

    const grant = await db.mcpGrant.upsert({
      where: { agentKey_serverKey: { agentKey: input.agentKey, serverKey: input.serverKey } },
      create: input,
      update: input,
    });
    res.json(grant);
  }),
);

api.delete(
  '/mcp/grants/:agentKey/:serverKey',
  handle(async (req, res) => {
    await db.mcpGrant
      .delete({
        where: {
          agentKey_serverKey: { agentKey: req.params.agentKey!, serverKey: req.params.serverKey! },
        },
      })
      .catch(() => undefined);
    res.json({ revoked: `${req.params.agentKey}/${req.params.serverKey}` });
  }),
);

/** Every tool call an agent made or was refused — the audit trail for anything with side effects. */
api.get(
  '/mcp/calls',
  handle(async (req, res) => {
    const runId = typeof req.query.run === 'string' ? req.query.run : undefined;
    res.json(
      await db.toolCall.findMany({
        where: runId ? { agentRunId: runId } : {},
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }),
);

// ── Projects ───────────────────────────────────────────────────────────────

const NewProject = z.object({
  key: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  name: z.string().min(2),
  description: z.string().optional(),
});

api.get(
  '/projects',
  handle(async (_req, res) => {
    const projects = await db.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        run: true,
        _count: { select: { requirements: true, stories: true, documents: true, agentRuns: true } },
      },
    });
    res.json(projects);
  }),
);

api.post(
  '/projects',
  handle(async (req, res) => {
    const input = NewProject.parse(req.body);
    const key = input.key.toUpperCase();

    if (await db.project.findUnique({ where: { key } })) {
      throw new HttpError(409, `A project with the key ${key} already exists.`);
    }

    const project = await db.project.create({
      data: { key, name: input.name, description: input.description ?? null },
    });
    await logEvent(project.id, 'PROJECT_CREATED', { key });
    res.status(201).json(project);
  }),
);

api.get(
  '/projects/:key',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    const [documents, requirements, stories, options, adrs, estimates, prs, testCases, bugs, plan, approvals, cost] =
      await Promise.all([
        db.document.count({ where: { projectId: project.id } }),
        db.requirement.count({ where: { projectId: project.id } }),
        db.story.count({ where: { projectId: project.id } }),
        db.architectureOption.count({ where: { projectId: project.id } }),
        db.adr.count({ where: { projectId: project.id } }),
        db.estimate.count({ where: { projectId: project.id } }),
        db.pullRequest.count({ where: { projectId: project.id } }),
        db.testCase.count({ where: { projectId: project.id } }),
        db.bug.count({ where: { projectId: project.id, status: 'OPEN' } }),
        db.plan.findUnique({ where: { projectId: project.id } }),
        db.approval.findMany({ where: { projectId: project.id }, orderBy: { requestedAt: 'desc' } }),
        db.agentRun.aggregate({
          where: { projectId: project.id },
          _count: true,
          _sum: { costUsd: true, inputTokens: true, outputTokens: true, quotaUnits: true },
        }),
      ]);

    res.json({
      project,
      stages: STAGES.map((stage) => ({ key: stage.key, name: stage.name })),
      counts: { documents, requirements, stories, options, adrs, estimates, prs, testCases, bugs },
      plan,
      approvals,
      cost: {
        runs: cost._count,
        usd: cost._sum.costUsd ?? 0,
        tokens: (cost._sum.inputTokens ?? 0) + (cost._sum.outputTokens ?? 0),
        quotaUnits: cost._sum.quotaUnits ?? 0,
      },
    });
  }),
);

api.delete(
  '/projects/:key',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    await db.project.delete({ where: { id: project.id } });
    res.json({ deleted: project.key });
  }),
);

// ── Project content ────────────────────────────────────────────────────────

const NewDocument = z.object({
  title: z.string().min(1),
  kind: z.enum(['MEETING', 'SPEC', 'EMAIL', 'NOTE']).default('NOTE'),
  content: z.string().min(1),
});

api.get(
  '/projects/:key/documents',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    res.json(await db.document.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } }));
  }),
);

api.post(
  '/projects/:key/documents',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    const input = NewDocument.parse(req.body);
    const document = await db.document.create({ data: { projectId: project.id, ...input } });
    await logEvent(project.id, 'DOCUMENT_ADDED', { title: input.title });
    res.status(201).json(document);
  }),
);

api.delete(
  '/projects/:key/documents/:id',
  handle(async (req, res) => {
    await db.document.delete({ where: { id: req.params.id! } });
    res.json({ deleted: req.params.id });
  }),
);

api.get(
  '/projects/:key/requirements',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    res.json(await db.requirement.findMany({ where: { projectId: project.id }, orderBy: { ref: 'asc' } }));
  }),
);

api.get(
  '/projects/:key/stories',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    res.json(
      await db.story.findMany({
        where: { projectId: project.id },
        orderBy: { orderIndex: 'asc' },
        include: { estimates: true },
      }),
    );
  }),
);

api.get(
  '/projects/:key/architecture',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    const [options, adrs] = await Promise.all([
      db.architectureOption.findMany({
        where: { projectId: project.id },
        orderBy: [{ round: 'asc' }, { variant: 'asc' }],
        include: { evaluations: true },
      }),
      db.adr.findMany({ where: { projectId: project.id }, orderBy: { number: 'desc' } }),
    ]);
    res.json({ options, adrs });
  }),
);

/** The code half: one change set per story, with every review round it went through. */
api.get(
  '/projects/:key/code',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    res.json(
      await db.pullRequest.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'asc' },
        include: { story: { select: { ref: true, title: true, status: true } } },
      }),
    );
  }),
);

api.get(
  '/projects/:key/qa',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    const [testCases, bugs] = await Promise.all([
      db.testCase.findMany({
        where: { projectId: project.id },
        orderBy: { ref: 'asc' },
        include: { story: { select: { ref: true } } },
      }),
      db.bug.findMany({
        where: { projectId: project.id },
        orderBy: { ref: 'asc' },
        include: { story: { select: { ref: true } } },
      }),
    ]);
    res.json({ testCases, bugs });
  }),
);

api.get(
  '/projects/:key/events',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    res.json(
      await db.event.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
    );
  }),
);

/** The product-owner run holds the vision, goals, risks and open questions the tables do not. */
api.get(
  '/projects/:key/discovery',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);
    const run = await db.agentRun.findFirst({
      where: { projectId: project.id, agentKey: 'product-owner', status: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
    });
    res.json(run?.output ?? null);
  }),
);

// ── Run control ────────────────────────────────────────────────────────────

/**
 * Start the pipeline. Creating the row *is* starting it — the runner claims anything RUNNABLE on
 * its next tick, so this cannot fail because some orchestrator is down.
 */
api.post(
  '/projects/:key/start',
  handle(async (req, res) => {
    const project = await resolveProject(req.params.key!);

    if (project.run && ['RUNNABLE', 'RUNNING', 'AWAITING_APPROVAL'].includes(project.run.status)) {
      throw new HttpError(400, `${project.key} is already running (${project.run.stage}, ${project.run.status}).`);
    }
    if ((await db.document.count({ where: { projectId: project.id } })) === 0) {
      throw new HttpError(400, 'Add at least one source document before starting the pipeline.');
    }

    // Restarting resets the state machine but keeps the history hanging off agent runs and events.
    const run = await db.pipelineRun.upsert({
      where: { projectId: project.id },
      create: { projectId: project.id },
      update: {
        stage: 'discovery',
        status: 'RUNNABLE',
        iteration: 0,
        attempts: 0,
        spendUsd: 0,
        completedStages: [],
        parkedCode: null,
        parkedReason: null,
        claimedBy: null,
        claimedAt: null,
        finishedAt: null,
      },
    });
    await logEvent(project.id, 'PIPELINE_STARTED', {});
    res.json(run);
  }),
);

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  // Pause only takes effect between stages — an in-flight model call is not interruptible, and
  // saying otherwise in the UI would be a lie.
  pause: { from: ['RUNNABLE', 'RUNNING'], to: 'PAUSED' },
  resume: { from: ['PAUSED', 'PARKED'], to: 'RUNNABLE' },
  cancel: { from: ['RUNNABLE', 'RUNNING', 'AWAITING_APPROVAL', 'PAUSED', 'PARKED'], to: 'CANCELLED' },
};

api.post(
  '/projects/:key/:command',
  handle(async (req, res) => {
    const transition = TRANSITIONS[req.params.command!];
    if (!transition) throw new HttpError(404, `Unknown command "${req.params.command}".`);

    const project = await resolveProject(req.params.key!);
    if (!project.run) throw new HttpError(400, `${project.key} has not been started.`);
    if (!transition.from.includes(project.run.status)) {
      throw new HttpError(400, `Cannot ${req.params.command} a run that is ${project.run.status}.`);
    }

    const run = await db.pipelineRun.update({
      where: { projectId: project.id },
      data: {
        status: transition.to,
        attempts: 0,
        ...(transition.to === 'RUNNABLE' ? { parkedCode: null, parkedReason: null } : {}),
      },
    });
    await logEvent(project.id, `PIPELINE_${req.params.command!.toUpperCase()}D`, {});
    res.json(run);
  }),
);

// ── Approvals ──────────────────────────────────────────────────────────────

api.get(
  '/approvals',
  handle(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'PENDING';
    res.json(
      await db.approval.findMany({
        where: status === 'ALL' ? {} : { status },
        orderBy: { requestedAt: 'desc' },
        take: 100,
        include: { project: { select: { key: true, name: true } } },
      }),
    );
  }),
);

api.get(
  '/approvals/:id',
  handle(async (req, res) => {
    const approval = await db.approval.findUnique({
      where: { id: req.params.id! },
      include: { project: { select: { id: true, key: true, name: true } } },
    });
    if (!approval) throw new HttpError(404, 'No such approval.');

    // The agent runs behind this gate are its provenance: which agent, which model, what it cost.
    const runs = await db.agentRun.findMany({
      where: { projectId: approval.projectId, startedAt: { lte: approval.requestedAt } },
      orderBy: { startedAt: 'desc' },
      take: 8,
    });
    res.json({ approval, provenance: runs });
  }),
);

const Decision = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  decidedBy: z.string().min(1).default('operator'),
  comment: z.string().optional(),
  changeRequests: z
    .array(
      z.object({
        target: z.string().default('backlog'),
        instruction: z.string().min(1),
        severity: z.enum(['MUST', 'SHOULD', 'CONSIDER']).default('MUST'),
      }),
    )
    .default([]),
  /** Architecture only: approve a different option than the one the critic recommended. */
  chosenOptionId: z.string().optional(),
});

api.post(
  '/approvals/:id/decide',
  handle(async (req, res) => {
    const input = Decision.parse(req.body);
    const approval = await db.approval.findUnique({ where: { id: req.params.id! } });
    if (!approval) throw new HttpError(404, 'No such approval.');
    if (approval.status !== 'PENDING') throw new HttpError(400, `This gate is already ${approval.status}.`);
    if (input.decision === 'CHANGES_REQUESTED' && input.changeRequests.length === 0) {
      throw new HttpError(400, 'Requesting changes needs at least one specific change request.');
    }

    await db.approval.update({
      where: { id: approval.id },
      data: {
        status: input.decision,
        decidedAt: new Date(),
        decidedBy: input.decidedBy,
        comment: input.comment ?? null,
        changeRequests: input.changeRequests,
        ...(input.chosenOptionId
          ? { context: { ...(approval.context as object), chosenOptionId: input.chosenOptionId } }
          : {}),
      },
    });

    // Wake the project. The row *is* the mechanism — the decision and the wake-up are one fact,
    // so there is no signal to lose and no window to reconcile.
    const resumed = await db.pipelineRun.updateMany({
      where: { projectId: approval.projectId, status: 'AWAITING_APPROVAL' },
      data: { status: 'RUNNABLE', claimedBy: null, claimedAt: null },
    });

    await logEvent(approval.projectId, 'APPROVAL_DECIDED', {
      gate: approval.gate,
      decision: input.decision,
      by: input.decidedBy,
    });

    res.json({ decided: input.decision, resumed: resumed.count > 0 });
  }),
);

// ── Agent runs ─────────────────────────────────────────────────────────────

api.get(
  '/runs',
  handle(async (req, res) => {
    const projectKey = typeof req.query.project === 'string' ? req.query.project : undefined;
    const projectId = projectKey ? (await resolveProject(projectKey)).id : undefined;

    res.json(
      await db.agentRun.findMany({
        where: projectId ? { projectId } : {},
        orderBy: { startedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          agentKey: true,
          phase: true,
          status: true,
          model: true,
          provider: true,
          authMode: true,
          costUsd: true,
          quotaUnits: true,
          inputTokens: true,
          outputTokens: true,
          durationMs: true,
          summary: true,
          error: true,
          startedAt: true,
          project: { select: { key: true } },
          _count: { select: { toolCalls: true } },
        },
      }),
    );
  }),
);

api.get(
  '/runs/:id',
  handle(async (req, res) => {
    const run = await db.agentRun.findUnique({
      where: { id: req.params.id! },
      include: {
        project: { select: { key: true, name: true } },
        toolCalls: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) throw new HttpError(404, 'No such agent run.');
    res.json(run);
  }),
);

// ── Errors ─────────────────────────────────────────────────────────────────

api.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
    });
    return;
  }
  console.error('[api]', error);
  res.status(500).json({ error: error.message });
});
