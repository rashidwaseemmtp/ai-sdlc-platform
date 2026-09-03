/**
 * @sdlc/ai-router — capability-based model selection with fallback and capacity control.
 */

import { Redis } from 'ioredis';
import type { BreakerStore } from './circuit-breaker.js';
import type { SemaphoreStore } from './semaphore.js';

export * from './circuit-breaker.js';
export * from './semaphore.js';
export * from './model-router.js';

/**
 * Redis-backed breaker state, shared across every worker so one degraded provider is skipped
 * fleet-wide rather than re-probed by each process.
 */
export class RedisBreakerStore implements BreakerStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttlSeconds);
    return count;
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/** Redis-backed capacity counters for subscription seats and local GPU slots. */
export class RedisSemaphoreStore implements SemaphoreStore {
  constructor(private readonly redis: Redis) {}

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    // The TTL is a safety valve: a crashed worker must not hold a seat forever.
    await this.redis.expire(key, ttlSeconds);
    return count;
  }

  async decr(key: string): Promise<number> {
    const count = await this.redis.decr(key);
    if (count < 0) {
      await this.redis.set(key, '0');
      return 0;
    }
    return count;
  }

  async get(key: string): Promise<number> {
    return Number((await this.redis.get(key)) ?? 0);
  }
}

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3 });
}
