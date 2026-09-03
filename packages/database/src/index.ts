/**
 * @sdlc/database — Prisma client and connection lifecycle.
 *
 * PostgreSQL is the source of truth (docs/00 §3). Temporal holds control flow only, so every
 * durable fact the platform knows is readable here with plain SQL.
 */

import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

let client: PrismaClient | undefined;

/** Process-wide singleton; the worker and the API each hold exactly one. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log:
        process.env.LOG_LEVEL === 'debug'
          ? [{ emit: 'stdout', level: 'query' }, 'warn', 'error']
          : ['warn', 'error'],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

/** Used by the doctor script and the API health endpoint. */
export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: (error as Error).message };
  }
}
