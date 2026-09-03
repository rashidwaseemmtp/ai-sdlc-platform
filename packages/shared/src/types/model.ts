/**
 * Provider-agnostic model types — docs/05-model-architecture.md.
 *
 * Agents declare capability requirements; the router resolves a concrete model. No agent, prompt
 * or workflow ever names a vendor.
 */

export const Capability = {
  HIGH_REASONING: 'HIGH_REASONING',
  STRUCTURED_REASONING: 'STRUCTURED_REASONING',
  CODING: 'CODING',
  STRUCTURED_OUTPUT: 'STRUCTURED_OUTPUT',
  CLASSIFICATION: 'CLASSIFICATION',
  LONG_CONTEXT: 'LONG_CONTEXT',
  VISION: 'VISION',
  TOOL_USE: 'TOOL_USE',
} as const;
export type Capability = (typeof Capability)[keyof typeof Capability];

export const ModelTier = { SMALL: 'SMALL', MID: 'MID', FRONTIER: 'FRONTIER' } as const;
export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

/** Ordering used to enforce the capability floor. Higher index = more capable. */
export const TIER_ORDER: readonly ModelTier[] = [ModelTier.SMALL, ModelTier.MID, ModelTier.FRONTIER];

export function tierAtLeast(candidate: ModelTier, floor: ModelTier): boolean {
  return TIER_ORDER.indexOf(candidate) >= TIER_ORDER.indexOf(floor);
}

/**
 * How a provider is paid for. This is not cosmetic: a SUBSCRIPTION provider reports $0 cost but
 * consumes a limited seat, so it cannot be policed by a dollar ceiling and cannot be fanned out
 * in parallel. See docs/05 §1.
 */
export const BillingMode = {
  API_METERED: 'API_METERED',
  SUBSCRIPTION: 'SUBSCRIPTION',
  LOCAL_FREE: 'LOCAL_FREE',
} as const;
export type BillingMode = (typeof BillingMode)[keyof typeof BillingMode];

export type ProviderKey = string;
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CatalogEntry {
  providerKey: ProviderKey;
  modelId: string;
  displayName: string;
  tier: ModelTier;
  capabilities: Capability[];
  contextWindow: number;
  maxOutput: number;
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  cachedInputCostPer1M: number | null;
  billingMode: BillingMode;
  supportsStructuredOutput: boolean;
  supportsToolUse: boolean;
  supportsCaching: boolean;
  supportsStreaming: boolean;
  maxConcurrent: number;
  enabled: boolean;
}

export interface ModelPolicy {
  capability: Capability;
  /** The floor. The router raises NoEligibleModelError rather than going below it (I8). */
  minimumTier: ModelTier;
  preferredProviders?: ProviderKey[];
  fallbackChain?: ProviderKey[];
  effort?: Effort;
  maxCostPerRunUsd?: number;
  requireStructuredOutput?: boolean;
  /** For independent critics/estimators: must not be the model used by the primary run. */
  requireDistinctFrom?: string;
  /** Set false for parallel fan-out, where a single subscription seat would serialise the work. */
  allowSubscription?: boolean;
}

export interface ModelBinding {
  providerKey: ProviderKey;
  modelId: string;
  entry: CatalogEntry;
  effort?: Effort;
  /** Remaining candidates, in order, used when this binding fails. */
  fallbacks: Array<{ providerKey: ProviderKey; modelId: string }>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentBlock[];
  /** Marks a prompt-cache breakpoint after this message (docs/09 §3). */
  cacheBreakpoint?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelRequest {
  modelId: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  toolChoice?: 'auto' | 'none' | { name: string };
  /**
   * JSON Schema. Every adapter that supports native structured output takes this form, so the
   * runtime converts its Zod schema once and no adapter needs a zod dependency.
   */
  outputSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  effort?: Effort;
  reasoning?: 'adaptive' | 'off';
  stopSequences?: string[];
  metadata: { projectId: string; agentKey: string; runId: string };
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
}

export interface ModelResponse {
  content: ContentBlock[];
  text: string;
  toolCalls: ToolCall[];
  structured?: unknown;
  usage: ModelUsage;
  costUsd: number;
  /** True when the catalog has no verified price — we report unknown rather than inventing one. */
  costUnknown: boolean;
  quotaUnits: number;
  finishReason: 'stop' | 'length' | 'tool_use' | 'refusal' | 'error';
  modelId: string;
  providerKey: ProviderKey;
  billingMode: BillingMode;
  latencyMs: number;
}

export interface ModelChunk {
  type: 'text' | 'tool_use' | 'done';
  text?: string;
  toolCall?: ToolCall;
  usage?: ModelUsage;
}

export interface ProviderHealth {
  providerKey: ProviderKey;
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  latencyMs?: number;
  checkedAt: string;
  message?: string;
}

export interface ModelProvider {
  readonly key: ProviderKey;
  readonly billingMode: BillingMode;
  generate(req: ModelRequest): Promise<ModelResponse>;
  stream(req: ModelRequest): AsyncIterable<ModelChunk>;
  countTokens?(req: ModelRequest): Promise<number>;
  health(): Promise<ProviderHealth>;
  listModels?(): Promise<CatalogEntry[]>;
}
