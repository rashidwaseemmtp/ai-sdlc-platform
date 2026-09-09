/**
 * MCP — the tool layer.
 *
 * Servers are configured on the dashboard (name, transport, command or URL, environment), and a
 * grant matrix says which agent may call which tools on which server. Both live in the database, so
 * adding a tool to the platform is configuration; deciding who may use it is configuration too.
 *
 * Three rules hold the safety of this together:
 *
 *   1. **Deny by default.** An agent with no grant for a server cannot see its tools, let alone
 *      call them. There is no implicit access and no "admin" agent.
 *   2. **A denial is a tool result, not a crash.** The model is told "permission denied" and adapts;
 *      the attempt is recorded. This is the layer that contains a successful prompt injection — an
 *      agent that "decides" to force-push still gets a refusal and an audit row.
 *   3. **Some things are never grantable.** The deny list below is not configurable from the
 *      dashboard, because a merge or a force-push is exactly what a compromised agent would ask for.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@prisma/client';
import { db } from './db.js';
import type { ToolSpec } from './llm.js';

/**
 * Tool names no grant can ever authorise.
 *
 * Merging is the boundary between "an AI wrote this" and "this is in main", and it belongs to a
 * person. Deleting a repository or rewriting history is unrecoverable. Neither is a judgement the
 * dashboard should be able to override, so neither is in the database.
 */
const NEVER_ALLOWED = [
  /merge/i,
  /force[_-]?push/i,
  /delete[_-]?(repo|repository|branch|project)/i,
  /(^|_)rebase/i,
  /reset[_-]?hard/i,
];

export interface BoundTool extends ToolSpec {
  serverKey: string;
  /** The name on the server, before it was namespaced for the model. */
  toolName: string;
}

export interface ToolContext {
  agentKey: string;
  agentRunId: string;
  /** Per-run call counts, so a grant's ceiling means something. */
  counts: Map<string, number>;
  /** Ceiling across every server for one run. */
  maxCallsPerRun: number;
}

/** `server.tool` — namespaced so two servers can both offer `read_file`. */
export function qualify(serverKey: string, toolName: string): string {
  return `${serverKey}.${toolName}`;
}

function unqualify(name: string): { serverKey: string; toolName: string } | undefined {
  const index = name.indexOf('.');
  if (index <= 0) return undefined;
  return { serverKey: name.slice(0, index), toolName: name.slice(index + 1) };
}

/** Glob match on tool names: `get_*`, `read_file`, `*`. */
function matches(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');
  return regex.test(name);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── connections ────────────────────────────────────────────────────────────

/**
 * One live client per server, kept for the life of the process.
 *
 * A stdio server is a child process; reconnecting per call would spawn one per tool use. The cache
 * is dropped on any transport error so the next call reconnects rather than reusing a dead pipe.
 */
const clients = new Map<string, Client>();

async function connect(server: McpServer): Promise<Client> {
  const existing = clients.get(server.key);
  if (existing) return existing;

  const client = new Client({ name: 'ai-sdlc-platform', version: '1.0.0' }, { capabilities: {} });

  if (server.transport === 'http') {
    if (!server.url) throw new Error(`MCP server "${server.key}" is http but has no URL.`);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  } else {
    if (!server.command) throw new Error(`MCP server "${server.key}" is stdio but has no command.`);
    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: (server.args ?? []) as string[],
        // Only what the server was configured with, plus PATH — a tool server has no business
        // reading this process's provider keys.
        env: {
          PATH: process.env.PATH ?? '',
          ...(server.env as Record<string, string>),
        },
      }),
    );
  }

  clients.set(server.key, client);
  return client;
}

function drop(serverKey: string): void {
  const client = clients.get(serverKey);
  clients.delete(serverKey);
  void client?.close().catch(() => undefined);
}

/** Close everything on shutdown, so stdio children do not outlive the backend. */
export async function closeAllServers(): Promise<void> {
  for (const key of [...clients.keys()]) drop(key);
}

/**
 * Ask a server what it offers, and record the answer.
 *
 * This is what the dashboard's "test connection" button calls, and it is the only way the grant
 * editor knows which tool names exist.
 */
export async function discoverTools(serverKey: string): Promise<{ ok: boolean; tools: ToolSpec[]; error?: string }> {
  const server = await db.mcpServer.findUnique({ where: { key: serverKey } });
  if (!server) return { ok: false, tools: [], error: 'no such server' };

  try {
    drop(serverKey); // always probe a fresh connection, so a stale one cannot report success
    const client = await connect(server);
    const listed = await client.listTools();
    const tools: ToolSpec[] = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }));

    await db.mcpServer.update({
      where: { key: serverKey },
      data: { tools: tools as object, status: 'CONNECTED', error: null, checkedAt: new Date() },
    });
    return { ok: true, tools };
  } catch (error) {
    const message = (error as Error).message;
    drop(serverKey);
    await db.mcpServer.update({
      where: { key: serverKey },
      data: { status: 'ERROR', error: message, checkedAt: new Date() },
    });
    return { ok: false, tools: [], error: message };
  }
}

// ── binding ────────────────────────────────────────────────────────────────

