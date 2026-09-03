/**
 * Temporal worker.
 *
 * Four task queues, split by resource profile so a 30-minute Playwright run cannot starve the
 * cheap orchestration activities behind it (docs/01 §1).
 */

import 'dotenv/config';
import { NativeConnection, Worker } from '@temporalio/worker';
import { repoPath } from '@sdlc/shared/node';
import { getLogger } from '@sdlc/observability';
import { bootstrap } from './bootstrap.js';

const log = getLogger({ component: 'worker' });

async function main(): Promise<void> {
  const platform = await bootstrap();
  const { env, activities } = platform;

  const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });

  // Workflow code is bundled from source in dev and from dist in production. Either way it is
  // loaded into the deterministic sandbox — activities are injected separately.
  const workflowsPath = repoPath('packages', 'workflows', 'src', 'index.ts');

  const queues = [
    { queue: env.TEMPORAL_TASK_QUEUE_MAIN, concurrency: 20, withWorkflows: true },
    { queue: env.TEMPORAL_TASK_QUEUE_AGENTS, concurrency: 4, withWorkflows: false },
    { queue: env.TEMPORAL_TASK_QUEUE_TOOLS, concurrency: 8, withWorkflows: false },
    { queue: env.TEMPORAL_TASK_QUEUE_HEAVY, concurrency: 2, withWorkflows: false },
  ];

  const workers = await Promise.all(
    queues.map(({ queue, concurrency, withWorkflows }) =>
      Worker.create({
        connection,
        namespace: env.TEMPORAL_NAMESPACE,
        taskQueue: queue,
        activities,
        maxConcurrentActivityTaskExecutions: concurrency,
        ...(withWorkflows ? { workflowsPath } : {}),
      }),
    ),
  );

  log.info({ queues: queues.map((q) => q.queue) }, 'worker started');

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    for (const worker of workers) worker.shutdown();
    await platform.shutdown();
    await connection.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await Promise.all(workers.map((worker) => worker.run()));
}

main().catch((error: unknown) => {
  log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'worker failed');
  process.exit(1);
});
