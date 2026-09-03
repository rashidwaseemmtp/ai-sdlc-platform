/**
 * Configuration schema — docs/11-configuration.md.
 *
 * Every value is parsed through Zod at boot. A malformed config fails startup loudly; it never
 * degrades to a silent default, because an invisible default in this system means an agent runs
 * with the wrong model, the wrong budget, or the wrong permissions.
 */

import { z } from 'zod';

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on'].includes(v.toLowerCase())));

const intFromEnv = z.coerce.number().int();
const floatFromEnv = z.coerce.number();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: intFromEnv.default(3001),
  DASHBOARD_PORT: intFromEnv.default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  TEMPORAL_TASK_QUEUE_MAIN: z.string().default('sdlc-main'),
  TEMPORAL_TASK_QUEUE_AGENTS: z.string().default('sdlc-agents'),
  TEMPORAL_TASK_QUEUE_TOOLS: z.string().default('sdlc-tools'),
  TEMPORAL_TASK_QUEUE_HEAVY: z.string().default('sdlc-heavy'),

  // Provider credentials are all optional — DEMO_MODE requires none.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  FIGMA_TOKEN: z.string().optional(),
  JIRA_BASE_URL: z.string().optional(),
  JIRA_TOKEN: z.string().optional(),
  LINEAR_API_KEY: z.string().optional(),

  SECRET_PROVIDER: z.enum(['env', 'file', 'vault', 'aws-kms', 'doppler']).default('env'),
  MASTER_KEY: z.string().optional(),
  WORKSPACE_ROOT: z.string().default('./.workspace'),
  ARTIFACT_STORAGE: z.string().default('./.artifacts'),
  EMBEDDING_DIMENSIONS: intFromEnv.default(1536),

  DEMO_MODE: boolFromEnv.default(true),
  AI_MERGE_PERMISSION: boolFromEnv.default(false),

  MAX_AGENT_RETRIES: intFromEnv.default(3),
  MAX_PR_FIX_ITERATIONS: intFromEnv.default(3),
  MAX_QA_FIX_ITERATIONS: intFromEnv.default(3),
  MAX_BUILD_FIX_ITERATIONS: intFromEnv.default(2),
  MAX_BACKLOG_REVISIONS: intFromEnv.default(3),
  MAX_ARCHITECTURE_ROUNDS: intFromEnv.default(2),
  MAX_PARALLEL_STORIES: intFromEnv.default(3),
  MAX_WORKFLOW_COST_USD: floatFromEnv.default(25),
  MAX_AGENT_COST_USD: floatFromEnv.default(5),
  MAX_AGENT_TOKENS: intFromEnv.default(400_000),
  MAX_AGENT_ITERATIONS: intFromEnv.default(25),
  MAX_AGENT_WALLCLOCK_SECONDS: intFromEnv.default(1200),
  ESTIMATION_VARIANCE_THRESHOLD: floatFromEnv.default(0.3),
  APPROVAL_DEFAULT_TIMEOUT_HOURS: intFromEnv.default(72),
  PROVIDER_COOLDOWN_SECONDS: intFromEnv.default(120),
});

export type Env = z.infer<typeof EnvSchema>;

// ─── config/models.yaml ────────────────────────────────────────────────────

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  billingMode: z.enum(['API_METERED', 'SUBSCRIPTION', 'LOCAL_FREE']),
  kind: z.enum(['API_KEY', 'SUBSCRIPTION', 'LOCAL', 'MOCK']).default('API_KEY'),
  secretRef: z.string().optional(),
  baseUrl: z.string().optional(),
  command: z.string().optional(),
  seats: z.number().int().nonnegative().default(0),
  maxConcurrent: z.number().int().positive().default(4),
  config: z.record(z.unknown()).default({}),
});

