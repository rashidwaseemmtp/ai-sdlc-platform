/**
 * Shared API services: database, Temporal client, event stream.
 *
 * The API's entire role in agent execution is `start`, `signal`, `query`. It never runs an agent —
 * that lives in the worker, behind Temporal, so a request can never block on a twenty-minute model
 * call and an API restart can never lose work in flight (docs/01 §2).
 */

import { Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { Redis } from 'ioredis';
import { getPrisma, type PrismaClient } from '@sdlc/database';
import { loadEnv, loadFileConfig, repoPath } from '@sdlc/shared/node';
import type { Env } from '@sdlc/shared';
import { getLogger } from '@sdlc/observability';

const log = getLogger({ component: 'api' });

@Injectable()
export class ConfigService {
  readonly env: Env = loadEnv();
  readonly config = loadFileConfig(repoPath('config'));
}

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient = getPrisma();

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

@Injectable()
export class TemporalService implements OnModuleInit, OnModuleDestroy {
  private connection?: Connection;
  private clientInstance?: Client;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      this.connection = await Connection.connect({ address: this.config.env.TEMPORAL_ADDRESS });
      this.clientInstance = new Client({
        connection: this.connection,
        namespace: this.config.env.TEMPORAL_NAMESPACE,
      });
      log.info({ address: this.config.env.TEMPORAL_ADDRESS }, 'connected to Temporal');
    } catch (error) {
      // The API stays up without Temporal: read endpoints still work, and the dashboard shows the
      // outage rather than refusing to load.
      log.error({ error: (error as Error).message }, 'could not connect to Temporal');
    }
  }

  get client(): Client {
    if (!this.clientInstance) {
      throw new NotFoundException('Temporal is unavailable; workflow operations are disabled');
    }
    return this.clientInstance;
  }

  get available(): boolean {
    return Boolean(this.clientInstance);
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }
}

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private redis?: Redis;
  private listeners = new Set<(frame: EventFrame) => void>();
  private stopped = false;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      this.redis = new Redis(this.config.env.REDIS_URL, { maxRetriesPerRequest: null });
      void this.tail();
    } catch (error) {
      log.warn({ error: (error as Error).message }, 'event stream unavailable');
    }
  }

  subscribe(listener: (frame: EventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tail the Redis stream the worker publishes to, and fan out to SSE subscribers. */
  private async tail(): Promise<void> {
    if (!this.redis) return;
    let cursor = '$';

    while (!this.stopped) {
      try {
        const response = (await this.redis.xread('BLOCK', 5000, 'STREAMS', 'sdlc:events', cursor)) as
          | [string, [string, string[]][]][]
          | null;
        if (!response) continue;

        for (const [, entries] of response) {
          for (const [id, fields] of entries) {
            cursor = id;
            const topic = fields[fields.indexOf('topic') + 1] ?? 'unknown';
            const raw = fields[fields.indexOf('payload') + 1] ?? '{}';
            const payload = JSON.parse(raw) as Record<string, unknown>;
            const frame: EventFrame = {
              id,
              type: topic,
              projectId: typeof payload.projectId === 'string' ? payload.projectId : undefined,
              payload,
              at: new Date().toISOString(),
            };
            for (const listener of this.listeners) listener(frame);
          }
        }
      } catch (error) {
        if (this.stopped) return;
        log.warn({ error: (error as Error).message }, 'event tail error; retrying');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.redis?.disconnect();
  }
}

export interface EventFrame {
  id: string;
  type: string;
  projectId?: string;
  payload: Record<string, unknown>;
  at: string;
}
