/**
 * The provider matrix.
 *
 * A **provider** is *who answers* — Anthropic, OpenAI, Google. An **auth mode** is *how you are
 * entitled to ask*: a metered API key, a paid subscription driven through the vendor's own CLI, or
 * a local server. They are independent axes, so the dashboard lets you configure every pair and
 * activate exactly one.
 *
 * Two rules constrain what may be written here, and neither is negotiable:
 *
 *   1. A subscription mode uses the vendor's **own published CLI**, logged in with the command they
 *      document. No browser cookies are reused, no session token is lifted out of another app, and
 *      no API SDK is pointed at an endpoint it was not meant for.
 *   2. The platform holds **no credential** in a subscription mode. The CLI owns its own login.
 *      That is a security property of the design, not a gap in it.
 *
 * Adding a vendor is a row in this table plus one arm in `llm.ts`. Nothing else changes.
 */

export const AUTH_MODES = ['api', 'subscription', 'local'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface CliSpec {
  /** The binary the vendor ships. Overridable per deployment; never a path we synthesise. */
  command: string;
  /** Arguments that produce one non-interactive completion. */
  execArgs: string[];
  /** Flag used to pin a model. Omitted entirely when the model is left blank. */
  modelFlag?: string;
  /** A side-effect-free "are you installed?" probe. */
  probeArgs: string[];
  /**
   * Command that reports whether the CLI is signed in. Absent when the vendor has none.
   *
   * Installed and signed-in are different facts, and only the second makes a run possible — so the
   * dashboard reports them separately rather than implying one from the other.
   */
  statusArgs?: string[];
  /** Text in the status output that means NOT signed in. Matched case-insensitively. */
  signedOutMarkers?: string[];
  /** Copy-pasteable login command, shown verbatim in the dashboard and in errors. */
  loginCommand: string;
  /** Which plans cover this path, so an operator can check their own billing. */
  plans: string;
  /** Shape of stdout: `json` means parse an envelope, `text` means stdout is the message. */
  stdout: 'json' | 'text';
  /**
   * Environment variables removed before spawning.
   *
   * This line is load-bearing. Every one of these CLIs prefers an API key when it finds one, so a
   * machine with ANTHROPIC_API_KEY exported would quietly bill the API while the dashboard showed
   * $0.00 against a seat. Stripping the key is what makes "only the active mode is used" a fact.
   */
  stripEnv: string[];
}

export interface ModeSpec {
  /** api / subscription / local. */
  mode: AuthMode;
  label: string;
  summary: string;
  /** True when this mode authenticates with a key the platform stores. */
  needsApiKey: boolean;
  /**
   * Whether an agent routed here can be given MCP tools.
   *
   * False for every subscription CLI, and not because the CLIs lack tools — because a tool executed
   * inside a vendor's CLI bypasses this platform's permission engine and its audit trail. An agent
   * with granted tools is therefore sent to the tool provider instead.
   */
  supportsTools: boolean;
  /** How many calls this entitlement will take at once. A seat is serialised; a GPU is one slot. */
  maxConcurrent: number;
  cli?: CliSpec;
  defaultBaseUrl?: string;
  suggestedModels: string[];
  /** Per-million-token list prices, used to cost a run. Zero for anything not billed per token. */
  defaultInputCostPer1M: number;
  defaultOutputCostPer1M: number;
}

export interface ProviderSpec {
  key: string;
  displayName: string;
  modes: ModeSpec[];
}

export const PROVIDERS: ProviderSpec[] = [
  {
    key: 'anthropic',
    displayName: 'Anthropic — Claude',
    modes: [
      {
        mode: 'api',
        label: 'API key',
        summary: 'Anthropic Messages API via the official SDK, billed per token. Supports MCP tools.',
        needsApiKey: true,
        supportsTools: true,
        maxConcurrent: 4,
        suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
        defaultInputCostPer1M: 5,
        defaultOutputCostPer1M: 25,
      },
      {
        mode: 'subscription',
        label: 'Claude Pro / Max subscription',
        summary: 'Claude Code CLI in headless mode. No API key, no per-token billing.',
        needsApiKey: false,
        supportsTools: false,
        maxConcurrent: 1,
        suggestedModels: ['', 'opus', 'sonnet'],
        defaultInputCostPer1M: 0,
        defaultOutputCostPer1M: 0,
        cli: {
          command: 'claude',
          execArgs: ['-p', '--output-format', 'json'],
          modelFlag: '--model',
          probeArgs: ['--version'],
          statusArgs: ['auth', 'status'],
          signedOutMarkers: ['"loggedIn": false', '"loggedIn":false', 'not logged in'],
          loginCommand: 'claude auth login',
          plans: 'Claude Pro or Claude Max',
          stdout: 'json',
          stripEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
        },
      },
    ],
  },
  {
    key: 'openai',
    displayName: 'OpenAI — ChatGPT',
    modes: [
      {
        mode: 'api',
        label: 'API key',
        summary: 'OpenAI API via the official SDK, billed per token. Supports MCP tools.',
        needsApiKey: true,
        supportsTools: true,
        maxConcurrent: 4,
        suggestedModels: ['gpt-5', 'gpt-5-mini', 'o4-mini'],
        defaultInputCostPer1M: 1.25,
        defaultOutputCostPer1M: 10,
      },
      {
        mode: 'subscription',
        label: 'ChatGPT plan',
        summary: 'Codex CLI (`codex exec`), entitled by a ChatGPT plan.',
        needsApiKey: false,
        supportsTools: false,
        maxConcurrent: 1,
        suggestedModels: ['', 'gpt-5-codex'],
        defaultInputCostPer1M: 0,
        defaultOutputCostPer1M: 0,
        cli: {
          command: 'codex',
          // `codex exec` writes progress to stderr and only the final message to stdout, which is
          // a far steadier contract than parsing its event stream.
          execArgs: ['exec'],
          modelFlag: '--model',
          probeArgs: ['--version'],
          statusArgs: ['login', 'status'],
          signedOutMarkers: ['not logged in'],
          loginCommand: 'codex login --device-auth',
          plans: 'ChatGPT Plus, Pro, Business, Edu or Enterprise',
          stdout: 'text',
          stripEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
        },
      },
    ],
  },
  {
    key: 'google',
    displayName: 'Google — Gemini',
    modes: [
      {
        mode: 'api',
        label: 'API key',
        summary: "Gemini through the OpenAI-compatible endpoint Google publishes. Supports MCP tools.",
        needsApiKey: true,
        supportsTools: true,
        maxConcurrent: 4,
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
        defaultInputCostPer1M: 1.25,
        defaultOutputCostPer1M: 10,
      },
      {
        mode: 'subscription',
        label: 'Google AI Pro / Ultra',
        summary: 'Gemini CLI in non-interactive mode, entitled by a Google AI subscription.',
        needsApiKey: false,
        supportsTools: false,
        maxConcurrent: 1,
        suggestedModels: ['', 'gemini-2.5-pro'],
        defaultInputCostPer1M: 0,
        defaultOutputCostPer1M: 0,
        cli: {
          command: 'gemini',
          execArgs: ['-p'],
          modelFlag: '--model',
          probeArgs: ['--version'],
          // The OAuth login is interactive by nature; the CLI caches the result and reuses it.
          loginCommand: 'gemini   (choose "Login with Google" once; the CLI caches the session)',
          plans: 'Google AI Pro or Google AI Ultra',
          stdout: 'text',
          stripEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
        },
      },
    ],
  },
  {
    key: 'openrouter',
    displayName: 'OpenRouter',
    modes: [
      {
        mode: 'api',
        label: 'API key',
        summary: 'OpenRouter meta-provider. Credits are prepaid, but the wire protocol is metered.',
        needsApiKey: true,
        supportsTools: true,
        maxConcurrent: 4,
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        suggestedModels: ['anthropic/claude-opus-5', 'openai/gpt-5', 'meta-llama/llama-3.3-70b-instruct'],
        defaultInputCostPer1M: 3,
        defaultOutputCostPer1M: 15,
      },
    ],
  },
  {
    key: 'ollama',
    displayName: 'Ollama (local)',
    modes: [
      {
        mode: 'local',
        label: 'Local server',
        summary: 'A local Ollama server. No credential, no vendor, no bill.',
        needsApiKey: false,
        supportsTools: true,
        maxConcurrent: 1,
        defaultBaseUrl: 'http://host.docker.internal:11434/v1',
        suggestedModels: ['llama3.3', 'qwen2.5-coder', 'mistral'],
        defaultInputCostPer1M: 0,
        defaultOutputCostPer1M: 0,
      },
    ],
  },
];

export function providerSpec(key: string): ProviderSpec | undefined {
  return PROVIDERS.find((provider) => provider.key === key);
}

export function modeSpec(providerKey: string, mode: AuthMode): ModeSpec | undefined {
  return providerSpec(providerKey)?.modes.find((candidate) => candidate.mode === mode);
}

/** Stable id for one pair, used as the settings key: `anthropic:subscription`. */
export function pairId(providerKey: string, mode: AuthMode): string {
  return `${providerKey}:${mode}`;
}

/** Every pair the platform knows how to drive, in dashboard order. */
export function allPairs(): { id: string; providerKey: string; providerName: string; spec: ModeSpec }[] {
  return PROVIDERS.flatMap((provider) =>
    provider.modes.map((spec) => ({
      id: pairId(provider.key, spec.mode),
      providerKey: provider.key,
      providerName: provider.displayName,
      spec,
    })),
  );
}

export function describePair(providerKey: string, mode: AuthMode): string {
  const provider = providerSpec(providerKey);
  const spec = modeSpec(providerKey, mode);
  if (!provider || !spec) return `${providerKey}:${mode}`;
  return `${provider.displayName} · ${spec.label}`;
}
