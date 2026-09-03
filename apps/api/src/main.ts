/**
 * API server.
 *
 * Request/response only. It writes the database, starts and signals workflows, and streams events —
 * it never executes an agent, so no request can block on a model call (docs/01 §2).
 */

import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { getLogger } from '@sdlc/observability';
import { loadEnv } from '@sdlc/shared/node';
import { AppModule } from './app.module.js';

const log = getLogger({ component: 'api' });

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });

  app.enableCors({
    origin: [`http://localhost:${env.DASHBOARD_PORT}`, 'http://127.0.0.1:3000'],
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen(env.API_PORT);
  log.info({ port: env.API_PORT }, 'api listening');
}

main().catch((error: unknown) => {
  log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'api failed to start');
  process.exit(1);
});
