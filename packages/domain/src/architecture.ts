/**
 * Architecture scoring — docs/12.
 *
 * The critic supplies per-criterion scores; this turns them into a weighted recommendation. It is
 * deliberately separate from the agent: the *arithmetic* of a recommendation should not be
 * something a language model is trusted to do, and keeping it here makes the scorecard auditable.
 */

export const ARCH_CRITERIA = [
  'DEVELOPMENT_SPEED',
  'COST',
  'SCALABILITY',
  'SECURITY',
  'MAINTAINABILITY',
  'OPERATIONAL_COMPLEXITY',
  'TEAM_FIT',
  'PERFORMANCE',
  'FUTURE_EXTENSIBILITY',
  'RISK',
] as const;

export type ArchCriterion = (typeof ARCH_CRITERIA)[number];

export const DEFAULT_WEIGHTS: Record<ArchCriterion, number> = {
  DEVELOPMENT_SPEED: 1.0,
  COST: 1.0,
  SCALABILITY: 1.0,
  SECURITY: 1.5,
  MAINTAINABILITY: 1.25,
  OPERATIONAL_COMPLEXITY: 1.0,
  TEAM_FIT: 1.0,
  PERFORMANCE: 1.0,
  FUTURE_EXTENSIBILITY: 0.75,
  RISK: 1.5,
};

export interface CriterionScore {
  criterion: ArchCriterion;
  score: number; // 0–10
  reasoning: string;
}

export interface OptionScores {
  optionId: string;
  variant: string;
  name: string;
  scores: CriterionScore[];
}

export interface ScoredOption {
  optionId: string;
  variant: string;
  name: string;
  weightedScore: number;
  rawMean: number;
  strengths: ArchCriterion[];
  weaknesses: ArchCriterion[];
  missingCriteria: ArchCriterion[];
}

export interface Recommendation {
  recommendedOptionId: string;
  ranked: ScoredOption[];
  margin: number;
  /** True when the top two are within `closeCallMargin` — a human should read both. */
  closeCall: boolean;
  belowThreshold: string[];
  reasoning: string;
}

export interface ScoringOptions {
  weights?: Partial<Record<ArchCriterion, number>>;
  /** Options scoring below this are unfit to present for approval. */
  minimumScore?: number;
  closeCallMargin?: number;
}

export function scoreOptions(options: OptionScores[], config: ScoringOptions = {}): ScoredOption[] {
  const weights = { ...DEFAULT_WEIGHTS, ...(config.weights ?? {}) };

  return options
    .map((option) => {
      const seen = new Map(option.scores.map((s) => [s.criterion, s]));
      const missing = ARCH_CRITERIA.filter((criterion) => !seen.has(criterion));

      let weightedTotal = 0;
      let weightTotal = 0;
      for (const [criterion, entry] of seen) {
        const weight = weights[criterion] ?? 1;
        weightedTotal += entry.score * weight;
        weightTotal += weight;
      }

      const sorted = [...seen.values()].sort((a, b) => b.score - a.score);

      return {
        optionId: option.optionId,
        variant: option.variant,
        name: option.name,
        weightedScore: weightTotal ? round(weightedTotal / weightTotal, 2) : 0,
        rawMean: seen.size
          ? round([...seen.values()].reduce((sum, s) => sum + s.score, 0) / seen.size, 2)
          : 0,
        strengths: sorted.slice(0, 3).map((s) => s.criterion),
        weaknesses: sorted.slice(-3).reverse().map((s) => s.criterion),
        missingCriteria: missing,
      };
    })
    .sort((a, b) => b.weightedScore - a.weightedScore);
}

export function recommend(options: OptionScores[], config: ScoringOptions = {}): Recommendation {
  const minimumScore = config.minimumScore ?? 5;
  const closeCallMargin = config.closeCallMargin ?? 0.5;
  const ranked = scoreOptions(options, config);

  if (ranked.length === 0) {
    throw new Error('cannot recommend an architecture with no scored options');
  }

  const [best, second] = ranked;
  const margin = second ? round(best!.weightedScore - second.weightedScore, 2) : best!.weightedScore;
  const closeCall = Boolean(second) && margin < closeCallMargin;
  const belowThreshold = ranked
    .filter((option) => option.weightedScore < minimumScore)
    .map((option) => option.variant);

  const reasoningParts = [
    `Option ${best!.variant} (${best!.name}) scores ${best!.weightedScore}/10 weighted.`,
    `Strongest on ${best!.strengths.join(', ')}; weakest on ${best!.weaknesses.join(', ')}.`,
  ];
  if (second) {
    reasoningParts.push(
      `Option ${second.variant} follows at ${second.weightedScore}, a margin of ${margin}.`,
    );
  }
  if (closeCall) {
    reasoningParts.push(
      'The top two are within the close-call margin, so the choice is a judgement call rather ' +
        'than a clear win — the approver should read both.',
    );
  }
  if (belowThreshold.length) {
    reasoningParts.push(
      `Options ${belowThreshold.join(', ')} score below the ${minimumScore} threshold and are not ` +
        'fit to present as viable.',
    );
  }

  return {
    recommendedOptionId: best!.optionId,
    ranked,
    margin,
    closeCall,
    belowThreshold,
    reasoning: reasoningParts.join(' '),
  };
}

/** Every option below the threshold means the round failed — regenerate rather than approve. */
export function requiresRegeneration(recommendation: Recommendation, minimumScore = 5): boolean {
  return recommendation.ranked.every((option) => option.weightedScore < minimumScore);
}

/**
 * Strip authorship and shuffle labels before handing options to the critic, so it cannot anchor
 * on "option A is always the first-listed one" (docs/04 §4).
 */
export function blindOptions<T extends { optionId: string; variant: string }>(
  options: T[],
  seed: string,
): { blind: (Omit<T, 'variant'> & { label: string })[]; mapping: Record<string, string> } {
  const labels = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
  const order = deterministicShuffle(
    options.map((_, index) => index),
    seed,
  );

  const blind: (Omit<T, 'variant'> & { label: string })[] = [];
  const mapping: Record<string, string> = {};

  for (const [position, originalIndex] of order.entries()) {
    const option = options[originalIndex]!;
    const label = labels[position] ?? `Option${position}`;
    const { variant: _variant, ...rest } = option;
    blind.push({ ...(rest as Omit<T, 'variant'>), label });
    mapping[label] = option.optionId;
  }

  return { blind, mapping };
}

/** Seeded shuffle — deterministic so a workflow replay produces the same ordering. */
function deterministicShuffle(items: number[], seed: string): number[] {
  const out = [...items];
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;

  for (let i = out.length - 1; i > 0; i -= 1) {
    hash = (hash * 1664525 + 1013904223) >>> 0;
    const j = hash % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
