/**
 * Token estimation and cost calculation.
 *
 * Estimation is deliberately conservative: the router uses it to check a context package fits a
 * model's window, and to price a run *before* spending. Under-estimating causes a mid-run
 * truncation, so we round up rather than down.
 */

import type { CatalogEntry, ChatMessage, ModelUsage } from '@sdlc/shared';

/**
 * Characters-per-token is model-family dependent; 3.4 is conservative (English prose is ~4).
 * Providers exposing a real tokenizer override this through `countTokens`.
 */
const CHARS_PER_TOKEN = 3.4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(messages: ChatMessage[], system?: string): number {
  let total = system ? estimateTokens(system) : 0;
  for (const message of messages) {
    total += 4; // per-message envelope overhead
    if (typeof message.content === 'string') {
      total += estimateTokens(message.content);
    } else {
      for (const block of message.content) {
        if (block.text) total += estimateTokens(block.text);
        if (block.input) total += estimateTokens(JSON.stringify(block.input));
        if (block.content) total += estimateTokens(JSON.stringify(block.content));
      }
    }
  }
  return total;
}

export interface CostResult {
  costUsd: number;
  /** True when the catalog holds no verified price. We report unknown rather than inventing one. */
  costUnknown: boolean;
  quotaUnits: number;
}

export function calculateCost(entry: CatalogEntry, usage: ModelUsage): CostResult {
  if (entry.billingMode === 'SUBSCRIPTION') {
    // A subscription is metered in requests against a seat, not in dollars.
    return { costUsd: 0, costUnknown: false, quotaUnits: 1 };
  }
  if (entry.billingMode === 'LOCAL_FREE') {
    return { costUsd: 0, costUnknown: false, quotaUnits: 0 };
  }
  if (entry.inputCostPer1M === null || entry.outputCostPer1M === null) {
    return { costUsd: 0, costUnknown: true, quotaUnits: 0 };
  }

  const cachedRate = entry.cachedInputCostPer1M ?? entry.inputCostPer1M;
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedReadTokens);

  const costUsd =
    (freshInput / 1_000_000) * entry.inputCostPer1M +
    (usage.cachedReadTokens / 1_000_000) * cachedRate +
    (usage.outputTokens / 1_000_000) * entry.outputCostPer1M;

  return { costUsd: round(costUsd, 6), costUnknown: false, quotaUnits: 0 };
}

/** Pre-flight estimate, used to decline a run before it spends rather than halt it midway. */
export function estimateCost(
  entry: CatalogEntry,
  inputTokens: number,
  expectedOutput: number,
): CostResult {
  return calculateCost(entry, {
    inputTokens,
    outputTokens: expectedOutput,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  });
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

export function emptyUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };
}

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cachedWriteTokens: a.cachedWriteTokens + b.cachedWriteTokens,
  };
}