/**
 * The tools one agent may actually see.
 *
 * Built from the grants, filtered through the deny list, and namespaced. An agent is never offered
 * a tool it would then be refused — the refusal path exists for arguments and ceilings, not for
 * tools it should never have been shown.
 */
export async function bindTools(agentKey: string): Promise<BoundTool[]> {
  const grants = await db.mcpGrant.findMany({
    where: { agentKey, enabled: true, server: { enabled: true } },
    include: { server: true },
  });

  const bound: BoundTool[] = [];
  for (const grant of grants) {
    const patterns = (grant.toolPatterns ?? ['*']) as string[];
    const advertised = (grant.server.tools ?? []) as unknown as ToolSpec[];

    for (const tool of advertised) {
      if (!patterns.some((pattern) => matches(tool.name, pattern))) continue;
      if (NEVER_ALLOWED.some((deny) => deny.test(tool.name))) continue;
      bound.push({
        serverKey: grant.serverKey,
        toolName: tool.name,
        name: qualify(grant.serverKey, tool.name),
        description: `[${grant.serverKey}] ${tool.description}`,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return bound;
}

/** Whether this agent has any tools at all — decides which entitlement the run is sent to. */
export async function hasGrants(agentKey: string): Promise<boolean> {
  const count = await db.mcpGrant.count({
    where: { agentKey, enabled: true, server: { enabled: true } },
  });
  return count > 0;
}

// ── calling ────────────────────────────────────────────────────────────────

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/**
 * Execute one tool call on behalf of an agent.
 *
 * Never throws for a refusal or a server-side failure: both come back as an error *result*, which
 * the model can read and work around, and both are written to `tool_calls` either way.
 */
export async function callTool(
  ctx: ToolContext,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const started = Date.now();
  const parsed = unqualify(qualifiedName);

  const record = async (
    serverKey: string,
    toolName: string,
    outcome: 'ALLOWED' | 'DENIED' | 'FAILED',
    preview: string,
    reason?: string,
  ): Promise<void> => {
    await db.toolCall.create({
      data: {
        agentRunId: ctx.agentRunId,
        serverKey,
        toolName,
        args: args as object,
        outcome,
        reason: reason ?? null,
        preview: preview.slice(0, 2000),
        durationMs: Date.now() - started,
      },
    });
  };

  if (!parsed) {
    await record('?', qualifiedName, 'DENIED', '', 'unrecognised tool name');
    return { content: `Unknown tool: ${qualifiedName}`, isError: true };
  }
  const { serverKey, toolName } = parsed;

  const deny = async (reason: string): Promise<ToolOutcome> => {
    await record(serverKey, toolName, 'DENIED', '', reason);
    return { content: `Permission denied: ${reason}`, isError: true };
  };

  if (NEVER_ALLOWED.some((pattern) => pattern.test(toolName))) {
    return deny(
      `"${toolName}" is on the platform's permanent deny list. Merging, force-pushing and deleting ` +
        'are decisions for a person, and no grant can authorise them.',
    );
  }

  const total = [...ctx.counts.values()].reduce((sum, count) => sum + count, 0);
  if (total >= ctx.maxCallsPerRun) {
    return deny(`this run has used its ceiling of ${ctx.maxCallsPerRun} tool calls`);
  }

  const grant = await db.mcpGrant.findUnique({
    where: { agentKey_serverKey: { agentKey: ctx.agentKey, serverKey } },
    include: { server: true },
  });

  if (!grant || !grant.enabled || !grant.server.enabled) {
    return deny(`${ctx.agentKey} has no enabled grant for the "${serverKey}" server`);
  }
  const patterns = (grant.toolPatterns ?? []) as string[];
  if (!patterns.some((pattern) => matches(toolName, pattern))) {
    return deny(`"${toolName}" is outside the granted patterns (${patterns.join(', ')})`);
  }

  const used = ctx.counts.get(serverKey) ?? 0;
  if (used >= grant.maxCallsPerRun) {
    return deny(`the ${serverKey} grant allows ${grant.maxCallsPerRun} calls per run`);
  }
  ctx.counts.set(serverKey, used + 1);

  try {
    const client = await connect(grant.server);
    const result = await client.callTool({ name: toolName, arguments: args });
    const content = renderResult(result);
    await record(serverKey, toolName, result.isError ? 'FAILED' : 'ALLOWED', content);
    return { content, isError: Boolean(result.isError) };
  } catch (error) {
    const message = (error as Error).message;
    drop(serverKey); // the connection may be dead; the next call reconnects
    await record(serverKey, toolName, 'FAILED', '', message);
    return { content: `The ${serverKey} server failed: ${message}`, isError: true };
  }
}

/** Flatten an MCP result into the text the model sees. */
function renderResult(result: unknown): string {
  const content = (result as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return JSON.stringify(result ?? {});

  return content
    .map((block) => {
      const typed = block as { type?: string; text?: string };
      if (typed.type === 'text') return typed.text ?? '';
      // Images and blobs are described rather than inlined; a base64 payload in the transcript
      // costs a fortune in tokens and tells the model nothing it can act on.
      return `[${typed.type ?? 'content'}]`;
    })
    .join('\n')
    .trim();
}
