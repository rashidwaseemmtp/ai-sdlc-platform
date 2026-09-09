/**
 * The arithmetic and the judgement rules — pure functions, no I/O, no model calls.
 *
 * This is the part of the platform that must not be delegated to a language model: which
 * architecture option wins, whether two estimates disagree enough to need a human, what order the
 * stories can be built in, and whether a story is actually testable. A model proposes; this file
 * decides, and because it is pure, every decision is reproducible from the inputs alone.
 */

// ── Backlog quality ────────────────────────────────────────────────────────

export interface StoryLike {
  ref: string;
  title: string;
  userStory: string;
  description: string;
  sizeSignal: string;
  acceptanceCriteria: {
    kind?: string;
    given?: string;
    when?: string;
    then?: string;
    statement?: string;
  }[];
  edgeCases: string[];
  requirementRefs: string[];
  labels: string[];
}

export interface QualityFlag {
  storyRef: string;
  kind: string;
  detail: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

const USER_STORY_SHAPE = /^as an?\s+.+?,\s*i want\s+.+?,\s*so that\s+.+$/i;

/** Words that make a criterion untestable, because nobody can agree when it has been met. */
const VAGUE_TERMS = [
  'fast', 'slow', 'quickly', 'easy', 'easily', 'intuitive', 'user-friendly', 'simple',
  'robust', 'scalable', 'efficient', 'appropriate', 'proper', 'reasonable', 'good',
  'better', 'optimal', 'seamless', 'modern', 'nice', 'etc',
];

/** Implementation vocabulary that suggests a technical task wearing a business story's clothes. */
const TECHNICAL_TERMS = [
  'refactor', 'database index', 'migration', 'endpoint', 'api route', 'redis', 'kafka',
  'docker', 'kubernetes', 'cache layer', 'orm', 'schema change', 'library upgrade',
  'dependency bump', 'unit test', 'ci pipeline',
];

/**
 * Re-derive the quality flags the agent should have raised.
 *
 * Run *independently* of the agent's own `qualityFlags`: a gate that only believes the model's
 * self-report is not a gate. Anything found here that the agent did not flag is surfaced to the
 * approver as something the agent missed.
 */
export function analyseBacklog(stories: StoryLike[]): QualityFlag[] {
  const flags: QualityFlag[] = [];

  for (const story of stories) {
    const flag = (kind: string, detail: string, severity: QualityFlag['severity']) =>
      flags.push({ storyRef: story.ref, kind, detail, severity });

    if (story.acceptanceCriteria.length === 0) {
      flag('MISSING_AC', 'no acceptance criteria, so the story cannot be verified', 'CRITICAL');
    }

    for (const [index, criterion] of story.acceptanceCriteria.entries()) {
      if ((criterion.kind ?? 'GWT') === 'GWT') {
        const missing = (['given', 'when', 'then'] as const).filter((part) => !criterion[part]?.trim());
        if (missing.length) {
          flag('MISSING_AC', `criterion ${index + 1} is missing: ${missing.join(', ')}`, 'HIGH');
        }
      } else if (!criterion.statement?.trim()) {
        flag('MISSING_AC', `criterion ${index + 1} has no statement`, 'HIGH');
      }

      const text = [criterion.given, criterion.when, criterion.then, criterion.statement]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const vague = VAGUE_TERMS.filter((term) => new RegExp(`\\b${term}\\b`).test(text));
      if (vague.length) {
        flag('UNTESTABLE', `criterion ${index + 1} uses unmeasurable language: ${vague.join(', ')}`, 'MEDIUM');
      }
    }

    if (!USER_STORY_SHAPE.test(story.userStory.trim())) {
      flag('AMBIGUOUS', 'not in the form "As a <role>, I want <capability>, so that <benefit>"', 'MEDIUM');
    }
    if (story.sizeSignal === 'XL') {
      flag('TOO_LARGE', 'XL stories should be split before development', 'HIGH');
    }
    if (story.edgeCases.length === 0) {
      flag('MISSING_EDGE_CASES', 'no edge cases identified', 'MEDIUM');
    }
    if (story.requirementRefs.length === 0) {
      flag('AMBIGUOUS', 'traces to no requirement, so its business justification is unverifiable', 'HIGH');
    }

    const haystack = `${story.title} ${story.userStory} ${story.description}`.toLowerCase();
    const technical = TECHNICAL_TERMS.filter((term) => haystack.includes(term));
    if (technical.length >= 2 && !story.labels.includes('technical')) {
      flag('TECHNICAL_AS_BUSINESS', `reads as a technical task (${technical.join(', ')})`, 'MEDIUM');
    }
  }

  flags.push(...findDuplicates(stories));
  return flags;
}

/**
 * Lexical duplicate detection over titles and user stories.
 *
 * Cheap and explainable on purpose: a similarity score is a poor thing to show a human, whereas
 * "82% overlap with US-104, sharing: invoice, export, archive" is something they can act on.
 */
function findDuplicates(stories: StoryLike[], threshold = 0.72): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const tokenised = stories.map((story) => ({
    story,
    tokens: significantTokens(`${story.title} ${story.userStory}`),
  }));

