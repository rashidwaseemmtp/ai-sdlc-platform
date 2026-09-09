/**
 * Configuration.
 *
 * Everything an operator can change lives in one row of the `settings` table and is edited from the
 * dashboard — no YAML, no restart, and no environment variables beyond the two the process needs to
 * exist at all (DATABASE_URL and PORT).
 *
 * The shape that matters most is the provider block. **Every** provider × auth-mode pair can be
 * configured and left configured — Claude on an API key *and* Claude on a Max subscription, ChatGPT
 * both ways, Gemini both ways — and exactly one pair is active at a time. Switching from metered
 * billing to a subscription is one dropdown, not a redeployment.
 *
 * Agents are deliberately *not* configurable. They are code in `src/agents/`, because an operator
 * quietly changing an agent's schema or prompt between runs makes its audit trail meaningless.
 */

import { z } from 'zod';
import { db } from './db.js';
import { AUTH_MODES, PROVIDERS, allPairs, modeSpec, pairId, type AuthMode } from './providers.js';

export const GATE_KEYS = ['BACKLOG', 'ARCHITECTURE', 'ESTIMATION', 'DEV_READINESS', 'PULL_REQUEST', 'QA'] as const;
export type GateKey = (typeof GATE_KEYS)[number];

const Gate = z.object({
  /** False auto-approves the gate the moment it opens. The event log still records it. */
  requireApproval: z.boolean().default(true),
  timeoutHours: z.number().min(1).max(24 * 30).default(72),
});

/** One provider × auth-mode pair's configuration. Every pair keeps its own, whether active or not. */
const PairConfig = z.object({
  /** Stored here, never in a file. Masked whenever the API hands settings back. */
  apiKey: z.string().default(''),
  /** Proxy, gateway, self-hosted endpoint, or an Ollama host. Blank means the provider's own. */
  baseUrl: z.string().default(''),
  /** Blank on a subscription means "whatever the plan gives us" — pinning it would invent an id. */
  model: z.string().default(''),
  /** Pin the CLI binary: a specific version, or one not on PATH. Subscription pairs only. */
  command: z.string().default(''),
  inputCostPer1M: z.number().min(0).default(0),
  outputCostPer1M: z.number().min(0).default(0),
});

export type PairConfig = z.infer<typeof PairConfig>;

const Active = z.object({
  provider: z.string().default('anthropic'),
  mode: z.enum(AUTH_MODES).default('api'),
});

export const SettingsSchema = z.object({
  /** Keyed by `provider:mode` — every pair the platform knows, configured or not. */
  providers: z.record(PairConfig).default({}),
  /** The one pair every agent uses, unless it needs tools and this pair cannot carry them. */
  active: Active.default({}),
  /**
   * Optional second entitlement, used *only* by agents with MCP tools granted.
   *
   * No vendor's subscription CLI exposes a headless tool-use protocol this platform can drive while
   * keeping its own permission engine and audit trail. So a subscription alone cannot run the
   * developer, the reviewers or QA. Naming a metered pair here runs the cheap majority of the
   * pipeline on the seat and sends the tool-using agents to the API. Both halves are explicit —
   * assuming a subscription deployment "probably also wants" a metered key would spend money you
   * never agreed to spend.
   */
  toolProvider: Active.optional(),

  /** Only Anthropic's API reads this; the others ignore it. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  /** Capped at 32k: above that a non-streaming request starts risking an HTTP timeout. */
  maxOutputTokens: z.number().min(1024).max(32000).default(16000),

  limits: z
    .object({
      /** Ceiling on one project's whole pipeline. The run parks when it is breached. */
      projectCostUsd: z.number().min(0).default(25),
      agentCostUsd: z.number().min(0).default(5),
      /** How many times a rejected backlog may come back before a human has to step in. */
      backlogRevisions: z.number().min(1).max(10).default(3),
      architectureRounds: z.number().min(1).max(5).default(2),
      /** Above this disagreement between the two estimators, a human reconciles. */
      estimationVariance: z.number().min(0).max(2).default(0.3),
      /** How many times the developer may go back round on reviewer findings. */
      prFixIterations: z.number().min(0).max(10).default(3),
      /** How many times a failing test may send the developer back before QA parks. */
      qaFixIterations: z.number().min(0).max(10).default(2),
      /** Tool calls one agent may make in a single run, across all servers. */
      toolCallsPerRun: z.number().min(0).max(500).default(60),
    })
    .default({}),

  /** Optional: push branches and open pull requests for real. Local-only when blank. */
  github: z
    .object({
      token: z.string().default(''),
      /** `owner/repo`. The only repository the platform will ever push to. */
      repository: z.string().default(''),
      defaultBranch: z.string().default('main'),
      /** Off by default: pushing is outward-facing, and it should be a deliberate choice. */
      push: z.boolean().default(false),
    })
    .default({}),

  runner: z
    .object({
      pollMs: z.number().min(500).max(60000).default(2000),
      maxConcurrentRuns: z.number().min(1).max(20).default(3),
    })
    .default({}),

  gates: z
    .object({
      BACKLOG: Gate.default({}),
      ARCHITECTURE: Gate.default({}),
      ESTIMATION: Gate.default({}),
      DEV_READINESS: Gate.default({}),
      PULL_REQUEST: Gate.default({}),
      QA: Gate.default({}),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Defaults for every pair, taken from the matrix so a fresh install has sensible prices. */
function defaultProviders(): Record<string, PairConfig> {
  return Object.fromEntries(
    allPairs().map((pair) => [
      pair.id,
      PairConfig.parse({
        baseUrl: pair.spec.defaultBaseUrl ?? '',
        model: pair.spec.suggestedModels[0] ?? '',
        command: pair.spec.cli?.command ?? '',
        inputCostPer1M: pair.spec.defaultInputCostPer1M,
        outputCostPer1M: pair.spec.defaultOutputCostPer1M,
      }),
    ]),
  );
}

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({ providers: defaultProviders() });

const KEY = 'platform';

/**
 * Read the live settings.
 *
 * Not cached: the runner picks up a change on its next tick, which is what makes the Settings page
 * feel like it did something. The read is a single indexed row.
 */
export async function getSettings(): Promise<Settings> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  const parsed = SettingsSchema.safeParse(row?.value ?? {});
  const settings = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  // A pair added to the matrix after this row was written still gets its defaults.
  return { ...settings, providers: { ...defaultProviders(), ...settings.providers } };
}

/** Merge a patch over the stored settings. A blank `apiKey` means "keep the stored one". */
export async function saveSettings(patch: unknown): Promise<Settings> {
  const current = await getSettings();
  const incoming = (patch ?? {}) as Record<string, unknown>;

  const providers = { ...current.providers };
  for (const [id, value] of Object.entries((incoming.providers as Record<string, unknown>) ?? {})) {
    const existing = providers[id] ?? PairConfig.parse({});
    const next = (value ?? {}) as Record<string, unknown>;
    providers[id] = PairConfig.parse({
      ...existing,
      ...next,
      // A browser never receives a key, so it can never send one back — blank means unchanged.
      apiKey: typeof next.apiKey === 'string' && next.apiKey ? next.apiKey : existing.apiKey,
    });
  }

  const github = {
    ...current.github,
    ...((incoming.github as object) ?? {}),
    token:
      typeof (incoming.github as { token?: string })?.token === 'string' &&
      (incoming.github as { token: string }).token
        ? (incoming.github as { token: string }).token
        : current.github.token,
  };

  const merged = SettingsSchema.parse({
    ...current,
    ...incoming,
    providers,
    github,
    limits: { ...current.limits, ...((incoming.limits as object) ?? {}) },
    runner: { ...current.runner, ...((incoming.runner as object) ?? {}) },
    gates: { ...current.gates, ...((incoming.gates as object) ?? {}) },
    active: { ...current.active, ...((incoming.active as object) ?? {}) },
    toolProvider:
      incoming.toolProvider === null
        ? undefined
        : incoming.toolProvider
          ? { ...(current.toolProvider ?? {}), ...(incoming.toolProvider as object) }
          : current.toolProvider,
  });

  await db.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: merged },
    update: { value: merged },
  });
  return merged;
}