export const CatalogEntrySchema = z.object({
  providerKey: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  tier: z.enum(['SMALL', 'MID', 'FRONTIER']),
  capabilities: z.array(z.string()),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  inputCostPer1M: z.number().nonnegative().nullable().default(null),
  outputCostPer1M: z.number().nonnegative().nullable().default(null),
  cachedInputCostPer1M: z.number().nonnegative().nullable().default(null),
  billingMode: z.enum(['API_METERED', 'SUBSCRIPTION', 'LOCAL_FREE']),
  supportsStructuredOutput: z.boolean().default(true),
  supportsToolUse: z.boolean().default(true),
  supportsCaching: z.boolean().default(false),
  supportsStreaming: z.boolean().default(true),
  maxConcurrent: z.number().int().positive().default(4),
  enabled: z.boolean().default(false),
});

export const RoutingPolicySchema = z.object({
  capability: z.string(),
  minimumTier: z.enum(['SMALL', 'MID', 'FRONTIER']).default('MID'),
  preferredProviders: z.array(z.string()).default([]),
  fallbackChain: z.array(z.string()).default([]),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxCostPerRunUsd: z.number().positive().optional(),
  allowSubscription: z.boolean().default(true),
  requireDistinctFrom: z.string().optional(),
});

export const ModelsConfigSchema = z.object({
  providers: z.record(ProviderConfigSchema),
  catalog: z.array(CatalogEntrySchema).default([]),
  routing: z.record(RoutingPolicySchema.partial().extend({ capability: z.string().optional() })),
});

// ─── config/mcp.yaml ───────────────────────────────────────────────────────

export const McpServerConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().default(false),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string()).default({}),
  config: z.record(z.unknown()).default({}),
  permissions: z.array(z.string()).default([]),
});

export const McpConfigSchema = z.object({
  servers: z.record(McpServerConfigSchema),
});

// ─── config/agents.yaml ────────────────────────────────────────────────────

export const AgentBudgetSchema = z.object({
  maxCostUsd: z.number().positive(),
  maxTokens: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxIterations: z.number().int().positive(),
  maxWallClockSeconds: z.number().int().positive(),
});

export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  promptVersion: z.string().default('v1'),
  contextRecipe: z.string().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  budget: AgentBudgetSchema.partial().optional(),
});

export const AgentsConfigSchema = z.object({
  defaults: z.object({
    maxRetries: z.number().int().nonnegative().default(3),
    timeoutSeconds: z.number().int().positive().default(1200),
    budget: AgentBudgetSchema,
  }),
  agents: z.record(AgentConfigSchema).default({}),
});

// ─── config/workflows.yaml ─────────────────────────────────────────────────

export const ApprovalGateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  requiredRole: z.enum(['ADMIN', 'PRODUCT', 'ARCHITECT', 'ENGINEER', 'QA', 'VIEWER']),
  timeoutHours: z.number().int().positive().default(72),
  autoApprove: z.boolean().default(false),
});

export const WorkflowsConfigSchema = z.object({
  approvalGates: z.record(ApprovalGateConfigSchema),
  limits: z.object({
    maxPrFixIterations: z.number().int().positive().default(3),
    maxQaFixIterations: z.number().int().positive().default(3),
    maxBuildFixIterations: z.number().int().positive().default(2),
    maxBacklogRevisions: z.number().int().positive().default(3),
    maxArchitectureRounds: z.number().int().positive().default(2),
    maxParallelStories: z.number().int().positive().default(3),
    maxWorkflowCostUsd: z.number().positive().default(25),
    estimationVarianceThreshold: z.number().positive().default(0.3),
    approvalDefaultTimeoutHours: z.number().int().positive().default(72),
  }),
});

// ─── config/security.yaml ──────────────────────────────────────────────────

export const SecurityConfigSchema = z.object({
  commands: z.object({
    allowed: z.array(z.string()).default([]),
    deniedPatterns: z.array(z.string()).default([]),
    requireApproval: z.array(z.string()).default([]),
  }),
  filesystem: z.object({
    deniedPaths: z.array(z.string()).default([]),
    maxFileSizeBytes: z.number().int().positive().default(2_000_000),
  }),
  git: z.object({
    protectedBranches: z.array(z.string()).default(['main', 'master', 'develop']),
    allowForcePush: z.boolean().default(false),
    branchPattern: z.string().default('^(feat|fix|chore)/'),
  }),
});

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type WorkflowsConfig = z.infer<typeof WorkflowsConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
