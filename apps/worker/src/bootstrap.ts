/**
 * Composition root.
 *
 * Every dependency in the platform is constructed here, once, from configuration. Nothing else
 * reads `process.env` or decides which provider to use — which is what makes `DEMO_MODE` a single
 * switch rather than a thread of conditionals through the codebase.
 */

import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import {
  assertProvidersAvailable,
  loadEnv,
  loadFileConfig,
  repoPath,
  type FileConfig,
} from '@sdlc/shared/node';
import type {
  Env,
  CatalogEntry,
  McpGrant,
  McpServerConfig,
  ModelProvider,
} from '@sdlc/shared';
import { getPrisma } from '@sdlc/database';
import { getLogger, registerSecret } from '@sdlc/observability';
import { MockModelProvider, createProvider } from '@sdlc/ai-providers';
import {
  CapacitySemaphore,
  CircuitBreaker,
  InMemoryBreakerStore,
  InMemorySemaphoreStore,
  ModelRouter,
  RedisBreakerStore,
  RedisSemaphoreStore,
} from '@sdlc/ai-router';
import { McpManager, defaultGrants, DEFAULT_DENIED_PATHS } from '@sdlc/mcp-manager';
import { MockGitHub, MockPlaywright, createMockFigma } from '@sdlc/mcp-servers';
import {
  ContextEngine,
  HashEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  workspaceResolvers,
  type EmbeddingProvider,
} from '@sdlc/context';
import { AgentRuntime, ArtifactStore, PromptRegistry } from '@sdlc/agent-runtime';
import { buildAgentRegistry, registerDemoHandlers } from '@sdlc/agents';
import { createActivities, type ActivityDeps } from '@sdlc/activities';

const log = getLogger({ component: 'bootstrap' });

export interface Platform {
  env: Env;
  config: FileConfig;
  deps: ActivityDeps;
  activities: ReturnType<typeof createActivities>;
  redis: Redis | undefined;
  mock: MockModelProvider | undefined;
  mocks: { github: MockGitHub; playwright: MockPlaywright } | undefined;
  shutdown(): Promise<void>;
}

