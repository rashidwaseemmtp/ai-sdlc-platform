import { describe, it, expect, beforeEach } from 'vitest';
import {
  BillingMode,
  Capability,
  ModelTier,
  NoEligibleModelError,
  PlatformError,
  FailureCode,
  type CatalogEntry,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@sdlc/shared';
import { ModelRouter } from './model-router.js';
import { CircuitBreaker, InMemoryBreakerStore } from './circuit-breaker.js';
import { CapacitySemaphore, InMemorySemaphoreStore } from './semaphore.js';

function entry(over: Partial<CatalogEntry> & Pick<CatalogEntry, 'providerKey' | 'modelId' | 'tier'>): CatalogEntry {
  return {
    displayName: over.modelId,
    capabilities: [Capability.HIGH_REASONING, Capability.CODING],
    contextWindow: 200_000,
    maxOutput: 8000,
    inputCostPer1M: 1,
    outputCostPer1M: 5,
    cachedInputCostPer1M: null,
    billingMode: BillingMode.API_METERED,
    supportsStructuredOutput: true,
    supportsToolUse: true,
    supportsCaching: false,
    supportsStreaming: true,
    maxConcurrent: 4,
    enabled: true,
    ...over,
  };
}

class StubProvider implements ModelProvider {
  calls: string[] = [];
  constructor(
    readonly key: string,
    readonly billingMode: BillingMode = BillingMode.API_METERED,
    private readonly behaviour: 'ok' | 'unavailable' | 'fatal' = 'ok',
  ) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req.modelId);
    if (this.behaviour === 'unavailable') {
      throw new PlatformError({ code: FailureCode.MODEL_UNAVAILABLE, message: 'down' });
    }
    if (this.behaviour === 'fatal') {
      throw new PlatformError({ code: FailureCode.PERMISSION_DENIED, message: 'nope' });
    }
    return {
      content: [{ type: 'text', text: 'ok' }],
      text: 'ok',
      toolCalls: [],
      usage: { inputTokens: 1000, outputTokens: 500, cachedReadTokens: 0, cachedWriteTokens: 0 },
      costUsd: 0,
      costUnknown: false,
      quotaUnits: 0,
      finishReason: 'stop',
      modelId: req.modelId,
      providerKey: this.key,
      billingMode: this.billingMode,
      latencyMs: 5,
    };
  }
  async *stream(): AsyncIterable<never> {}
  async health() {
    return { providerKey: this.key, status: 'HEALTHY' as const, checkedAt: new Date().toISOString() };
  }
}

const request = (modelId: string): ModelRequest => ({
  modelId,
  messages: [{ role: 'user', content: 'hello' }],
  maxOutputTokens: 1000,
  metadata: { projectId: 'p1', agentKey: 'architect', runId: 'r1' },
});

function makeRouter(catalog: CatalogEntry[], providers: Record<string, ModelProvider>) {
  return new ModelRouter({
    catalog,
    providers: new Map(Object.entries(providers)),
    breaker: new CircuitBreaker(new InMemoryBreakerStore(), { failureThreshold: 2, cooldownSeconds: 60 }),
    semaphore: new CapacitySemaphore(new InMemorySemaphoreStore()),
  });
}

