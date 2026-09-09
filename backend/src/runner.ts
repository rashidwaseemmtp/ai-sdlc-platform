/**
 * The runner.
 *
 * Claim a runnable project, execute one stage, checkpoint, release. That is the whole loop, and it
 * is deliberately the whole loop: no scheduler, no task queue, no workflow engine. Durability comes
 * from the fact that nothing lives between two stage calls except rows.
 *
 * Running several copies of the backend is safe. The claim is a single `FOR UPDATE SKIP LOCKED`
 * statement, so two processes take different projects and never the same one — multi-project
 * concurrency is a property of that query rather than a feature anybody had to build.
 *
 * What this does not do, and a workflow engine would: guarantee a step runs exactly once. A stage
 * killed mid-model-call is re-run from the top of that stage, which can mean paying for a duplicate
 * call. That is the honest cost of not running a workflow engine.
 */

import { randomUUID } from 'node:crypto';
import type { PipelineRun } from '@prisma/client';
import { db, logEvent } from './db.js';
import { NotConfiguredError } from './llm.js';
import { nextStageKey, stageByKey, type StageContext } from './pipeline.js';
import { getSettings } from './settings.js';

/** A claim older than this is assumed to belong to a process that died holding it. */
const STALE_CLAIM_MS = 5 * 60_000;
/** Consecutive transient failures of one stage before it parks for a human. */
const MAX_ATTEMPTS = 3;

