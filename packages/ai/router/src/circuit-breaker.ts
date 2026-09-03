/**
 * Per-provider circuit breaker.
 *
 * A provider that is timing out or rate-limiting should be skipped for a cooldown rather than
 * retried on every agent run — otherwise one degraded vendor makes every workflow slow instead of
 * making one workflow fall back.
 *
 * State lives in Redis so all workers share it; an in-memory store keeps tests offline.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
  del(key: string): Promise<void>;
}

export class InMemoryBreakerStore implements BreakerStore {
  private data = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.data.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const current = Number((await this.get(key)) ?? 0) + 1;
    await this.set(key, String(current), ttlSeconds);
    return current;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownSeconds?: number;
  windowSeconds?: number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownSeconds: number;
  private readonly windowSeconds: number;

  constructor(
    private readonly store: BreakerStore,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownSeconds = options.cooldownSeconds ?? 120;
    this.windowSeconds = options.windowSeconds ?? 300;
  }

  async state(providerKey: string): Promise<BreakerState> {
    const open = await this.store.get(this.openKey(providerKey));
    if (!open) return 'closed';
    // Once the cooldown expires the key is gone; while it exists we let a single probe through
    // by reporting half-open after the halfway point.
    const openedAt = Number(open);
    const elapsed = (Date.now() - openedAt) / 1000;
    return elapsed >= this.cooldownSeconds / 2 ? 'half-open' : 'open';
  }

  /** A provider is usable when closed, and probeable when half-open. */
  async isAvailable(providerKey: string): Promise<boolean> {
    return (await this.state(providerKey)) !== 'open';
  }

  async recordSuccess(providerKey: string): Promise<void> {
    await this.store.del(this.failKey(providerKey));
    await this.store.del(this.openKey(providerKey));
  }

  async recordFailure(providerKey: string): Promise<BreakerState> {
    const failures = await this.store.incr(this.failKey(providerKey), this.windowSeconds);
    if (failures >= this.failureThreshold) {
      await this.store.set(this.openKey(providerKey), String(Date.now()), this.cooldownSeconds);
      return 'open';
    }
    return 'closed';
  }

  private failKey(providerKey: string): string {
    return `sdlc:breaker:fail:${providerKey}`;
  }

  private openKey(providerKey: string): string {
    return `sdlc:breaker:open:${providerKey}`;
  }
}