describe('capability floor (invariant I8)', () => {
  it('refuses to downgrade below the floor even when weaker models exist', async () => {
    const router = makeRouter(
      [entry({ providerKey: 'ollama', modelId: 'llama3:8b', tier: ModelTier.SMALL })],
      { ollama: new StubProvider('ollama') },
    );

    await expect(
      router.select({ capability: Capability.HIGH_REASONING, minimumTier: ModelTier.FRONTIER }),
    ).rejects.toBeInstanceOf(NoEligibleModelError);
  });

  it('explains that candidates were rejected for being below the floor', async () => {
    const router = makeRouter(
      [entry({ providerKey: 'ollama', modelId: 'llama3:8b', tier: ModelTier.MID })],
      { ollama: new StubProvider('ollama') },
    );

    await expect(
      router.select({ capability: Capability.HIGH_REASONING, minimumTier: ModelTier.FRONTIER }),
    ).rejects.toMatchObject({ details: { rejected: { 'below-floor': 1 } } });
  });

  it('selects a model at or above the floor', async () => {
    const router = makeRouter(
      [
        entry({ providerKey: 'ollama', modelId: 'llama3:8b', tier: ModelTier.SMALL }),
        entry({ providerKey: 'anthropic', modelId: 'claude-opus-5', tier: ModelTier.FRONTIER }),
      ],
      { ollama: new StubProvider('ollama'), anthropic: new StubProvider('anthropic') },
    );

    const binding = await router.select({
      capability: Capability.HIGH_REASONING,
      minimumTier: ModelTier.FRONTIER,
    });
    expect(binding.modelId).toBe('claude-opus-5');
  });

  it('promotes the floor for high complexity but never demotes it', async () => {
    const router = makeRouter(
      [
        entry({ providerKey: 'a', modelId: 'mid', tier: ModelTier.MID }),
        entry({ providerKey: 'b', modelId: 'frontier', tier: ModelTier.FRONTIER }),
      ],
      { a: new StubProvider('a'), b: new StubProvider('b') },
    );

    const promoted = await router.select(
      { capability: Capability.HIGH_REASONING, minimumTier: ModelTier.MID },
      { taskComplexity: 'high' },
    );
    expect(promoted.modelId).toBe('frontier');
  });
});

describe('policy constraints', () => {
  const catalog = [
    entry({ providerKey: 'anthropic', modelId: 'claude-opus-5', tier: ModelTier.FRONTIER }),
    entry({
      providerKey: 'claude-subscription',
      modelId: 'default',
      tier: ModelTier.FRONTIER,
      billingMode: BillingMode.SUBSCRIPTION,
      inputCostPer1M: null,
      outputCostPer1M: null,
      maxConcurrent: 1,
    }),
  ];
  const providers = {
    anthropic: new StubProvider('anthropic'),
    'claude-subscription': new StubProvider('claude-subscription', BillingMode.SUBSCRIPTION),
  };

  it('excludes subscription providers from parallel fan-out', async () => {
    const router = makeRouter(catalog, providers);
    const binding = await router.select({
      capability: Capability.HIGH_REASONING,
      minimumTier: ModelTier.FRONTIER,
      allowSubscription: false,
    });
    expect(binding.providerKey).toBe('anthropic');
    expect(binding.fallbacks).toHaveLength(0);
  });

  it('honours requireDistinctFrom so a critic never reuses the author model', async () => {
    const router = makeRouter(catalog, providers);
    const binding = await router.select({
      capability: Capability.HIGH_REASONING,
      minimumTier: ModelTier.FRONTIER,
      requireDistinctFrom: 'claude-opus-5',
    });
    expect(binding.modelId).not.toBe('claude-opus-5');
  });

  it('rejects models whose context window cannot hold the package', async () => {
    const router = makeRouter(
      [entry({ providerKey: 'a', modelId: 'small-ctx', tier: ModelTier.FRONTIER, contextWindow: 8000 })],
      { a: new StubProvider('a') },
    );
    await expect(
      router.select(
        { capability: Capability.HIGH_REASONING, minimumTier: ModelTier.FRONTIER },
        { estimatedInputTokens: 100_000 },
      ),
    ).rejects.toMatchObject({ details: { rejected: { 'context-window': 1 } } });
  });
});