export class Runner {
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  /** Reclaim anything a previous process was holding when it died. Without this, a `kill -9` leaves a project RUNNING forever. */
  async recoverStaleClaims(): Promise<number> {
    const { count } = await db.pipelineRun.updateMany({
      where: { status: 'RUNNING', claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
      data: { status: 'RUNNABLE', claimedBy: null, claimedAt: null },
    });
    if (count > 0) console.warn(`[runner] reclaimed ${count} run(s) abandoned by a dead worker`);
    return count;
  }

  start(): void {
    const tick = async (): Promise<void> => {
      if (this.stopping) return;
      let pollMs = 2000;
      try {
        const settings = await getSettings();
        pollMs = settings.runner.pollMs;
        await this.tick(settings.runner.maxConcurrentRuns);
      } catch (error) {
        console.error('[runner] tick failed:', (error as Error).message);
      }
      if (!this.stopping) this.timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    console.log(`[runner] ${this.workerId} started`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    // Let in-flight stages finish so their checkpoint lands; they are not interruptible.
    const deadline = Date.now() + 30_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** One pass: top up to the concurrency ceiling with newly claimed projects. */
  private async tick(ceiling: number): Promise<void> {
    while (this.inFlight.size < ceiling) {
      const run = await this.claim();
      if (!run) return;
      this.inFlight.add(run.id);
      void this.execute(run).finally(() => this.inFlight.delete(run.id));
    }
  }

  /**
   * Atomically take one runnable project.
   *
   * Raw SQL because SKIP LOCKED is the point: two workers polling at the same instant must take
   * different rows rather than one blocking on the other's lock.
   */
  private async claim(): Promise<PipelineRun | undefined> {
    const rows = await db.$queryRaw<PipelineRun[]>`
      UPDATE pipeline_runs
         SET status = 'RUNNING', "claimedBy" = ${this.workerId}, "claimedAt" = now(), "updatedAt" = now()
       WHERE id = (
         SELECT id FROM pipeline_runs
          WHERE status = 'RUNNABLE'
          ORDER BY "updatedAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
      RETURNING *`;
    return rows[0];
  }

  /** Execute exactly one stage for one project, then persist the outcome. */
  private async execute(claimed: PipelineRun): Promise<void> {
    let run = claimed;
    const stage = stageByKey(run.stage);
    if (!stage) {
      await this.park(run, 'UNKNOWN_STAGE', `No stage is registered under "${run.stage}".`);
      return;
    }

    const settings = await getSettings();
    const ctx: StageContext = {
      run,
      settings,
      checkpoint: async (patch) => {
        run = await db.pipelineRun.update({ where: { id: run.id }, data: patch });
        ctx.run = run;
      },
      spend: async (costUsd) => {
        if (!costUsd) return;
        run = await db.pipelineRun.update({
          where: { id: run.id },
          data: { spendUsd: { increment: costUsd } },
        });
        ctx.run = run;
        const ceiling = settings.limits.projectCostUsd;
        if (ceiling > 0 && run.spendUsd > ceiling) {
          throw new BudgetError(
            `This project has spent $${run.spendUsd.toFixed(2)} against a ceiling of $${ceiling.toFixed(2)}. ` +
              'Raise the ceiling in Settings and resume, or leave it parked.',
          );
        }
      },
    };

    console.log(`[runner] ${run.projectId} · ${run.stage} · iteration ${run.iteration}`);

    try {
      const result = await stage.run(ctx);
      run = ctx.run;

      if (result.status === 'AWAITING_APPROVAL') {
        await db.pipelineRun.update({
          where: { id: run.id },
          data: { status: 'AWAITING_APPROVAL', attempts: 0, claimedBy: null, claimedAt: null },
        });
        return;
      }

      if (result.status === 'PARKED') {
        await this.park(run, result.code, result.reason);
        return;
      }

      if (result.status === 'CONTINUE') {
        await db.pipelineRun.update({
          where: { id: run.id },
          data: { status: 'RUNNABLE', attempts: 0, claimedBy: null, claimedAt: null },
        });
        return;
      }

      const next = nextStageKey(run.stage);
      await db.pipelineRun.update({
        where: { id: run.id },
        data: {
          completedStages: { push: run.stage },
          iteration: 0,
          attempts: 0,
          claimedBy: null,
          claimedAt: null,
          ...(next
            ? { stage: next, status: 'RUNNABLE' }
            : { status: 'COMPLETED', finishedAt: new Date() }),
        },
      });

      if (!next) {
        await db.project.update({ where: { id: run.projectId }, data: { phase: 'COMPLETED' } });
        await logEvent(run.projectId, 'PROJECT_COMPLETED', { spendUsd: run.spendUsd });
      }
    } catch (error) {
      await this.fail(ctx.run, error);
    }
  }

  /** Retry a transient failure a bounded number of times; park anything that will not get better. */
  private async fail(run: PipelineRun, error: unknown): Promise<void> {
    const message = (error as Error).message;
    const attempts = run.attempts + 1;
    // A budget breach or an unconfigured provider will fail identically on the next attempt, so
    // retrying either just spends time — or money — to reach the same conclusion.
    const permanent = error instanceof BudgetError || error instanceof NotConfiguredError;
    const retryable = !permanent && attempts < MAX_ATTEMPTS;

    if (retryable) {
      console.warn(`[runner] ${run.projectId} · ${run.stage} failed (attempt ${attempts}): ${message}`);
      await db.pipelineRun.update({
        where: { id: run.id },
        data: { status: 'RUNNABLE', attempts, claimedBy: null, claimedAt: null },
      });
      return;
    }

    const code = error instanceof BudgetError
      ? 'BUDGET_EXCEEDED'
      : error instanceof NotConfiguredError
        ? 'NOT_CONFIGURED'
        : 'STAGE_FAILED';
    await this.park(run, code, message);
  }

  private async park(run: PipelineRun, code: string, reason: string): Promise<void> {
    await db.pipelineRun.update({
      where: { id: run.id },
      data: { status: 'PARKED', parkedCode: code, parkedReason: reason, claimedBy: null, claimedAt: null },
    });
    await logEvent(run.projectId, 'RUN_PARKED', { stage: run.stage, code, reason });
    console.warn(`[runner] ${run.projectId} parked at ${run.stage}: ${code} — ${reason}`);
  }
}

export class BudgetError extends Error {}
