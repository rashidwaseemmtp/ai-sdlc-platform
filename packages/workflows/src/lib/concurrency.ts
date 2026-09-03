/**
 * Workflow-side concurrency limiting.
 *
 * Built from `condition()`, not from sleeping. A sleep-based limiter would burn workflow history
 * on timers and would not release a slot the moment one frees up.
 */

import { condition } from '@temporalio/workflow';

export class WorkflowSemaphore {
  private inFlight = 0;

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await condition(() => this.inFlight < this.limit);
    this.inFlight += 1;
    try {
      return await task();
    } finally {
      this.inFlight -= 1;
    }
  }

  get active(): number {
    return this.inFlight;
  }
}

/** Run tasks with a bounded number in flight, preserving input order in the results. */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const semaphore = new WorkflowSemaphore(Math.max(1, limit));
  return Promise.all(items.map((item, index) => semaphore.run(() => task(item, index))));
}
