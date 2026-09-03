/**
 * Agent runs, workflows, artifacts, events, configuration and the SSE stream.
 *
 * This is the observability surface from docs/44: what is running, what it cost, what it decided,
 * and why.
 */

import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
  Sse,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { metrics } from '@sdlc/observability';
import { defaultGrants } from '@sdlc/mcp-manager';
import { ConfigService, EventsService, PrismaService, TemporalService } from './core.js';

@Controller('api/v1')
export class PlatformController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TemporalService) private readonly temporal: TemporalService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  @Get('health')
  async health() {
    const started = Date.now();
    let database = 'down';
    try {
      await this.db.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      temporal: this.temporal.available ? 'up' : 'down',
      demoMode: this.config.env.DEMO_MODE,
      aiMergePermission: this.config.env.AI_MERGE_PERMISSION,
      latencyMs: Date.now() - started,
    };
  }

  @Get('metrics')
  metricsSnapshot() {
    return metrics.snapshot();
  }

  // ── agents ───────────────────────────────────────────────────────────────

  @Get('agents')
  async agents() {
    const routing = this.config.config.models.routing;
    const grants = defaultGrants();

    const runs = await this.db.agentRun.groupBy({
      by: ['agentKey', 'status'],
      _count: true,
      _sum: { totalCostUsd: true },
    });

    const keys = [...new Set([...Object.keys(routing).filter((k) => k !== 'defaults'), ...runs.map((r) => r.agentKey)])];

    return {
      data: keys.map((agentKey) => {
        const agentRuns = runs.filter((r) => r.agentKey === agentKey);
        return {
          key: agentKey,
          routing: routing[agentKey] ?? routing.defaults,
          grants: grants
            .filter((g) => g.agentKey === agentKey)
            .map((g) => ({ server: g.serverKey, tools: g.toolPattern, scopes: g.scopes })),
          // Surfaced explicitly so an operator can see that nobody holds it (invariant I7).
          canMerge: grants.some((g) => g.agentKey === agentKey && g.scopes.includes('pull_request.merge')),
          runs: agentRuns.reduce((sum, r) => sum + r._count, 0),
          failed: agentRuns.filter((r) => r.status !== 'SUCCEEDED').reduce((sum, r) => sum + r._count, 0),
          costUsd: Number(agentRuns.reduce((sum, r) => sum + (r._sum.totalCostUsd ?? 0), 0).toFixed(4)),
        };
      }),
    };
  }

  @Get('agent-runs')
  async agentRuns(
    @Query('projectId') projectId?: string,
    @Query('agentKey') agentKey?: string,
    @Query('status') status?: string,
    @Query('limit') limit = '50',
  ) {
    return {
      data: await this.db.agentRun.findMany({
        where: {
          ...(projectId ? { projectId } : {}),
          ...(agentKey ? { agentKey } : {}),
          ...(status ? { status: status as 'SUCCEEDED' } : {}),
        },
        select: {
          id: true,
          agentKey: true,
          phase: true,
          status: true,
          startedAt: true,
          durationMs: true,
          totalCostUsd: true,
          totalTokens: true,
          error: true,
          project: { select: { key: true } },
        },
        orderBy: { startedAt: 'desc' },
        take: Math.min(200, Number(limit) || 50),
      }),
    };
  }

  /** The full audit record for one run — docs/43. */
  @Get('agent-runs/:id')
  async agentRun(@Param('id') id: string) {
    const run = await this.db.agentRun.findUnique({
      where: { id },
      include: {
        promptVersion: { select: { version: true, sha256: true, path: true } },
        llmCalls: { orderBy: { ordinal: 'asc' } },
        toolCalls: { orderBy: { ordinal: 'asc' } },
        artifactVersions: { include: { artifact: { select: { kind: true, name: true } } } },
        project: { select: { key: true, name: true } },
      },
    });
    if (!run) throw new NotFoundException(`agent run ${id} not found`);
    return { data: run };
  }

  // ── workflows ────────────────────────────────────────────────────────────

  @Get('workflows')
  async workflows(@Query('projectId') projectId?: string) {
    return {
      data: await this.db.workflowRun.findMany({
        where: projectId ? { projectId } : {},
        orderBy: { startedAt: 'desc' },
        take: 100,
      }),
    };
  }

  @Get('workflows/:workflowId')
  async workflow(@Param('workflowId') workflowId: string) {
    const record = await this.db.workflowRun.findFirst({
      where: { workflowId },
      orderBy: { startedAt: 'desc' },
    });

    let live: unknown = null;
    if (this.temporal.available) {
      try {
        const handle = this.temporal.client.workflow.getHandle(workflowId);
        const description = await handle.describe();
        live = {
          status: description.status.name,
          historyLength: description.historyLength,
          startTime: description.startTime,
          closeTime: description.closeTime,
        };
      } catch {
        live = { status: 'NOT_FOUND' };
      }
    }
    return { data: { record, live } };
  }

  // ── artifacts, lineage, events ───────────────────────────────────────────

  @Get('projects/:projectId/artifacts')
  async artifacts(@Param('projectId') projectId: string) {
    return {
      data: await this.db.artifact.findMany({
        where: { projectId },
        include: {
          versions: {
            select: { id: true, version: true, status: true, createdAt: true, contentSha256: true },
            orderBy: { version: 'desc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    };
  }

  @Get('artifacts/:artifactId/versions/:version')
  async artifactVersion(@Param('artifactId') artifactId: string, @Param('version') version: string) {
    const record = await this.db.artifactVersion.findUnique({
      where: { artifactId_version: { artifactId, version: Number(version) } },
      include: { artifact: true, producedByRun: { select: { agentKey: true, startedAt: true } } },
    });
    if (!record) throw new NotFoundException('artifact version not found');
    return { data: record };
  }

  @Get('projects/:projectId/events')
  async events_(@Param('projectId') projectId: string, @Query('limit') limit = '100') {
    const rows = await this.db.domainEvent.findMany({
      where: { projectId },
      orderBy: { sequence: 'desc' },
      take: Math.min(500, Number(limit) || 100),
    });
    // BigInt sequences are not JSON-serialisable.
    return { data: rows.map((row) => ({ ...row, sequence: row.sequence.toString() })) };
  }

  /**
   * Live updates. SSE rather than WebSockets: the traffic is server-to-client only, it survives
   * proxies, and it reconnects with Last-Event-ID for free.
   */
  @Sse('events/stream')
  @Header('Cache-Control', 'no-cache')
  stream(@Query('projectId') projectId?: string): Observable<{ data: string; type: string; id: string }> {
    return new Observable((subscriber) => {
      const unsubscribe = this.events.subscribe((frame) => {
        if (projectId && frame.projectId && frame.projectId !== projectId) return;
        subscriber.next({ id: frame.id, type: frame.type, data: JSON.stringify(frame) });
      });

      const keepAlive = setInterval(() => {
        subscriber.next({ id: '0', type: 'ping', data: JSON.stringify({ at: new Date().toISOString() }) });
      }, 25_000);

      return () => {
        clearInterval(keepAlive);
        unsubscribe();
      };
    });
  }

  // ── configuration ────────────────────────────────────────────────────────

  @Get('models')
  async models() {
    const [providers, catalog] = await Promise.all([
      this.db.modelProviderConfig.findMany({ orderBy: { key: 'asc' } }),
      this.db.modelCatalogEntry.findMany({ orderBy: [{ tier: 'desc' }, { modelId: 'asc' }] }),
    ]);
    return {
      data: {
        providers,
        catalog,
        routing: this.config.config.models.routing,
        // Config declares far more than the database has seen; show both so the gap is visible.
        configured: Object.keys(this.config.config.models.providers),
      },
    };
  }

  @Get('mcp/servers')
  async mcpServers() {
    const configured = Object.entries(this.config.config.mcp.servers).map(([key, server]) => ({
      key,
      name: server.name ?? key,
      transport: server.transport,
      enabled: server.enabled,
      permissions: server.permissions,
      backend: (server.config as { backend?: string })?.backend,
    }));
    const grants = defaultGrants();

    return {
      data: {
        servers: configured,
        grants: grants.map((g) => ({
          agentKey: g.agentKey,
          server: g.serverKey,
          tools: g.toolPattern,
          scopes: g.scopes,
          argumentPolicy: g.argumentPolicy,
        })),
      },
    };
  }

  @Get('settings')
  settings() {
    const env = this.config.env;
    // Values only — never a secret. Secrets are referenced by name and are write-only.
    return {
      data: {
        demoMode: env.DEMO_MODE,
        aiMergePermission: env.AI_MERGE_PERMISSION,
        limits: this.config.config.workflows.limits,
        gates: this.config.config.workflows.approvalGates,
        secretsConfigured: {
          anthropic: Boolean(env.ANTHROPIC_API_KEY),
          openai: Boolean(env.OPENAI_API_KEY),
          google: Boolean(env.GOOGLE_API_KEY),
          openrouter: Boolean(env.OPENROUTER_API_KEY),
          github: Boolean(env.GITHUB_TOKEN),
          figma: Boolean(env.FIGMA_TOKEN),
        },
      },
    };
  }

  @Get('users')
  async users() {
    return {
      data: await this.db.user.findMany({
        select: { id: true, email: true, name: true, role: true },
        orderBy: { role: 'asc' },
      }),
    };
  }

  @Get('openapi.json')
  openapi(@Res() res: Response): void {
    res.json({
      openapi: '3.1.0',
      info: { title: 'AI SDLC Platform API', version: '0.1.0' },
      paths: {},
      'x-note': 'Generated at runtime by @nestjs/swagger in the full build; see docs/10-api-spec.md.',
    });
  }
}
