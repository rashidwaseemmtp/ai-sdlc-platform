import { describe, it, expect, vi, afterEach } from 'vitest';
import { BudgetExceededError, type AgentBudget } from '@sdlc/shared';
import { BudgetGuard } from './budget-guard.js';

const budget = (over: Partial<AgentBudget> = {}): AgentBudget => ({
  maxCostUsd: 5,
  maxTokens: 100_000,
  maxToolCalls: 10,
  maxIterations: 5,
  maxWallClockSeconds: 600,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('invariant I6 — every autonomous loop is bounded', () => {
  it('halts a runaway tool loop at maxIterations', () => {
    const guard = new BudgetGuard(budget({ maxIterations: 3 }));
    for (let i = 0; i < 3; i += 1) {
      guard.assertCanIterate();
      guard.recordIteration();
    }
    expect(() => guard.assertCanIterate()).toThrow(BudgetExceededError);
  });

  it('halts a runaway tool caller at maxToolCalls', () => {
    const guard = new BudgetGuard(budget({ maxToolCalls: 2 }));
    guard.assertCanCallTool();
    guard.recordToolCall();
    guard.assertCanCallTool();
    guard.recordToolCall();
    expect(() => guard.assertCanCallTool()).toThrow(/maxToolCalls/);
  });

  it('declines a call it cannot afford rather than halting after paying for it', () => {
    const guard = new BudgetGuard(budget({ maxCostUsd: 1 }));
    guard.recordUsage({ costUsd: 0.8, tokens: 1000 });
    expect(() => guard.assertCanAfford(0.5)).toThrow(/maxCostUsd/);
    // Still affordable within the remaining headroom.
    expect(() => guard.assertCanAfford(0.1)).not.toThrow();
  });

  it('stops mid-run when one oversized response blows the ceiling', () => {
    const guard = new BudgetGuard(budget({ maxCostUsd: 1 }));
    // The pre-flight estimate said this was affordable; the actual response was not.
    guard.assertCanAfford(0.5);
    expect(() => guard.recordUsage({ costUsd: 1.4, tokens: 500 })).toThrow(/maxCostUsd/);
  });

  it('stops on the token ceiling', () => {
    const guard = new BudgetGuard(budget({ maxTokens: 1000 }));
    expect(() => guard.recordUsage({ costUsd: 0, tokens: 1500 })).toThrow(/maxTokens/);
  });

  it('bounds free models too — zero cost is not unbounded', () => {
    vi.useFakeTimers();
    // A local or subscription model costs nothing, so only wall-clock and iterations can stop it.
    const guard = new BudgetGuard(budget({ maxCostUsd: 1000, maxWallClockSeconds: 60 }));
    guard.recordUsage({ costUsd: 0, tokens: 10, quotaUnits: 1 });

    vi.advanceTimersByTime(61_000);
    expect(() => guard.assertCanIterate()).toThrow(/maxWallClockSeconds/);
  });

  it('reports the spend that led to the stop', () => {
    const guard = new BudgetGuard(budget({ maxIterations: 1 }));
    guard.recordIteration();
    guard.recordUsage({ costUsd: 0.25, tokens: 4000, quotaUnits: 2 });

    try {
      guard.assertCanIterate();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BudgetExceededError).details).toMatchObject({
        limit: 'maxIterations',
        spend: expect.objectContaining({ costUsd: 0.25, tokens: 4000, quotaUnits: 2 }),
      });
    }
  });
});

describe('workflow ceilings', () => {
  it('lets a workflow tighten an agent budget', () => {
    const guard = new BudgetGuard(budget({ maxCostUsd: 10 }), { maxCostUsd: 2 });
    expect(guard.limits.maxCostUsd).toBe(2);
  });

  it('never lets a workflow grant more than the agent definition allows', () => {
    const guard = new BudgetGuard(budget({ maxCostUsd: 2 }), { maxCostUsd: 100 });
    expect(guard.limits.maxCostUsd).toBe(2);
  });

  it('reports remaining headroom on every axis', () => {
    const guard = new BudgetGuard(budget({ maxCostUsd: 5, maxIterations: 4 }));
    guard.recordIteration();
    guard.recordUsage({ costUsd: 1.5, tokens: 2000 });

    const headroom = guard.headroom();
    expect(headroom.costUsd).toBeCloseTo(3.5, 5);
    expect(headroom.iterations).toBe(3);
    expect(headroom.tokens).toBe(98_000);
  });
});