export async function bootstrap(): Promise<Platform> {
  const env = loadEnv();
  assertProvidersAvailable(env);

  const config = loadFileConfig(repoPath('config'));
  const prisma = getPrisma();

  // Register every resolved secret so the redaction filter can catch it in logs and audit rows.
  for (const value of [
    env.ANTHROPIC_API_KEY,
    env.OPENAI_API_KEY,
    env.GOOGLE_API_KEY,
    env.OPENROUTER_API_KEY,
    env.GITHUB_TOKEN,
    env.FIGMA_TOKEN,
    env.JIRA_TOKEN,
    env.LINEAR_API_KEY,
  ]) {
    registerSecret(value);
  }

  // ── event bus ────────────────────────────────────────────────────────────
  let redis: Redis | undefined;
  try {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    await redis.connect();
  } catch (error) {
    log.warn({ error: (error as Error).message }, 'Redis unavailable; running with in-memory state');
    redis = undefined;
  }

  const publish = async (topic: string, payload: unknown): Promise<void> => {
    if (!redis) return;
    try {
      await redis.xadd('sdlc:events', '*', 'topic', topic, 'payload', JSON.stringify(payload));
    } catch (error) {
      // A dropped notification must never fail the work that produced it; the durable record is
      // already in domain_events.
      log.warn({ error: (error as Error).message, topic }, 'failed to publish event');
    }
  };

  // ── model providers and router ───────────────────────────────────────────
  const providers = new Map<string, ModelProvider>();
  let mock: MockModelProvider | undefined;

  for (const [key, providerConfig] of Object.entries(config.models.providers)) {
    if (!providerConfig.enabled && !(env.DEMO_MODE && key === 'mock')) continue;

    if (key === 'mock') {
      mock = new MockModelProvider();
      providers.set('mock', mock);
      continue;
    }

    providers.set(
      key,
      createProvider({
        key,
        enabled: providerConfig.enabled,
        billingMode: providerConfig.billingMode,
        ...(resolveSecret(providerConfig.secretRef, env) ? { apiKey: resolveSecret(providerConfig.secretRef, env)! } : {}),
        ...(providerConfig.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
        ...(providerConfig.command ? { command: providerConfig.command } : {}),
        seats: providerConfig.seats,
      }),
    );
  }

  const catalog: CatalogEntry[] = config.models.catalog
    .filter((entry) => providers.has(entry.providerKey))
    .map((entry) => ({
      ...entry,
      capabilities: entry.capabilities as CatalogEntry['capabilities'],
      // In demo mode only the mock is usable, whatever the catalog says.
      enabled: env.DEMO_MODE ? entry.providerKey === 'mock' : entry.enabled,
    }));

  const breakerStore = redis ? new RedisBreakerStore(redis) : new InMemoryBreakerStore();
  const semaphoreStore = redis ? new RedisSemaphoreStore(redis) : new InMemorySemaphoreStore();

  const router = new ModelRouter({
    catalog,
    providers,
    breaker: new CircuitBreaker(breakerStore, { cooldownSeconds: env.PROVIDER_COOLDOWN_SECONDS }),
    semaphore: new CapacitySemaphore(semaphoreStore),
  });

  // ── MCP ──────────────────────────────────────────────────────────────────
  const mcp = new McpManager({
    resolveSecrets: async (envRefs) => {
      const resolved: Record<string, string> = {};
      for (const [name, ref] of Object.entries(envRefs)) {
        const value = resolveSecret(ref, env);
        if (value) resolved[name] = value;
      }
      return resolved;
    },
    recordToolCall: async (record) => {
      await prisma.toolCall.create({
        data: {
          agentRunId: record.agentRunId,
          // Ordinal is per run; a count query keeps it monotonic without a workflow-side counter.
          ordinal: await prisma.toolCall.count({ where: { agentRunId: record.agentRunId } }),
          serverKey: record.serverKey,
          serverRevision: record.serverRevision,
          toolName: record.toolName,
          argumentsRedacted: record.argumentsRedacted as object,
          status: record.status,
          permissionDecision: record.permissionDecision,
          ...(record.denyReason ? { denyReason: record.denyReason } : {}),
          durationMs: record.durationMs,
          ...(record.error ? { error: record.error } : {}),
          ...(record.resultSummary ? { resultSummary: record.resultSummary } : {}),
        },
      });
    },
    defaultDeniedPaths: DEFAULT_DENIED_PATHS,
  });

  let mocks: { github: MockGitHub; playwright: MockPlaywright } | undefined;

  for (const [key, serverConfig] of Object.entries(config.mcp.servers)) {
    const server: McpServerConfig = {
      key,
      name: serverConfig.name ?? key,
      transport: serverConfig.transport,
      ...(serverConfig.command ? { command: serverConfig.command } : {}),
      args: serverConfig.args,
      ...(serverConfig.url ? { url: serverConfig.url } : {}),
      env: serverConfig.env,
      config: serverConfig.config,
      enabled: serverConfig.enabled,
      revision: 1,
    };
    await mcp.register(server);
  }

  if (env.DEMO_MODE) {
    // Demo mode swaps the far side of the transport, not the code path: the manager still binds
    // tools, still checks permissions, still audits every call.
    const github = new MockGitHub();
    const playwright = new MockPlaywright();
    mocks = { github, playwright };

    // Seed the mock with the repositories actually attached to projects. It deliberately does not
    // auto-create on demand: a wrong repository name must still fail, exactly as it would against
    // the real GitHub.
    for (const repository of await prisma.projectRepository.findMany()) {
      github.ensureRepo(repoFullName(repository.url), {
        'README.md': `# ${repository.key}

Seeded by demo mode.
`,
        'package.json': JSON.stringify({ name: repository.key, scripts: {} }, null, 2),
      });
    }

    mcp.registerMock(github.server(), {
      name: 'GitHub (mock)',
      transport: 'stdio',
      args: [],
      env: {},
      config: {},
      enabled: true,
      revision: 1,
    });
    mcp.registerMock(createMockFigma(), {
      name: 'Figma (mock)',
      transport: 'stdio',
      args: [],
      env: {},
      config: {},
      enabled: true,
      revision: 1,
    });
    mcp.registerMock(playwright.server(), {
      name: 'Playwright (mock)',
      transport: 'stdio',
      args: [],
      env: {},
      config: {},
      enabled: true,
      revision: 1,
    });
  }

  // ── context ──────────────────────────────────────────────────────────────
  const embeddings: EmbeddingProvider = env.DEMO_MODE
    ? new HashEmbeddingProvider(env.EMBEDDING_DIMENSIONS)
    : env.OPENAI_API_KEY
      ? new OpenAICompatibleEmbeddingProvider('text-embedding-3-small', env.EMBEDDING_DIMENSIONS, {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: env.OPENAI_API_KEY,
        })
      : new HashEmbeddingProvider(env.EMBEDDING_DIMENSIONS);

  const workspaceRoot = resolve(repoPath('.'), env.WORKSPACE_ROOT);

  const context = new ContextEngine({
    prisma,
    embeddings,
    // Filesystem-backed sections are injected, so the context package itself stays free of repo I/O.
    gitResolvers: workspaceResolvers({
      workspaceRoot,
      projectDir: async (projectId) =>
        (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).key,
      repositories: async (projectId) =>
        prisma.projectRepository.findMany({ where: { projectId }, select: { key: true, role: true } }),
      readArtifact: async (versionId) =>
        (await prisma.artifactVersion.findUnique({ where: { id: versionId } }))?.contentJson,
    }),
  });

  // ── agents ───────────────────────────────────────────────────────────────
  const prompts = new PromptRegistry(repoPath('prompts'));
  const artifacts = new ArtifactStore(prisma);
  const registry = buildAgentRegistry();
  const grants: McpGrant[] = defaultGrants();

  if (mock) registerDemoHandlers(mock);

  const runtime = new AgentRuntime(registry, {
    prisma,
    router,
    mcp,
    context,
    prompts,
    artifacts,
    grants,
    workspaceRoot,
    onProgress: async (progress) => {
      await publish('agent.progress', progress);
    },
  });

  const deps: ActivityDeps = {
    prisma,
    runtime,
    registry,
    router,
    mcp,
    context,
    embeddings,
    prompts,
    artifacts,
    grants,
    workspaceRoot,
    publish,
    limits: {
      maxPrFixIterations: env.MAX_PR_FIX_ITERATIONS,
      maxQaFixIterations: env.MAX_QA_FIX_ITERATIONS,
      maxBuildFixIterations: env.MAX_BUILD_FIX_ITERATIONS,
      maxBacklogRevisions: env.MAX_BACKLOG_REVISIONS,
      maxArchitectureRounds: env.MAX_ARCHITECTURE_ROUNDS,
      maxParallelStories: env.MAX_PARALLEL_STORIES,
      maxWorkflowCostUsd: env.MAX_WORKFLOW_COST_USD,
      estimationVarianceThreshold: env.ESTIMATION_VARIANCE_THRESHOLD,
      approvalDefaultTimeoutHours: env.APPROVAL_DEFAULT_TIMEOUT_HOURS,
    },
    aiMergePermission: env.AI_MERGE_PERMISSION,
  };

  log.info(
    {
      demoMode: env.DEMO_MODE,
      providers: [...providers.keys()],
      catalog: catalog.filter((c) => c.enabled).length,
      agents: registry.keys().length,
      mcpServers: mcp.listServers().length,
      aiMerge: env.AI_MERGE_PERMISSION,
    },
    'platform bootstrapped',
  );

  return {
    env,
    config,
    deps,
    activities: createActivities(deps),
    redis,
    mock,
    mocks,
    async shutdown() {
      await mcp.closeAll();
      redis?.disconnect();
      await prisma.$disconnect();
    },
  };
}

function repoFullName(url: string): string {
  const match = /[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return match?.[1] ?? url;
}

/** `env:NAME` and `secret:name` references. Values never live in config files. */
function resolveSecret(ref: string | undefined, env: Env): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith('env:')) {
    return (env as unknown as Record<string, string | undefined>)[ref.slice(4)];
  }
  if (ref.startsWith('secret:')) {
    return process.env[ref.slice(7).toUpperCase()];
  }
  return ref;
}
