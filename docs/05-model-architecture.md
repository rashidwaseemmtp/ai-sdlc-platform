# 05 — Model Provider Abstraction & Router

The rule from doc 67: **the platform must never depend on one AI company.** No agent names a vendor.
Agents declare capabilities; the router picks the model.

## 1. Three billing modes — this is not just "API keys"

The requirement is explicit: support both **API usage** and **subscription plans**. These behave
differently enough that billing mode is a first-class property of every provider and every catalog
entry.

| Mode | Examples | Auth | Cost accounting | Concurrency limit |
|---|---|---|---|---|
| `API_METERED` | Anthropic API, OpenAI API, Google Gemini API, OpenRouter | API key or OAuth profile | Real `costUsd` per call from token counts × catalog price | Provider rate limits (RPM/TPM) |
| `SUBSCRIPTION` | Claude Code / Claude subscription via the local `claude` CLI or Agent SDK; ChatGPT-plan-backed CLIs | Existing local login session — **no key handled by us** | `costUsd = 0`, but **quota units** and wall-clock are metered and capped | Seat concurrency (usually 1–2) — enforced by a Redis semaphore |
| `LOCAL_FREE` | Ollama, LM Studio, vLLM, any OpenAI-compatible local server | none / local | `costUsd = 0`, or an optional operator-configured `estimatedHardwareCostPerHour` | Local GPU slots (`maxConcurrent`) |

Consequences the design must honour:

- Cost dashboards show **both** a dollar column and a quota/seat column; a project run entirely on a
  subscription reports `$0.00` with a non-empty quota usage, never a misleading blank.
- The `MAX_WORKFLOW_COST` ceiling cannot police a subscription. Subscription and local providers are
  bounded by `maxIterations`, `maxWallClockSeconds` and `maxToolCalls` instead (doc 04 §2).
- A subscription provider is usually **serialised**. The router must not schedule six parallel
  architecture agents onto one seat; it acquires a semaphore and either queues or overflows to an
  API-metered fallback, according to policy.
- Subscription providers are never used for the *independent* estimator or the architecture critic
  when the primary already used them — independence requires a genuinely different model (doc 03 §4.5).

## 2. Provider interface

```ts
// packages/ai/core/provider.ts
export interface ModelProvider {
  readonly key: ProviderKey;
  readonly billingMode: BillingMode;

  generate(req: ModelRequest): Promise<ModelResponse>;
  stream(req: ModelRequest): AsyncIterable<ModelChunk>;

  countTokens?(req: ModelRequest): Promise<number>;
  health(): Promise<ProviderHealth>;
  listModels?(): Promise<CatalogEntry[]>;   // live capability discovery where supported
}

export interface ModelRequest {
  modelId: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  toolChoice?: 'auto' | 'none' | { name: string };
  outputSchema?: JsonSchema;        // structured output when the provider supports it
  maxOutputTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoning?: 'adaptive' | 'off';
  cacheHints?: CacheBreakpoint[];
  stopSequences?: string[];
  metadata: { projectId: string; agentKey: string; runId: string };
}

export interface ModelResponse {
  content: ContentBlock[];
  toolCalls: ToolCall[];
  structured?: unknown;             // parsed when outputSchema was honoured natively
  usage: { inputTokens; outputTokens; cachedReadTokens; cachedWriteTokens };
  costUsd: number;                  // 0 for SUBSCRIPTION / LOCAL_FREE
  finishReason: 'stop' | 'length' | 'tool_use' | 'refusal' | 'error';
  modelId: string; providerKey: string; latencyMs: number;
  raw?: unknown;                    // provider-specific, never persisted verbatim
}
```

The interface is deliberately the **intersection** of what the platform needs, not the union of what
providers offer. Provider-specific features live behind capability flags, and adapters degrade
explicitly rather than silently.

## 3. Adapters

`packages/ai/providers/*` — one directory per provider, each using that vendor's **official SDK**. No
OpenAI-compatible shims pointed at non-OpenAI vendors; the only exception is the deliberate
`openai-compatible` adapter used for Ollama / vLLM / LM Studio / custom endpoints, which is what those
servers actually speak.

