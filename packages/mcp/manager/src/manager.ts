/**
 * MCP Manager — docs/06 §1.
 *
 * The single path from an agent to the outside world. It owns server lifecycle, tool discovery,
 * health, permission mediation and audit. `bindTools` returns only what an agent may see;
 * `callTool` re-checks at call time because tool sets are cached and a grant can be revoked
 * between binding and invocation.
 */

import {
  FailureCode,
  PlatformError,
  PermissionDeniedError,
  qualifyToolName,
  type BoundTool,
  type HealthReport,
  type InvocationContext,
  type McpGrant,
  type McpServerConfig,
  type McpServerKey,
  type McpToolSchema,
  type ToolResult,
  type ToolSet,
} from '@sdlc/shared';
import { McpClient, MockMcpServer, type McpConnection } from '@sdlc/mcp-core';
import { getLogger, metrics, redact } from '@sdlc/observability';
import { PermissionEngine, type PermissionRequest } from './permission-engine.js';

const log = getLogger({ component: 'mcp-manager' });

export interface ToolCallAuditRecord {
  agentRunId: string;
  serverKey: McpServerKey;
  serverRevision: number;
  toolName: string;
  argumentsRedacted: Record<string, unknown>;
  status: 'SUCCESS' | 'FAILED' | 'DENIED' | 'TIMEOUT';
  permissionDecision: 'ALLOWED' | 'DENIED';
  denyReason?: string;
  durationMs: number;
  error?: string;
  resultSummary?: string;
}

export interface McpManagerDeps {
  /** Resolves `secret:foo` / `env:FOO` references at connect time. Never stores values. */
  resolveSecrets(env: Record<string, string>): Promise<Record<string, string>>;
  /** Persists an audit row. Injected so the manager stays free of a database dependency. */
  recordToolCall(record: ToolCallAuditRecord): Promise<void>;
  defaultDeniedPaths?: string[];
  idleTtlMs?: number;
  callTimeoutMs?: number;
}

export class McpManager {
  private configs = new Map<McpServerKey, McpServerConfig>();
  private connections = new Map<McpServerKey, McpConnection>();
  private toolCache = new Map<McpServerKey, McpToolSchema[]>();
  private health = new Map<McpServerKey, HealthReport>();
  private failureCounts = new Map<McpServerKey, number>();
  private permissions: PermissionEngine;

  constructor(private readonly deps: McpManagerDeps) {
    this.permissions = new PermissionEngine(deps.defaultDeniedPaths ?? []);
  }

  // ── registry ─────────────────────────────────────────────────────────────

  async register(config: McpServerConfig): Promise<void> {
    this.configs.set(config.key, config);
    this.toolCache.delete(config.key);
    log.info({ serverKey: config.key, transport: config.transport }, 'MCP server registered');
  }

  /** Register an in-process mock. Selected by configuration, so the real code path is exercised. */
  registerMock(server: MockMcpServer, config: Omit<McpServerConfig, 'key'>): void {
    const full: McpServerConfig = { ...config, key: server.serverKey };
    this.configs.set(full.key, full);
    this.connections.set(full.key, server);
    this.toolCache.delete(full.key);
  }

  async unregister(key: McpServerKey): Promise<void> {
    await this.connections.get(key)?.close();
    this.connections.delete(key);
    this.configs.delete(key);
    this.toolCache.delete(key);
    this.health.delete(key);
  }

  async enable(key: McpServerKey): Promise<void> {
    const config = this.requireConfig(key);
    this.configs.set(key, { ...config, enabled: true });
  }

  async disable(key: McpServerKey): Promise<void> {
    const config = this.requireConfig(key);
    this.configs.set(key, { ...config, enabled: false });
    await this.connections.get(key)?.close();
    this.connections.delete(key);
  }

  /** Config changes bump the revision, which is recorded on every audit row. */
  async configure(key: McpServerKey, patch: Partial<McpServerConfig>): Promise<void> {
    const config = this.requireConfig(key);
    this.configs.set(key, { ...config, ...patch, revision: config.revision + 1 });
    await this.connections.get(key)?.close();
    this.connections.delete(key);
    this.toolCache.delete(key);
  }

  listServers(): McpServerConfig[] {
    return [...this.configs.values()];
  }

  // ── discovery and health ─────────────────────────────────────────────────

  async discoverTools(key: McpServerKey, force = false): Promise<McpToolSchema[]> {
    if (!force) {
      const cached = this.toolCache.get(key);
      if (cached) return cached;
    }
    const connection = await this.connect(key);
    const tools = await connection.listTools();
    this.toolCache.set(key, tools);
    return tools;
  }