describe('fallback execution', () => {
  it('advances the chain on a transient failure and reports the fallback', async () => {
    const down = new StubProvider('anthropic', BillingMode.API_METERED, 'unavailable');
    const up = new StubProvider('openai');
    const router = makeRouter(
      [
        entry({ providerKey: 'anthropic', modelId: 'claude-opus-5', tier: ModelTier.FRONTIER }),
        entry({ providerKey: 'openai', modelId: 'gpt-x', tier: ModelTier.FRONTIER }),
      ],
      { anthropic: down, openai: up },
    );

    const binding = await router.select({
      capability: Capability.HIGH_REASONING,
      minimumTier: ModelTier.FRONTIER,
      preferredProviders: ['anthropic', 'openai'],
    });
    const result = await router.execute(binding, request(binding.modelId));

    expect(result.response.providerKey).toBe('openai');
    expect(result.fellBackFrom).toBe('anthropic/claude-opus-5');
    expect(down.calls).toHaveLength(1);
  });

  it('does not retry a non-retryable failure', async () => {
    const fatal = new StubProvider('anthropic', BillingMode.API_METERED, 'fatal');
    const backup = new StubProvider('openai');
    const router = makeRouter(
      [
        entry({ providerKey: 'anthropic', modelId: 'claude-opus-5', tier: ModelTier.FRONTIER }),
        entry({ providerKey: 'openai', modelId: 'gpt-x', tier: ModelTier.FRONTIER }),
      ],
      { anthropic: fatal, openai: backup },
    );

    const binding = await router.select({
      capability: Capability.HIGH_REASONING,
      minimumTier: ModelTier.FRONTIER,
      preferredProviders: ['anthropic', 'openai'],
    });

    await expect(router.execute(binding, request(binding.modelId))).rejects.toMatchObject({
      code: FailureCode.PERMISSION_DENIED,
    });
    expect(backup.calls).toHaveLength(0);
  });

  it('prices the response from the catalog, not from the provider', async () => {
    const router = makeRouter(
      [
        entry({
          providerKey: 'anthropic',
          modelId: 'claude-opus-5',
          tier: ModelTier.FRONTIER,
          inputCostPer1M: 5,
          outputCostPer1M: 25,
        }),
      ],
      { anthropic: new StubProvider('anthropic') },
    );
    const binding = await router.select({
      capability: Capability.HIGH_REASONING,
      minimumTier: ModelTier.FRONTIER,
    });
    const result = await router.execute(binding, request(binding.modelId));

    // 1000 input @ $5/M + 500 output @ $25/M
    expect(result.response.costUsd).toBeCloseTo(0.005 + 0.0125, 6);
    expect(result.response.costUnknown).toBe(false);
  });

  it('reports cost as unknown rather than inventing a price', async () => {
    const router = makeRouter(
      [
        entry({
          providerKey: 'custom',
          modelId: 'mystery',
          tier: ModelTier.FRONTIER,
          inputCostPer1M: null,
          outputCostPer1M: null,
        }),
      ],
      { custom: new StubProvider('custom') },
    );
    const binding = await router.select({
      capability: Capability.HIGH_REASONING,
      minimumTier: ModelTier.FRONTIER,
    });
    const result = await router.execute(binding, request(binding.modelId));
    expect(result.response.costUnknown).toBe(true);
    expect(result.response.costUsd).toBe(0);
  });

  it('reports zero cost and one quota unit for a subscription seat', async () => {
    const router = makeRouter(
      [
        entry({
          providerKey: 'claude-subscription',
          modelId: 'default',
          tier: ModelTier.FRONTIER,
          billingMode: BillingMode.SUBSCRIPTION,
          inputCostPer1M: null,
          outputCostPer1M: null,
        }),
      ],
      { 'claude-subscription': new StubProvider('claude-subscription', BillingMode.SUBSCRIPTION) },
    );
    const binding = await router.select({
      capability: Capability.HIGH_REASONING,
      minimumTier: ModelTier.FRONTIER,
    });
    const result = await router.execute(binding, request(binding.modelId));
    expect(result.response.costUsd).toBe(0);
    expect(result.response.costUnknown).toBe(false);
    expect(result.response.quotaUnits).toBe(1);
  });
});

describe('circuit breaker and capacity', () => {
  let breaker: CircuitBreaker;
  beforeEach(() => {
    breaker = new CircuitBreaker(new InMemoryBreakerStore(), { failureThreshold: 2, cooldownSeconds: 60 });
  });

  it('opens after the failure threshold and blocks selection', async () => {
    expect(await breaker.recordFailure('anthropic')).toBe('closed');
    expect(await breaker.recordFailure('anthropic')).toBe('open');
    expect(await breaker.isAvailable('anthropic')).toBe(false);
  });

  it('closes again on success', async () => {
    await breaker.recordFailure('anthropic');
    await breaker.recordFailure('anthropic');
    await breaker.recordSuccess('anthropic');
    expect(await breaker.isAvailable('anthropic')).toBe(true);
  });

  it('serialises a single subscription seat', async () => {
    const semaphore = new CapacitySemaphore(new InMemorySemaphoreStore());
    const first = await semaphore.tryAcquire('claude-subscription/default', 1);
    const second = await semaphore.tryAcquire('claude-subscription/default', 1);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first!.release();
    expect(await semaphore.tryAcquire('claude-subscription/default', 1)).not.toBeNull();
  });
});