| Adapter | SDK | Notes |
|---|---|---|
| `anthropic` | `@anthropic-ai/sdk` | Structured output via `output_config.format`; adaptive thinking; prompt caching breakpoints; auth via `ANTHROPIC_API_KEY` **or** an existing `ant auth login` profile |
| `openai` | `openai` | JSON-schema response format; parallel tool calls |
| `google` | `@google/genai` | responseSchema; system instruction |
| `openrouter` | `openai` SDK against OpenRouter | Meta-provider; catalog synced from its models endpoint |
| `ollama` / `openai-compatible` | `openai` SDK, local `baseUrl` | `LOCAL_FREE`; capability flags supplied by config since local models vary wildly |
| `claude-subscription` | local `claude` CLI / Agent SDK | `SUBSCRIPTION`; no API key crosses our process; seat semaphore |
| `mock` | — | Deterministic replay for tests and demo mode (doc 65) |

Adding a provider means adding one directory and one catalog entry. No agent, workflow, or prompt
changes.

### Anthropic adapter specifics

Current pinned behaviour (verified against the API reference, not from memory):

- Default model `claude-opus-5`; `claude-sonnet-5` for mid-tier; `claude-haiku-4-5` for classification.
- Reasoning is `thinking: { type: 'adaptive' }`. `budget_tokens` is **rejected with a 400** on Opus 5
  — the adapter must never emit it. Depth is controlled with `output_config.effort`.
- Assistant prefill is removed on this generation; the adapter uses structured output instead.
- Streaming is used whenever `maxOutputTokens` is large, with `.finalMessage()` to collect.
- Prompt-cache breakpoints are placed after the stable prefix (system + tools + project context) and
  before volatile content; `cache_read_input_tokens` is asserted non-zero in integration tests.

## 4. Model catalog

`model_catalog` rows are the router's search space. Seeded from `config/models.yaml`, refreshed by a
`syncModelCatalog` activity where the provider exposes a models endpoint, and editable in the
dashboard.

| Field | Meaning |
|---|---|
| `providerKey`, `modelId` | Address |
| `capabilities[]` | `HIGH_REASONING`, `CODING`, `STRUCTURED_REASONING`, `STRUCTURED_OUTPUT`, `CLASSIFICATION`, `LONG_CONTEXT`, `VISION`, `TOOL_USE` |
| `tier` | `FRONTIER` / `MID` / `SMALL` — the ordering used to enforce a capability floor |
| `contextWindow`, `maxOutput` | Routing constraint against the context package size |
| `inputCostPer1M`, `outputCostPer1M`, `cachedInputCostPer1M` | Cost model; null for subscription/local |
| `billingMode` | See §1 |
| `supportsStructuredOutput`, `supportsToolUse`, `supportsCaching`, `supportsStreaming` | Adapter degradation flags |
| `maxConcurrent` | Seat/GPU limiter |
| `enabled` | Operator kill switch |

Seeded Anthropic entries (Anthropic first-party rates):

| Model | Context | In $/1M | Out $/1M | Tier | Capabilities |
|---|---|---|---|---|---|
| `claude-opus-5` | 1M | 5.00 | 25.00 | FRONTIER | HIGH_REASONING, CODING, STRUCTURED_*, LONG_CONTEXT, VISION, TOOL_USE |
| `claude-sonnet-5` | 1M | 2.00 | 10.00 | MID | CODING, STRUCTURED_*, LONG_CONTEXT, TOOL_USE |
| `claude-haiku-4-5` | 200K | 1.00 | 5.00 | SMALL | CLASSIFICATION, STRUCTURED_OUTPUT, TOOL_USE |

Entries for other vendors ship **disabled with null pricing** and must be confirmed by the operator or
synced from the provider before use — the platform refuses to compute a cost from a price it has not
verified, and reports `costUnknown: true` rather than a fabricated number.

## 5. The router

```ts
// packages/ai/router/model-router.ts
interface ModelPolicy {
  capability: Capability;            // what the task needs
  minimumTier: ModelTier;            // the floor — never crossed (I8)
  preferredProviders?: ProviderKey[];
  fallbackChain?: ProviderKey[];
  maxCostPerRunUsd?: number;
  requireStructuredOutput?: boolean;
  requireDistinctFrom?: string;      // for independent critics/estimators
  allowSubscription?: boolean;       // default true; false for parallel fan-out
}
```

Selection pipeline:

```
candidates = catalog.where(enabled && capabilities ⊇ policy.capability
                           && tier >= policy.minimumTier
                           && contextWindow >= estimatedTokens * 1.2
                           && (!requireStructuredOutput || supportsStructuredOutput)
                           && modelId != policy.requireDistinctFrom)
   ↓ filter   provider health (Redis circuit breaker: closed | half-open)
   ↓ filter   concurrency slot available (subscription seats, local GPU)
   ↓ order    project routing policy → agent routing policy → preferredProviders
              → cost ascending (API_METERED) → latency p50 ascending
   ↓ take     first; the rest become the runtime fallback chain
```