  async inspectSchema(key: McpServerKey, tool: string): Promise<Record<string, unknown>> {
    const tools = await this.discoverTools(key);
    const found = tools.find((t) => t.name === tool);
    if (!found) {
      throw new PlatformError({
        code: FailureCode.NOT_FOUND,
        message: `tool "${tool}" not found on server "${key}"`,
      });
    }
    return found.inputSchema;
  }

  async checkHealth(key?: McpServerKey): Promise<HealthReport[]> {
    const keys = key ? [key] : [...this.configs.keys()];
    const reports: HealthReport[] = [];

    for (const serverKey of keys) {
      const config = this.configs.get(serverKey);
      if (!config?.enabled) {
        reports.push(this.setHealth(serverKey, 'UNKNOWN', 'server disabled'));
        continue;
      }
      const started = Date.now();
      try {
        const connection = await this.connect(serverKey);
        const tools = await connection.listTools();
        this.failureCounts.delete(serverKey);
        reports.push(
          this.setHealth(serverKey, 'HEALTHY', undefined, {
            toolCount: tools.length,
            latencyMs: Date.now() - started,
          }),
        );
      } catch (error) {
        // Three strikes to UNHEALTHY — one blip should not remove a server from binding.
        const strikes = (this.failureCounts.get(serverKey) ?? 0) + 1;
        this.failureCounts.set(serverKey, strikes);
        reports.push(
          this.setHealth(
            serverKey,
            strikes >= 3 ? 'UNHEALTHY' : 'DEGRADED',
            (error as Error).message,
            { latencyMs: Date.now() - started },
          ),
        );
      }
    }
    return reports;
  }

  getHealth(key: McpServerKey): HealthReport | undefined {
    return this.health.get(key);
  }

  /** Close connections that have been idle past the TTL — MCP servers are child processes. */
  async reapIdle(): Promise<number> {
    const ttl = this.deps.idleTtlMs ?? 300_000;
    let closed = 0;
    for (const [key, connection] of this.connections) {
      if (connection.idleMs > ttl && !(connection instanceof MockMcpServer)) {
        await connection.close();
        this.connections.delete(key);
        closed += 1;
      }
    }
    return closed;
  }

  // ── permissions ──────────────────────────────────────────────────────────