  for (let i = 0; i < tokenised.length; i += 1) {
    for (let j = i + 1; j < tokenised.length; j += 1) {
      const a = tokenised[i]!;
      const b = tokenised[j]!;
      const similarity = jaccard(a.tokens, b.tokens);
      if (similarity < threshold) continue;

      const shared = [...a.tokens].filter((token) => b.tokens.has(token)).slice(0, 6);
      flags.push({
        storyRef: b.story.ref,
        kind: 'DUPLICATE',
        detail: `${(similarity * 100).toFixed(0)}% overlap with ${a.story.ref} (shared: ${shared.join(', ')})`,
        severity: similarity >= 0.9 ? 'HIGH' : 'MEDIUM',
      });
    }
  }
  return flags;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'as', 'i', 'want', 'so', 'that', 'to', 'be', 'able', 'can', 'of', 'and',
  'or', 'for', 'in', 'on', 'with', 'my', 'is', 'it', 'user',
]);

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

// ── Architecture scoring ───────────────────────────────────────────────────

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

/** Security and risk count for more than extensibility. Stated here rather than left to a model. */
const WEIGHTS: Record<ArchCriterion, number> = {
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

export interface OptionScores {
  optionId: string;
  variant: string;
  name: string;
  scores: { criterion: string; score: number; reasoning: string }[];
}

export interface RankedOption {
  optionId: string;
  variant: string;
  name: string;
  weightedScore: number;
  strengths: string[];
  weaknesses: string[];
}

export interface Recommendation {
  recommendedOptionId: string;
  ranked: RankedOption[];
  margin: number;
  /** True when the top two are close enough that the approver should read both. */
  closeCall: boolean;
  belowThreshold: string[];
  reasoning: string;
}

const MINIMUM_SCORE = 5;

export function recommend(options: OptionScores[]): Recommendation {
  if (options.length === 0) throw new Error('cannot recommend an architecture with no scored options');

  const ranked: RankedOption[] = options
    .map((option) => {
      let weightedTotal = 0;
      let weightTotal = 0;
      for (const entry of option.scores) {
        const weight = WEIGHTS[entry.criterion as ArchCriterion] ?? 1;
        weightedTotal += entry.score * weight;
        weightTotal += weight;
      }
      const sorted = [...option.scores].sort((a, b) => b.score - a.score);
      return {
        optionId: option.optionId,
        variant: option.variant,
        name: option.name,
        weightedScore: weightTotal ? round(weightedTotal / weightTotal, 2) : 0,
        strengths: sorted.slice(0, 3).map((s) => s.criterion),
        weaknesses: sorted.slice(-3).reverse().map((s) => s.criterion),
      };
    })
    .sort((a, b) => b.weightedScore - a.weightedScore);

  const best = ranked[0]!;
  const second = ranked[1];
  const margin = second ? round(best.weightedScore - second.weightedScore, 2) : best.weightedScore;
  const closeCall = Boolean(second) && margin < 0.5;
  const belowThreshold = ranked.filter((o) => o.weightedScore < MINIMUM_SCORE).map((o) => o.variant);

  const parts = [
    `Option ${best.variant} (${best.name}) scores ${best.weightedScore}/10 weighted.`,
    `Strongest on ${best.strengths.join(', ')}; weakest on ${best.weaknesses.join(', ')}.`,
  ];
  if (second) parts.push(`Option ${second.variant} follows at ${second.weightedScore}, a margin of ${margin}.`);
  if (closeCall) parts.push('The top two are close, so this is a judgement call — read both.');
  if (belowThreshold.length) {
    parts.push(`Options ${belowThreshold.join(', ')} score below ${MINIMUM_SCORE} and are not viable.`);
  }

  return {
    recommendedOptionId: best.optionId,
    ranked,
    margin,
    closeCall,
    belowThreshold,
    reasoning: parts.join(' '),
  };
}

/** Every option below the threshold means the round failed — regenerate rather than approve. */
export function needsRegeneration(recommendation: Recommendation): boolean {
  return recommendation.ranked.every((option) => option.weightedScore < MINIMUM_SCORE);
}

/**
 * Strip authorship and shuffle the labels before the critic sees the options, so it cannot anchor
 * on "A is always the first-listed one". Seeded, so the same round always shuffles the same way.
 */
export function blindOptions<T extends { optionId: string; variant: string }>(
  options: T[],
  seed: string,
): { blind: (Omit<T, 'variant' | 'optionId'> & { label: string })[]; mapping: Record<string, string> } {
  const labels = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
  const order = seededShuffle(options.map((_, index) => index), seed);

  const blind: (Omit<T, 'variant' | 'optionId'> & { label: string })[] = [];
  const mapping: Record<string, string> = {};

  for (const [position, originalIndex] of order.entries()) {
    const option = options[originalIndex]!;
    const label = labels[position] ?? `Option${position}`;
    const { variant: _v, optionId: _o, ...rest } = option;
    blind.push({ ...(rest as Omit<T, 'variant' | 'optionId'>), label });
    mapping[label] = option.optionId;
  }
  return { blind, mapping };
}

function seededShuffle(items: number[], seed: string): number[] {
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

// ── Estimation variance ────────────────────────────────────────────────────

export interface EstimateInput {
  storyRef: string;
  hours: number;
  confidence: number;
  riskLevel: string;
  rangeLowHours: number;
  rangeHighHours: number;
}

export interface VarianceResult {
  storyRef: string;
  primaryHours: number;
  independentHours: number;
  variancePct: number;
  reviewRequired: boolean;
  recommendedRange: { lowHours: number; highHours: number };
  rationale: string;
}

/**
 * Measured against the *smaller* estimate, which is the conservative reading: 24h against 38h is a
 * 58% disagreement, not 37%. Over the threshold a human reconciles — the two numbers are never
 * averaged, because the average of a disagreement is a number nobody believes.
 */
export function computeVariance(
  primary: EstimateInput,
  independent: EstimateInput,
  threshold: number,
): VarianceResult {
  const low = Math.min(primary.hours, independent.hours);
  const high = Math.max(primary.hours, independent.hours);
  const variancePct = low === 0 ? (high === 0 ? 0 : 1) : (high - low) / low;
  const reviewRequired = variancePct > threshold;

  return {
    storyRef: primary.storyRef,
    primaryHours: primary.hours,
    independentHours: independent.hours,
    variancePct: round(variancePct, 4),
    reviewRequired,
    recommendedRange: {
      lowHours: round(Math.min(primary.rangeLowHours, independent.rangeLowHours), 1),
      highHours: round(Math.max(primary.rangeHighHours, independent.rangeHighHours), 1),
    },
    rationale: reviewRequired
      ? `Estimators disagree by ${(variancePct * 100).toFixed(0)}% (${low}h vs ${high}h), over the ` +
        `${(threshold * 100).toFixed(0)}% threshold. A human must reconcile before this is planned.`
      : `Estimators agree within ${(variancePct * 100).toFixed(0)}%.`,
  };
}

// ── Delivery waves ─────────────────────────────────────────────────────────

export interface DagNode {
  ref: string;
  dependsOn: string[];
  estimateHours: number;
  priority: string;
}

export interface Topology {
  waves: { index: number; refs: string[] }[];
  /** Non-empty means the plan is not executable and a human has to break the cycle. */
  cycles: string[][];
  criticalPath: { refs: string[]; hours: number };
}

/**
 * Group stories into dependency waves: everything in a wave can run in parallel, wave n+1 waits
 * for wave n. Cycles are reported rather than thrown — a cyclic backlog is a real thing an analyst
 * produces, and the caller decides whether to park or plan around it.
 */
export function computeWaves(nodes: DagNode[]): Topology {
  const byRef = new Map(nodes.map((node) => [node.ref, node]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const deps = node.dependsOn.filter((dep) => byRef.has(dep));
    indegree.set(node.ref, deps.length);
    for (const dep of deps) dependents.set(dep, [...(dependents.get(dep) ?? []), node.ref]);
  }

  const waves: { index: number; refs: string[] }[] = [];
  const settled = new Set<string>();
  let frontier = nodes
    .filter((node) => (indegree.get(node.ref) ?? 0) === 0)
    .map((node) => node.ref)
    .sort(compare(byRef));

  while (frontier.length > 0) {
    waves.push({ index: waves.length, refs: frontier });
    for (const ref of frontier) settled.add(ref);

    const next: string[] = [];
    for (const ref of frontier) {
      for (const dependent of dependents.get(ref) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    frontier = [...new Set(next)].sort(compare(byRef));
  }

  const stuck = nodes.filter((node) => !settled.has(node.ref)).map((node) => node.ref);
  return {
    waves,
    cycles: stuck.length ? [stuck] : [],
    criticalPath: criticalPath(byRef),
  };
}

/** The longest dependency chain by estimated hours — the floor on how fast this can be delivered. */
function criticalPath(byRef: Map<string, DagNode>): { refs: string[]; hours: number } {
  const memo = new Map<string, { refs: string[]; hours: number }>();
  const visiting = new Set<string>();

  const walk = (ref: string): { refs: string[]; hours: number } => {
    const cached = memo.get(ref);
    if (cached) return cached;
    if (visiting.has(ref)) return { refs: [], hours: 0 }; // cycle guard
    visiting.add(ref);

    const node = byRef.get(ref);
    let best: { refs: string[]; hours: number } = { refs: [], hours: 0 };
    for (const dep of node?.dependsOn ?? []) {
      if (!byRef.has(dep)) continue;
      const candidate = walk(dep);
      if (candidate.hours > best.hours) best = candidate;
    }

    visiting.delete(ref);
    const result = { refs: [...best.refs, ref], hours: best.hours + (node?.estimateHours ?? 0) };
    memo.set(ref, result);
    return result;
  };

  let longest: { refs: string[]; hours: number } = { refs: [], hours: 0 };
  for (const ref of byRef.keys()) {
    const candidate = walk(ref);
    if (candidate.hours > longest.hours) longest = candidate;
  }
  return longest;
}

/** MUST first, then the larger stories, then by ref — so two runs order a wave identically. */
function compare(byRef: Map<string, DagNode>) {
  const rank: Record<string, number> = { MUST: 0, SHOULD: 1, COULD: 2, WONT: 3 };
  return (a: string, b: string): number => {
    const nodeA = byRef.get(a);
    const nodeB = byRef.get(b);
    const byPriority = (rank[nodeA?.priority ?? 'SHOULD'] ?? 1) - (rank[nodeB?.priority ?? 'SHOULD'] ?? 1);
    if (byPriority !== 0) return byPriority;
    const bySize = (nodeB?.estimateHours ?? 0) - (nodeA?.estimateHours ?? 0);
    if (bySize !== 0) return bySize;
    return a.localeCompare(b);
  };
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