**Capability floor enforcement (I8).** If every candidate is exhausted, the router raises
`NoEligibleModelError`. It does **not** relax `minimumTier`. An architecture task configured
`minimumTier: FRONTIER` will fail loudly rather than quietly produce a system design from a 3B local
model — that failure mode is worse than an outage because it is invisible.

**Fallback.** On `MODEL_UNAVAILABLE`, rate limit, or timeout, the router advances the chain, records
the transition on `llm_calls`, and emits `MODEL_FALLBACK_USED`. Repeated failures trip the provider's
circuit breaker for `PROVIDER_COOLDOWN_SECONDS`. The default chain is configurable per agent, e.g.
`anthropic → openai → google → openrouter → ollama`, and any hop that would breach the floor is
skipped, not taken.

**Complexity-aware routing.** `taskComplexity` (derived from context size, story size signal, and
agent kind) can promote a `MID` selection to `FRONTIER` but never demote below the floor. A trivial
classification (`is this document a meeting transcript?`) routes to `SMALL` and costs a fraction of a
cent.

## 6. Configuration

Runtime config is a merge of `config/models.yaml`, DB rows, and dashboard edits (doc 11), with secrets
referenced, never inlined:

```yaml
models:
  providers:
    anthropic:      { enabled: true,  billingMode: API_METERED,   secretRef: env:ANTHROPIC_API_KEY }
    openai:         { enabled: false, billingMode: API_METERED,   secretRef: env:OPENAI_API_KEY }
    google:         { enabled: false, billingMode: API_METERED,   secretRef: env:GOOGLE_API_KEY }
    openrouter:     { enabled: false, billingMode: API_METERED,   secretRef: env:OPENROUTER_API_KEY }
    ollama:         { enabled: false, billingMode: LOCAL_FREE,    baseUrl: http://localhost:11434 }
    claude-sub:     { enabled: false, billingMode: SUBSCRIPTION,  seats: 1, command: claude }
    mock:           { enabled: true,  billingMode: LOCAL_FREE }

  routing:
    defaults:            { minimumTier: MID, fallbackChain: [anthropic, openai, google, ollama] }
    product-owner:       { capability: HIGH_REASONING,       minimumTier: FRONTIER }
    business-analyst:    { capability: HIGH_REASONING,       minimumTier: FRONTIER }
    architect:           { capability: HIGH_REASONING,       minimumTier: FRONTIER, effort: xhigh }
    architecture-critic: { capability: HIGH_REASONING,       minimumTier: FRONTIER, requireDistinctFrom: inherit }
    estimator:           { capability: STRUCTURED_REASONING, minimumTier: MID }
    developer:           { capability: CODING,               minimumTier: FRONTIER, effort: xhigh }
    code-reviewer:       { capability: CODING,               minimumTier: MID }
    qa:                  { capability: CODING,               minimumTier: MID }
    classifier:          { capability: CLASSIFICATION,       minimumTier: SMALL }
```

No API key ever appears in source, in a workflow argument, in Temporal history, or in a log line.
Secrets resolve through `SecretProvider` at call time and are redacted from every audit record.

## 7. Cost & usage tracking

Every `llm_calls` row carries provider, model, billing mode, token counts (including cache reads),
latency and cost. `usage_records` rolls these up by project / workflow / agent / story / model, which
is what produces the doc-45 report:

```
Project: Customer Management SaaS         API $      Quota      Local
─────────────────────────────────────────────────────────────────────
Product Owner       claude-opus-5           0.41        —          —
Business Analyst    claude-opus-5           0.83        —          —
Architect ×3        claude-opus-5           2.44        —          —
Arch Critic         gpt-…                   0.31        —          —
Estimator ×2        claude-sonnet-5         0.36        —          —
Developer ×7        claude-subscription     0.00     41 msg        —
QA ×7               claude-sonnet-5         2.09        —          —
Classifier ×24      llama3.1:8b             0.00        —      18 min
─────────────────────────────────────────────────────────────────────
Total                                       6.44     41 msg     18 min
```

Cost is estimated **before** an expensive agent runs (tokens × catalog price) and checked against the
remaining workflow budget, so a run is declined before spending rather than halted midway.