// ── resolution ─────────────────────────────────────────────────────────────

/** One resolved, usable entitlement. Exactly one of these answers any given agent run. */
export interface Selection {
  providerKey: string;
  mode: AuthMode;
  apiKey: string;
  baseUrl: string;
  model: string;
  command: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  supportsTools: boolean;
  maxConcurrent: number;
  label: string;
}

export class NotConfiguredError extends Error {}

function resolve(settings: Settings, provider: string, mode: AuthMode): Selection {
  const spec = modeSpec(provider, mode);
  if (!spec) {
    throw new NotConfiguredError(
      `${provider} does not offer "${mode}". Pick a different pair on the Settings page.`,
    );
  }

  const config = settings.providers[pairId(provider, mode)] ?? PairConfig.parse({});

  if (spec.needsApiKey && !config.apiKey) {
    const alternative = PROVIDERS.find((p) => p.key === provider)?.modes.some(
      (m) => m.mode === 'subscription',
    )
      ? ` Or switch this provider to its subscription mode, which needs no key.`
      : '';
    throw new NotConfiguredError(
      `${provider} (${mode}) has no API key set. Add one on the Settings page.${alternative}`,
    );
  }

  return {
    providerKey: provider,
    mode,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || (spec.defaultBaseUrl ?? ''),
    model: config.model,
    command: config.command || spec.cli?.command || '',
    inputCostPer1M: config.inputCostPer1M,
    outputCostPer1M: config.outputCostPer1M,
    supportsTools: spec.supportsTools,
    maxConcurrent: spec.maxConcurrent,
    label: `${provider} · ${spec.label}`,
  };
}

/**
 * Pick the entitlement for one agent run.
 *
 * `needsTools` is decided by whether the agent has any enabled MCP grant, not by anything the agent
 * declares — so granting the developer a GitHub server on the MCP page is what moves it onto the
 * tool provider, with no code change anywhere.
 */
export function selectFor(settings: Settings, needsTools: boolean): Selection {
  const primary = resolve(settings, settings.active.provider, settings.active.mode);
  if (!needsTools || primary.supportsTools) return primary;

  if (!settings.toolProvider) {
    throw new NotConfiguredError(
      `This agent has MCP tools granted, but the active entitlement (${primary.label}) cannot carry ` +
        'them: a tool run inside a vendor CLI would bypass this platform\'s permission engine and ' +
        'audit trail. Either set a "tool provider" on the Settings page — an API-key pair that ' +
        'tool-using agents are sent to — or revoke this agent\'s grants on the MCP page.',
    );
  }

  const tools = resolve(settings, settings.toolProvider.provider, settings.toolProvider.mode);
  if (!tools.supportsTools) {
    throw new NotConfiguredError(
      `The configured tool provider (${tools.label}) cannot carry MCP tools either. It must be an ` +
        'API-key pair.',
    );
  }
  return tools;
}

/** What the API is allowed to send to a browser: everything except the secrets themselves. */
export function redact(settings: Settings) {
  return {
    ...settings,
    providers: Object.fromEntries(
      Object.entries(settings.providers).map(([id, config]) => [
        id,
        { ...config, apiKey: '', apiKeySet: config.apiKey.length > 0 },
      ]),
    ),
    github: { ...settings.github, token: '', tokenSet: settings.github.token.length > 0 },
  };
}
