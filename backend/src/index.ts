/**
 * The backend: one process.
 *
 * It serves the API and it runs the pipeline. There is no separate worker, no message broker and no
 * orchestrator — the runner is a `setTimeout` loop in the same process, claiming work from Postgres.
 * If you need more throughput, start a second copy: the claim is `FOR UPDATE SKIP LOCKED`, so they
 * cooperate without knowing about each other.
 */

import express from 'express';
import cors from 'cors';
import { db } from './db.js';
import { closeAllServers } from './mcp.js';
import { api } from './routes.js';
import { Runner } from './runner.js';

const PORT = Number(process.env.PORT ?? 3001);

async function main(): Promise<void> {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' })); // source documents can be long transcripts
  app.use('/api', api);

  const runner = new Runner();
  await runner.recoverStaleClaims();
  runner.start();

  const server = app.listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT}/api`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[shutdown] ${signal} — finishing in-flight stages`);
    server.close();
    await runner.stop();
    // stdio MCP servers are child processes; they must not outlive the backend.
    await closeAllServers();
    await db.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[fatal]', error);
  process.exit(1);
});
