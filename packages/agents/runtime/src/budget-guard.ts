/**
 * Budget guard — docs/04 §2, docs/59.
 *
 * Every autonomous loop has attempt, cost, token and wall-clock ceilings (invariant I6). The guard
 * is checked before every provider call and every tool call, so a runaway agent halts at a known
 * boundary with a spend report instead of grinding until someone notices the bill.
 *
 * Local and subscription models still consume iterations and wall-clock even though their dollar
 * cost is zero — otherwise "free" models would be unbounded, which is the worst of both worlds.
 */

import { BudgetExceededError, type AgentBudget } from '@sdlc/shared';

export interface BudgetSnapshot {
  costUsd: number;
  tokens: number;
  toolCalls: number;
  iterations: number;
  elapsedSeconds: number;
  quotaUnits: number;
}

export interface BudgetHeadroom {
  costUsd: number;
  tokens: number;
  toolCalls: number;
  iterations: number;
  seconds: number;
}

export class BudgetGuard {
  private costUsd = 0;
  private tokens = 0;
  private toolCalls = 0;
  private iterations = 0;
  private quotaUnits = 0;
  private readonly startedAt = Date.now();
  private readonly budget: AgentBudget;

  /**
   * @param agentBudget the agent's own ceilings
   * @param workflowCeilings tighter limits imposed by the parent workflow; the minimum wins, so a
   *        workflow can restrict an agent but never grant it more than its definition allows.
   */
  constructor(agentBudget: AgentBudget, workflowCeilings: Partial<AgentBudget> = {}) {
    this.budget = {
      maxCostUsd: min(agentBudget.maxCostUsd, workflowCeilings.maxCostUsd),
      maxTokens: min(agentBudget.maxTokens, workflowCeilings.maxTokens),
      maxToolCalls: min(agentBudget.maxToolCalls, workflowCeilings.maxToolCalls),
      maxIterations: min(agentBudget.maxIterations, workflowCeilings.maxIterations),
      maxWallClockSeconds: min(agentBudget.maxWallClockSeconds, workflowCeilings.maxWallClockSeconds),
    };
  }

  get limits(): AgentBudget {
    return this.budget;
  }

  snapshot(): BudgetSnapshot {
    return {
      costUsd: round(this.costUsd, 6),
      tokens: this.tokens,
      toolCalls: this.toolCalls,
      iterations: this.iterations,
      elapsedSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      quotaUnits: this.quotaUnits,
    };
  }

  headroom(): BudgetHeadroom {
    const snapshot = this.snapshot();
    return {
      costUsd: round(this.budget.maxCostUsd - snapshot.costUsd, 6),
      tokens: this.budget.maxTokens - snapshot.tokens,
      toolCalls: this.budget.maxToolCalls - snapshot.toolCalls,
      iterations: this.budget.maxIterations - snapshot.iterations,
      seconds: this.budget.maxWallClockSeconds - snapshot.elapsedSeconds,
    };
  }

  /** Called before each tool-loop turn. Throws rather than returning a flag callers can ignore. */
  assertCanIterate(): void {
    this.assertWithinWallClock();
    if (this.iterations >= this.budget.maxIterations) {
      throw this.exceeded('maxIterations', this.iterations, this.budget.maxIterations);
    }
  }

  assertCanCallTool(): void {
    this.assertWithinWallClock();
    if (this.toolCalls >= this.budget.maxToolCalls) {
      throw this.exceeded('maxToolCalls', this.toolCalls, this.budget.maxToolCalls);
    }
  }

  /**
   * Pre-flight cost check. Declining before the call beats halting after it: the money is spent
   * either way, but only one of those produces a usable artifact.
   */
  assertCanAfford(estimatedCostUsd: number): void {
    this.assertWithinWallClock();
    if (this.costUsd + estimatedCostUsd > this.budget.maxCostUsd) {
      throw this.exceeded('maxCostUsd', this.costUsd + estimatedCostUsd, this.budget.maxCostUsd, {
        estimatedCostUsd,
      });
    }
  }

  recordIteration(): void {
    this.iterations += 1;
  }

  recordToolCall(): void {
    this.toolCalls += 1;
  }

  recordUsage(usage: { costUsd: number; tokens: number; quotaUnits?: number }): void {
    this.costUsd += usage.costUsd;
    this.tokens += usage.tokens;
    this.quotaUnits += usage.quotaUnits ?? 0;

    // Post-hoc checks: a single oversized response can breach a ceiling the pre-flight estimate
    // did not predict, and the run must stop at that point rather than on the next turn.
    if (this.costUsd > this.budget.maxCostUsd) {
      throw this.exceeded('maxCostUsd', this.costUsd, this.budget.maxCostUsd);
    }
    if (this.tokens > this.budget.maxTokens) {
      throw this.exceeded('maxTokens', this.tokens, this.budget.maxTokens);
    }
  }

  private assertWithinWallClock(): void {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    if (elapsed > this.budget.maxWallClockSeconds) {
      throw this.exceeded('maxWallClockSeconds', Math.round(elapsed), this.budget.maxWallClockSeconds);
    }
  }

  private exceeded(
    limit: keyof AgentBudget,
    actual: number,
    allowed: number,
    extra: Record<string, unknown> = {},
  ): BudgetExceededError {
    return new BudgetExceededError({
      limit,
      actual,
      allowed,
      spend: this.snapshot(),
      ...extra,
    });
  }
}

function min(a: number, b: number | undefined): number {
  return b === undefined ? a : Math.min(a, b);
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
