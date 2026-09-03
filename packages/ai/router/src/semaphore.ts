/**
 * Capacity semaphore.
 *
 * A subscription seat and a local GPU slot are both scarce, serial resources. Without this, the
 * architecture phase would schedule three parallel agents onto one `claude` seat and they would
 * queue invisibly behind each other — or worse, fail.
 *
 * Redis-backed so it holds across workers; in-memory for tests.
 */

export interface SemaphoreStore {
  incr(key: string, ttlSeconds: number): Promise<number>;
  decr(key: string): Promise<number>;
  get(key: string): Promise<number>;
}

export class InMemorySemaphoreStore implements SemaphoreStore {
  private counts = new Map<string, number>();

  async incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async decr(key: string): Promise<number> {
    const next = Math.max(0, (this.counts.get(key) ?? 0) - 1);
    this.counts.set(key, next);
    return next;
  }

  async get(key: string): Promise<number> {
    return this.counts.get(key) ?? 0;
  }
}

export interface Lease {
  release(): Promise<void>;
}

export class CapacitySemaphore {
  constructor(
    private readonly store: SemaphoreStore,
    /** Safety valve: a crashed worker must not hold a seat forever. */
    private readonly leaseTtlSeconds = 3600,
  ) {}

  async available(resource: string, limit: number): Promise<boolean> {
    return (await this.store.get(this.key(resource))) < limit;
  }

  /**
   * Try to take a slot. Returns null when full — the router then skips this candidate rather than
   * blocking the activity, so the fallback chain does the waiting instead of the worker thread.
   */
  async tryAcquire(resource: string, limit: number): Promise<Lease | null> {
    const key = this.key(resource);
    const count = await this.store.incr(key, this.leaseTtlSeconds);
    if (count > limit) {
      await this.store.decr(key);
      return null;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.store.decr(key);
      },
    };
  }

  private key(resource: string): string {
    return `sdlc:capacity:${resource}`;
  }
}