  /**
   * Return only the tools this agent is granted, namespaced for the model. An agent cannot see,
   * let alone call, a tool it lacks (invariant I5).
   */
  async bindTools(
    grants: McpGrant[],
    options: { requiredServers?: McpServerKey[] } = {},
  ): Promise<ToolSet> {
    const bound: BoundTool[] = [];
    const serverKeys = [...new Set(grants.map((g) => g.serverKey))];

    for (const serverKey of serverKeys) {
      const config = this.configs.get(serverKey);
      if (!config?.enabled) {
        if (options.requiredServers?.includes(serverKey)) {
          throw new PlatformError({
            code: FailureCode.MCP_DISABLED,
            message: `required MCP server "${serverKey}" is disabled`,
            details: { serverKey },
          });
        }
        continue;
      }

      let tools: McpToolSchema[];
      try {
        tools = await this.discoverTools(serverKey);
      } catch (error) {
        if (options.requiredServers?.includes(serverKey)) throw error;
        log.warn({ serverKey, error: (error as Error).message }, 'skipping unavailable MCP server');
        continue;
      }

      const visible = this.permissions.visibleTools(
        grants,
        serverKey,
        tools.map((t) => t.name),
      );

      for (const tool of tools.filter((t) => visible.includes(t.name))) {
        bound.push({
          qualifiedName: qualifyToolName(serverKey, tool.name),
          serverKey,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return bound;
  }

  /**
   * Call a tool. Permission is re-checked here, and every outcome — including a denial — is
   * audited. A denial is non-retryable: it is a configuration bug or an attempted overreach, and
   * retrying it is never right.
   */
  async callTool(
    ctx: InvocationContext,
    serverKey: McpServerKey,
    toolName: string,
    args: Record<string, unknown>,
    options: {
      projectRepositories?: string[];
      workspaceRoot?: string;
      /**
       * Platform-initiated calls set this so a tool error fails the activity instead of being
       * returned as a value. Agent tool loops leave it false: there, an error is feedback the
       * model should adapt to, not a crash.
       */
      throwOnToolError?: boolean;
    } = {},
  ): Promise<ToolResult> {
    const started = Date.now();
    const config = this.configs.get(serverKey);

    const request: PermissionRequest = {
      agentKey: ctx.agentKey,
      projectId: ctx.projectId,
      serverKey,
      toolName,
      args,
      callCounts: ctx.callCounts,
      ...(options.projectRepositories ? { projectRepositories: options.projectRepositories } : {}),
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    };

    const verdict = this.permissions.check(request, ctx.grants);
    if (!verdict.allowed) {
      await this.audit({
        agentRunId: ctx.agentRunId,
        serverKey,
        serverRevision: config?.revision ?? 0,
        toolName,
        argumentsRedacted: redact(args),
        status: 'DENIED',
        permissionDecision: 'DENIED',
        denyReason: verdict.reason,
        durationMs: Date.now() - started,
      });
      metrics.increment('mcp.denied', 1, { server: serverKey, tool: toolName });
      throw new PermissionDeniedError({
        agentKey: ctx.agentKey,
        serverKey,
        toolName,
        reason: verdict.reason,
        ...verdict.detail,
      });
    }

    if (!config?.enabled) {
      throw new PlatformError({
        code: FailureCode.MCP_DISABLED,
        message: `MCP server "${serverKey}" is disabled`,
        details: { serverKey },
      });
    }

    const countKey = `${serverKey}:${toolName}`;
    ctx.callCounts[countKey] = (ctx.callCounts[countKey] ?? 0) + 1;

    try {
      const connection = await this.connect(serverKey);
      const result = await this.withTimeout(
        connection.callTool(toolName, args),
        this.deps.callTimeoutMs ?? 120_000,
        `${serverKey}/${toolName}`,
      );
      const durationMs = Date.now() - started;

      await this.audit({
        agentRunId: ctx.agentRunId,
        serverKey,
        serverRevision: config.revision,
        toolName,
        argumentsRedacted: redact(args),
        status: result.isError ? 'FAILED' : 'SUCCESS',
        permissionDecision: 'ALLOWED',
        durationMs,
        resultSummary: summarise(result.content),
      });
      metrics.increment('mcp.calls', 1, { server: serverKey, tool: toolName });

      if (result.isError && options.throwOnToolError) {
        throw new PlatformError({
          code: FailureCode.TOOL_FAILED,
          message: `${serverKey}/${toolName} failed: ${summarise(result.content)}`,
          details: { serverKey, toolName },
        });
      }

      return { content: result.content, isError: result.isError, durationMs };
    } catch (error) {
      const durationMs = Date.now() - started;
      await this.audit({
        agentRunId: ctx.agentRunId,
        serverKey,
        serverRevision: config.revision,
        toolName,
        argumentsRedacted: redact(args),
        status: error instanceof PlatformError && error.code === FailureCode.MCP_UNAVAILABLE
          ? 'TIMEOUT'
          : 'FAILED',
        permissionDecision: 'ALLOWED',
        durationMs,
        error: (error as Error).message,
      });
      metrics.increment('mcp.failures', 1, { server: serverKey, tool: toolName });
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    for (const connection of this.connections.values()) await connection.close();
    this.connections.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async connect(key: McpServerKey): Promise<McpConnection> {
    const existing = this.connections.get(key);
    if (existing?.isConnected) return existing;

    const config = this.requireConfig(key);
    const resolvedEnv = await this.deps.resolveSecrets(config.env ?? {});
    const client = new McpClient(config, resolvedEnv);
    await client.connect();
    this.connections.set(key, client);
    return client;
  }

  private requireConfig(key: McpServerKey): McpServerConfig {
    const config = this.configs.get(key);
    if (!config) {
      throw new PlatformError({
        code: FailureCode.NOT_FOUND,
        message: `MCP server "${key}" is not registered`,
        details: { serverKey: key },
      });
    }
    return config;
  }

  private setHealth(
    serverKey: McpServerKey,
    status: HealthReport['status'],
    message?: string,
    extra: Partial<HealthReport> = {},
  ): HealthReport {
    const report: HealthReport = {
      serverKey,
      status,
      checkedAt: new Date().toISOString(),
      ...(message ? { message } : {}),
      ...extra,
    };
    this.health.set(serverKey, report);
    return report;
  }

  private async audit(record: ToolCallAuditRecord): Promise<void> {
    try {
      await this.deps.recordToolCall(record);
    } catch (error) {
      // An audit failure must never mask the tool result, but it must be visible.
      log.error({ error: (error as Error).message, record }, 'failed to record tool call audit');
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new PlatformError({
                  code: FailureCode.MCP_UNAVAILABLE,
                  message: `MCP call ${label} timed out after ${ms}ms`,
                  details: { label, timeoutMs: ms },
                }),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function summarise(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
