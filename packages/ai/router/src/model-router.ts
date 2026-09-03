/**
 * Model Router — docs/05 §5.
 *
 * Agents declare capability requirements; this resolves a concrete model. The single most
 * important behaviour here is what it *refuses* to do: when no candidate meets the capability
 * floor it raises `NoEligibleModelError` rather than quietly handing an architecture task to a 3B
 * local model. A silent downgrade is worse than an outage because it is invisible in the output.
 */

import {
  BillingMode,
  FailureCode,
  ModelTier,
  NoEligibleModelError,
  PlatformError,
  tierAtLeast,
  type CatalogEntry,
  type ModelBinding,
  type ModelPolicy,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderKey,
} from '@sdlc/shared';
import { calculateCost, estimateCost, estimateMessageTokens } from '@sdlc/ai-core';
import { getLogger, metrics } from '@sdlc/observability';
import { CircuitBreaker } from './circuit-breaker.js';
import { CapacitySemaphore, type Lease } from './semaphore.js';

const log = getLogger({ component: 'model-router' });

export interface SelectOptions {
  /** Drives promotion (never demotion) of the tier — a large story earns a stronger model. */
  taskComplexity?: 'low' | 'normal' | 'high';
  estimatedInputTokens?: number;
  expectedOutputTokens?: number;
  /** Excluded because a previous attempt on them already failed this run. */
  exclude?: string[];
}

export interface RouterDeps {
  catalog: CatalogEntry[];
  providers: Map<ProviderKey, ModelProvider>;
  breaker: CircuitBreaker;
  semaphore: CapacitySemaphore;
}

export interface ExecuteResult {
  response: ModelResponse;
  binding: ModelBinding;
  /** Set when the primary binding failed and a fallback answered — recorded on `llm_calls`. */
  fellBackFrom?: string;
}

export class ModelRouter {
  constructor(private readonly deps: RouterDeps) {}

  get catalog(): readonly CatalogEntry[] {
    return this.deps.catalog;
  }

  setCatalog(catalog: CatalogEntry[]): void {
    this.deps.catalog = catalog;
  }

  /**
   * Resolve a policy to a concrete binding plus an ordered fallback chain.
   * Throws rather than relaxing `minimumTier`.
   */
  async select(policy: ModelPolicy, options: SelectOptions = {}): Promise<ModelBinding> {
    const floor = this.effectiveFloor(policy, options.taskComplexity);
    const estimatedTokens = options.estimatedInputTokens ?? 0;
    const rejected: Record<string, number> = {};

    const reject = (reason: string): false => {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      return false;
    };

    let candidates = this.deps.catalog.filter((entry) => {
      if (!entry.enabled) return reject('disabled');
      if (!entry.capabilities.includes(policy.capability)) return reject('capability');
      if (!tierAtLeast(entry.tier, floor)) return reject('below-floor');
      if (estimatedTokens > 0 && entry.contextWindow < estimatedTokens * 1.2) {
        return reject('context-window');
      }
      if (policy.requireStructuredOutput && !entry.supportsStructuredOutput) {
        return reject('no-structured-output');
      }
      if (policy.requireDistinctFrom && entry.modelId === policy.requireDistinctFrom) {
        return reject('must-be-distinct');
      }
      if (policy.allowSubscription === false && entry.billingMode === BillingMode.SUBSCRIPTION) {
        return reject('subscription-not-allowed');
      }
      if (options.exclude?.includes(this.address(entry))) return reject('already-failed');
      if (!this.deps.providers.has(entry.providerKey)) return reject('provider-not-registered');
      return true;
    });

    // Health and capacity are asynchronous, so they filter after the cheap predicates.
    const healthy: CatalogEntry[] = [];
    for (const entry of candidates) {
      if (!(await this.deps.breaker.isAvailable(entry.providerKey))) {
        reject('circuit-open');
        continue;
      }
      if (!(await this.deps.semaphore.available(this.address(entry), entry.maxConcurrent))) {
        reject('at-capacity');
        continue;
      }
      healthy.push(entry);
    }
    candidates = healthy;

    if (candidates.length === 0) {
      throw new NoEligibleModelError({
        capability: policy.capability,
        minimumTier: floor,
        rejected,
        catalogSize: this.deps.catalog.length,
        hint:
          rejected['below-floor']
            ? 'Candidates existed but were below the capability floor. The router will not downgrade a high-risk task (invariant I8).'
            : 'Enable a provider and a catalog entry that satisfies this capability.',
      });
    }

    const ordered = this.rank(candidates, policy, options);
    const primary = ordered[0]!;

    return {
      providerKey: primary.providerKey,
      modelId: primary.modelId,
      entry: primary,
      ...(policy.effort ? { effort: policy.effort } : {}),
      fallbacks: ordered
        .slice(1)
        .map((entry) => ({ providerKey: entry.providerKey, modelId: entry.modelId })),
    };
  }

