/**
 * What every stage is made of.
 *
 * A stage is one re-entrant async function. It never waits for a person: it opens a gate and
 * returns, the runner puts the project down, and an approval decision makes it claimable again — at
 * which point the same function runs again, sees a decided gate, and acts on it.
 *
 * Because of that, a stage may keep nothing in local variables between calls. Everything it needs
 * to resume is rows in Postgres, which is why the whole pipeline survives a restart with no replay
 * machinery, no task queue and no scheduler.
 */

import { Prisma, type PipelineRun } from '@prisma/client';
import { db, logEvent } from './db.js';
import type { GateKey, Settings } from './settings.js';
import type { ChangeRequest } from './agents/index.js';

export type StageResult =
  /** Done — the runner advances to the next stage. */
  | { status: 'COMPLETED' }
  /** A gate is open. The runner leaves this project alone until somebody decides it. */
  | { status: 'AWAITING_APPROVAL' }
  /** Stay in this stage and run it again on the next tick. */
  | { status: 'CONTINUE' }
  /** Needs a human: a bound was exhausted, a gate was rejected, or there was nothing to work on. */
  | { status: 'PARKED'; code: string; reason: string };

export interface StageContext {
  run: PipelineRun;
  settings: Settings;
  /**
   * Persist progress *before* the next expensive thing. A stage that raises its iteration count and
   * then crashes must come back with the raised count, or a bounded loop is not bounded.
   */
  checkpoint(patch: Partial<Pick<PipelineRun, 'iteration'>>): Promise<void>;
  /** Add to the project's spend, and fail the stage if the ceiling is breached. */
  spend(costUsd: number): Promise<void>;
}

export interface Stage {
  key: string;
  name: string;
  run(ctx: StageContext): Promise<StageResult>;
}

// ── Gates ──────────────────────────────────────────────────────────────────

export type GateState =
  | { kind: 'none' }
  | { kind: 'pending' }
  | {
      kind: 'decided';
      id: string;
      decision: string;
      comment: string | null;
      changeRequests: ChangeRequest[];
      decidedBy: string | null;
      context: unknown;
    }
  | { kind: 'expired' };

/**
 * The newest unconsumed request for this gate, and what became of it.
 *
 * `consumed` is what makes a stage safe to re-enter: once it has acted on a decision it marks the
 * row, so running the stage again sees a fresh slate rather than replaying the same approval.
 */
export async function gateState(projectId: string, gate: GateKey): Promise<GateState> {
  const approval = await db.approval.findFirst({
    where: { projectId, gate, consumed: false },
    orderBy: { requestedAt: 'desc' },
  });
  if (!approval) return { kind: 'none' };

  if (approval.status === 'PENDING') {
    if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
      await db.approval.update({ where: { id: approval.id }, data: { status: 'EXPIRED', consumed: true } });
      return { kind: 'expired' };
    }
    return { kind: 'pending' };
  }
  if (approval.status === 'EXPIRED') return { kind: 'expired' };

  return {
    kind: 'decided',
    id: approval.id,
    decision: approval.status,
    comment: approval.comment,
    changeRequests: (approval.changeRequests ?? []) as unknown as ChangeRequest[],
    decidedBy: approval.decidedBy,
    context: approval.context,
  };
}

/**
 * Open a gate and stop.
 *
 * When the gate is switched off in Settings the request is written already approved, so the audit
 * trail records that the decision was automatic and the stage picks it up on the very next tick
 * through exactly the same code path as a human decision.
 */
export async function openGate(
  ctx: StageContext,
  input: { gate: GateKey; title: string; summary: string; context?: Record<string, unknown> },
): Promise<StageResult> {
  const config = ctx.settings.gates[input.gate];
  const auto = !config.requireApproval;

  await db.approval.create({
    data: {
      projectId: ctx.run.projectId,
      gate: input.gate,
      title: input.title,
      summary: input.summary,
      context: (input.context ?? {}) as Prisma.InputJsonValue,
      status: auto ? 'APPROVED' : 'PENDING',
      expiresAt: auto ? null : new Date(Date.now() + config.timeoutHours * 3_600_000),
      decidedAt: auto ? new Date() : null,
      decidedBy: auto ? 'auto-approved (gate disabled in settings)' : null,
    },
  });

  await logEvent(ctx.run.projectId, auto ? 'GATE_AUTO_APPROVED' : 'APPROVAL_REQUESTED', {
    gate: input.gate,
    title: input.title,
  });

  return auto ? { status: 'CONTINUE' } : { status: 'AWAITING_APPROVAL' };
}

/**
 * The decision branch every gated stage shares. The only part that differs between stages is what
 * happens on approval, so that is the only part left to the caller.
 */
export async function settle(
  ctx: StageContext,
  gate: Extract<GateState, { kind: 'decided' }>,
  opts: { rejectedCode: string; maxIterations?: number; exhaustedReason?: string },
): Promise<
  | { kind: 'approved'; decidedBy: string; context: unknown }
  | { kind: 'revise'; changeRequests: ChangeRequest[] }
  | { kind: 'parked'; code: string; reason: string }
> {
  await db.approval.update({ where: { id: gate.id }, data: { consumed: true } });

  if (gate.decision === 'APPROVED') {
    return { kind: 'approved', decidedBy: gate.decidedBy ?? 'system', context: gate.context };
  }
  if (gate.decision === 'REJECTED') {
    return { kind: 'parked', code: opts.rejectedCode, reason: gate.comment ?? 'Rejected at the gate.' };
  }

  // CHANGES_REQUESTED — bounded, because an unbounded revise loop is how a budget disappears
  // overnight with nobody watching.
  const next = ctx.run.iteration + 1;
  if (opts.maxIterations !== undefined && next >= opts.maxIterations) {
    return {
      kind: 'parked',
      code: 'ITERATION_LIMIT',
      reason: opts.exhaustedReason ?? `Revised ${next} times without converging.`,
    };
  }
  return { kind: 'revise', changeRequests: gate.changeRequests };
}

export async function setPhase(projectId: string, phase: string): Promise<void> {
  await db.project.update({ where: { id: projectId }, data: { phase } });
}
