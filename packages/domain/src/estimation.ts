/**
 * Estimation maths — docs/14, docs/15.
 *
 * The governing rule: an AI estimate is never presented as a commitment. Every estimate carries a
 * confidence and a planning range, and a large disagreement between two independent estimators
 * forces a human review rather than being averaged away.
 */

export interface EstimateInput {
  storyRef: string;
  estimatorKind: 'PRIMARY' | 'INDEPENDENT' | 'HUMAN';
  hoursEngineering: number;
  confidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  rangeLowHours: number;
  rangeHighHours: number;
}

export type VarianceStatus = 'ACCEPTED' | 'ESTIMATION_REVIEW_REQUIRED';

export interface VarianceResult {
  storyRef: string;
  primaryHours: number;
  independentHours: number;
  variancePct: number;
  status: VarianceStatus;
  /** Presented to a human as a planning range, never as a single committed number. */
  recommendedRange: { lowHours: number; highHours: number };
  rationale: string;
}

/**
 * Variance is measured against the *smaller* estimate, which is the conservative reading: if one
 * estimator says 24h and another says 38h, that is a 58% disagreement, not 37%.
 */
export function computeVariance(
  primary: EstimateInput,
  independent: EstimateInput,
  threshold = 0.3,
): VarianceResult {
  const low = Math.min(primary.hoursEngineering, independent.hoursEngineering);
  const high = Math.max(primary.hoursEngineering, independent.hoursEngineering);
  const variancePct = low === 0 ? (high === 0 ? 0 : 1) : (high - low) / low;

  const requiresReview = variancePct > threshold;

  return {
    storyRef: primary.storyRef,
    primaryHours: primary.hoursEngineering,
    independentHours: independent.hoursEngineering,
    variancePct: round(variancePct, 4),
    status: requiresReview ? 'ESTIMATION_REVIEW_REQUIRED' : 'ACCEPTED',
    recommendedRange: {
      lowHours: round(Math.min(primary.rangeLowHours, independent.rangeLowHours), 1),
      highHours: round(Math.max(primary.rangeHighHours, independent.rangeHighHours), 1),
    },
    rationale: requiresReview
      ? `Estimators disagree by ${(variancePct * 100).toFixed(0)}% (${low}h vs ${high}h), over the ` +
        `${(threshold * 100).toFixed(0)}% threshold. A human must reconcile before this is planned.`
      : `Estimators agree within ${(variancePct * 100).toFixed(0)}%.`,
  };
}

export interface PlanningSummary {
  totalHours: number;
  rangeLowHours: number;
  rangeHighHours: number;
  meanConfidence: number;
  storiesNeedingReview: string[];
  highRiskStories: string[];
}

export function summariseEstimates(
  estimates: EstimateInput[],
  variances: VarianceResult[],
): PlanningSummary {
  const primary = estimates.filter((e) => e.estimatorKind === 'PRIMARY');
  const totalHours = primary.reduce((sum, e) => sum + e.hoursEngineering, 0);

  return {
    totalHours: round(totalHours, 1),
    rangeLowHours: round(
      primary.reduce((sum, e) => sum + e.rangeLowHours, 0),
      1,
    ),
    rangeHighHours: round(
      primary.reduce((sum, e) => sum + e.rangeHighHours, 0),
      1,
    ),
    meanConfidence: primary.length
      ? round(primary.reduce((sum, e) => sum + e.confidence, 0) / primary.length, 3)
      : 0,
    storiesNeedingReview: variances
      .filter((v) => v.status === 'ESTIMATION_REVIEW_REQUIRED')
      .map((v) => v.storyRef),
    highRiskStories: primary.filter((e) => e.riskLevel === 'HIGH').map((e) => e.storyRef),
  };
}

/**
 * Render an estimate the way it must always be shown: hours, confidence, risk, and a range.
 * The API refuses to serialise an estimate without these, and this is the canonical phrasing.
 */
export function formatEstimate(estimate: EstimateInput): string {
  return [
    `Estimated engineering time: ${estimate.hoursEngineering}h`,
    `Confidence: ${(estimate.confidence * 100).toFixed(0)}%`,
    `Risk: ${estimate.riskLevel}`,
    `Recommended planning range: ${estimate.rangeLowHours}–${estimate.rangeHighHours}h`,
  ].join('\n');
}

/**
 * Calibration against actuals (docs/56). A ratio above 1 means the estimator was optimistic.
 */
export function calibrationFactor(
  history: { estimatedHours: number; actualHours: number }[],
): { factor: number; sampleSize: number; confidence: number } {
  const usable = history.filter((h) => h.estimatedHours > 0 && h.actualHours > 0);
  if (usable.length === 0) return { factor: 1, sampleSize: 0, confidence: 0 };

  const ratios = usable.map((h) => h.actualHours / h.estimatedHours).sort((a, b) => a - b);
  // Median rather than mean: one catastrophic story should not reprice the whole backlog.
  const median = ratios[Math.floor(ratios.length / 2)] ?? 1;

  return {
    factor: round(median, 3),
    sampleSize: usable.length,
    confidence: round(Math.min(1, usable.length / 20), 2),
  };
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