  /**
   * Execute a request against a binding, walking the fallback chain on transient failure.
   * Every hop is recorded; nothing silently downgrades because the chain was already filtered
   * against the capability floor at selection time.
   */
  async execute(binding: ModelBinding, req: ModelRequest): Promise<ExecuteResult> {
    const chain = [
      { providerKey: binding.providerKey, modelId: binding.modelId },
      ...binding.fallbacks,
    ];

    let lastError: unknown;
    for (const [index, hop] of chain.entries()) {
      const entry = this.findEntry(hop.providerKey, hop.modelId);
      const provider = this.deps.providers.get(hop.providerKey);
      if (!entry || !provider) continue;

      let lease: Lease | null = null;
      try {
        lease = await this.deps.semaphore.tryAcquire(this.address(entry), entry.maxConcurrent);
        if (!lease) {
          log.debug({ provider: hop.providerKey, model: hop.modelId }, 'at capacity, trying next');
          continue;
        }

        const response = await provider.generate({
          ...req,
          modelId: hop.modelId,
          ...(binding.effort ? { effort: binding.effort } : {}),
        });

        const priced = calculateCost(entry, response.usage);
        await this.deps.breaker.recordSuccess(hop.providerKey);
        metrics.increment('llm.calls', 1, { provider: hop.providerKey, model: hop.modelId });
        metrics.observe('llm.latency_ms', response.latencyMs, { provider: hop.providerKey });

        return {
          response: {
            ...response,
            costUsd: priced.costUsd,
            costUnknown: priced.costUnknown,
            quotaUnits: priced.quotaUnits,
            billingMode: entry.billingMode,
          },
          binding: { ...binding, providerKey: hop.providerKey, modelId: hop.modelId, entry },
          ...(index > 0
            ? { fellBackFrom: `${binding.providerKey}/${binding.modelId}` }
            : {}),
        };
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof PlatformError ? error.code === FailureCode.MODEL_UNAVAILABLE : true;

        if (!retryable) throw error;

        await this.deps.breaker.recordFailure(hop.providerKey);
        metrics.increment('llm.failures', 1, { provider: hop.providerKey });
        log.warn(
          { provider: hop.providerKey, model: hop.modelId, error: (error as Error).message },
          'model call failed, advancing fallback chain',
        );
      } finally {
        await lease?.release();
      }
    }

    throw new PlatformError({
      code: FailureCode.MODEL_UNAVAILABLE,
      message: `All ${chain.length} model(s) in the fallback chain failed.`,
      details: { chain, lastError: (lastError as Error)?.message },
      cause: lastError,
    });
  }

  /** Pre-flight price so a run can be declined before spending rather than halted midway. */
  priceRequest(binding: ModelBinding, req: ModelRequest): { costUsd: number; costUnknown: boolean } {
    const inputTokens = estimateMessageTokens(req.messages, req.system);
    const { costUsd, costUnknown } = estimateCost(binding.entry, inputTokens, req.maxOutputTokens);
    return { costUsd, costUnknown };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Complexity may promote the floor but never lower it. */
  private effectiveFloor(policy: ModelPolicy, complexity?: SelectOptions['taskComplexity']): ModelTier {
    if (complexity === 'high' && policy.minimumTier === ModelTier.SMALL) return ModelTier.MID;
    if (complexity === 'high' && policy.minimumTier === ModelTier.MID) return ModelTier.FRONTIER;
    return policy.minimumTier;
  }

  private rank(
    candidates: CatalogEntry[],
    policy: ModelPolicy,
    options: SelectOptions,
  ): CatalogEntry[] {
    const preferred = policy.preferredProviders ?? [];
    const chain = policy.fallbackChain ?? [];
    const outputTokens = options.expectedOutputTokens ?? 4000;

    const rankOf = (entry: CatalogEntry): number => {
      const preferredIndex = preferred.indexOf(entry.providerKey);
      if (preferredIndex !== -1) return preferredIndex;
      const chainIndex = chain.indexOf(entry.providerKey);
      if (chainIndex !== -1) return 100 + chainIndex;
      return 1000;
    };

    return [...candidates].sort((a, b) => {
      const byPolicy = rankOf(a) - rankOf(b);
      if (byPolicy !== 0) return byPolicy;

      // Cheaper first among equals; free (local/subscription) sorts ahead of metered.
      const costA = estimateCost(a, options.estimatedInputTokens ?? 10_000, outputTokens).costUsd;
      const costB = estimateCost(b, options.estimatedInputTokens ?? 10_000, outputTokens).costUsd;
      if (costA !== costB) return costA - costB;

      return a.modelId.localeCompare(b.modelId);
    });
  }

  private findEntry(providerKey: ProviderKey, modelId: string): CatalogEntry | undefined {
    return this.deps.catalog.find((e) => e.providerKey === providerKey && e.modelId === modelId);
  }

  private address(entry: CatalogEntry): string {
    return `${entry.providerKey}/${entry.modelId}`;
  }
}
