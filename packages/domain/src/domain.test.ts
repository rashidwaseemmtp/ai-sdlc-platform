import { describe, it, expect } from 'vitest';
import { computeWaves, suggestMilestones, type DagNode } from './planning.js';
import { computeVariance, summariseEstimates, calibrationFactor, type EstimateInput } from './estimation.js';
import { recommend, scoreOptions, blindOptions, requiresRegeneration, type OptionScores } from './architecture.js';
import { analyseStory, findDuplicates, assessReadiness, type StoryLike } from './backlog.js';

// ── planning ───────────────────────────────────────────────────────────────

describe('dependency waves', () => {
  const nodes: DagNode[] = [
    { ref: 'US-1', dependsOn: [], estimateHours: 8, priority: 'MUST' },
    { ref: 'US-2', dependsOn: ['US-1'], estimateHours: 12 },
    { ref: 'US-3', dependsOn: ['US-1'], estimateHours: 4 },
    { ref: 'US-4', dependsOn: ['US-2', 'US-3'], estimateHours: 6 },
    { ref: 'US-5', dependsOn: [], estimateHours: 2, priority: 'COULD' },
  ];

  it('groups independent stories into the same wave', () => {
    const { waves } = computeWaves(nodes);
    expect(waves[0]!.refs).toEqual(['US-1', 'US-5']);
    expect(waves[1]!.refs.sort()).toEqual(['US-2', 'US-3']);
    expect(waves[2]!.refs).toEqual(['US-4']);
  });

  it('orders a wave by priority then size, deterministically', () => {
    const { waves } = computeWaves(nodes);
    // US-1 is MUST, US-5 is COULD — MUST leads regardless of insertion order.
    expect(waves[0]!.refs[0]).toBe('US-1');
    expect(computeWaves([...nodes].reverse()).waves[0]!.refs).toEqual(waves[0]!.refs);
  });

  it('computes the critical path', () => {
    const { criticalPath } = computeWaves(nodes);
    expect(criticalPath.refs).toEqual(['US-1', 'US-2', 'US-4']);
    expect(criticalPath.hours).toBe(26);
  });

  it('reports cycles instead of throwing', () => {
    const { cycles, waves } = computeWaves([
      { ref: 'A', dependsOn: ['B'] },
      { ref: 'B', dependsOn: ['A'] },
      { ref: 'C', dependsOn: [] },
    ]);
    expect(waves[0]!.refs).toEqual(['C']);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('reports dependencies on unknown stories as orphans', () => {
    const { orphans, waves } = computeWaves([{ ref: 'A', dependsOn: ['GHOST'] }]);
    expect(orphans).toEqual(['A -> GHOST']);
    expect(waves[0]!.refs).toEqual(['A']);
  });

  it('caps milestone size', () => {
    const { waves } = computeWaves(nodes);
    const hours = { 'US-1': 8, 'US-2': 12, 'US-3': 4, 'US-4': 6, 'US-5': 2 };
    const milestones = suggestMilestones(waves, hours, 12);
    expect(milestones.length).toBeGreaterThan(1);
    expect(milestones.every((m) => m.refs.length > 0)).toBe(true);
  });
});

// ── estimation ─────────────────────────────────────────────────────────────

const estimate = (over: Partial<EstimateInput> = {}): EstimateInput => ({
  storyRef: 'US-1',
  estimatorKind: 'PRIMARY',
  hoursEngineering: 24,
  confidence: 0.72,
  riskLevel: 'MEDIUM',
  rangeLowHours: 20,
  rangeHighHours: 32,
  ...over,
});

describe('estimation variance', () => {
  it('forces human review on a large disagreement', () => {
    const result = computeVariance(
      estimate({ hoursEngineering: 24 }),
      estimate({ estimatorKind: 'INDEPENDENT', hoursEngineering: 38, rangeHighHours: 48 }),
    );
    expect(result.variancePct).toBeCloseTo(0.5833, 3);
    expect(result.status).toBe('ESTIMATION_REVIEW_REQUIRED');
    expect(result.rationale).toContain('human must reconcile');
  });

  it('accepts a close agreement', () => {
    const result = computeVariance(
      estimate({ hoursEngineering: 24 }),
      estimate({ estimatorKind: 'INDEPENDENT', hoursEngineering: 26 }),
    );
    expect(result.status).toBe('ACCEPTED');
  });

  it('measures variance against the smaller estimate, the conservative reading', () => {
    const result = computeVariance(
      estimate({ hoursEngineering: 10 }),
      estimate({ estimatorKind: 'INDEPENDENT', hoursEngineering: 20 }),
    );
    expect(result.variancePct).toBe(1); // 100%, not 50%
  });

  it('always produces a planning range, never a single number', () => {
    const result = computeVariance(estimate(), estimate({ estimatorKind: 'INDEPENDENT' }));
    expect(result.recommendedRange.lowHours).toBeLessThan(result.recommendedRange.highHours);
  });

  it('summarises a backlog with review flags', () => {
    const estimates = [estimate({ storyRef: 'US-1' }), estimate({ storyRef: 'US-2', riskLevel: 'HIGH' })];
    const variances = [
      computeVariance(estimates[0]!, estimate({ estimatorKind: 'INDEPENDENT', hoursEngineering: 60 })),
    ];
    const summary = summariseEstimates(estimates, variances);
    expect(summary.totalHours).toBe(48);
    expect(summary.storiesNeedingReview).toEqual(['US-1']);
    expect(summary.highRiskStories).toEqual(['US-2']);
  });

  it('calibrates from history using the median, not the mean', () => {
    const { factor, sampleSize } = calibrationFactor([
      { estimatedHours: 10, actualHours: 12 },
      { estimatedHours: 10, actualHours: 13 },
      { estimatedHours: 10, actualHours: 100 }, // outlier must not dominate
    ]);
    expect(factor).toBe(1.3);
    expect(sampleSize).toBe(3);
  });

  it('returns a neutral factor with no history', () => {
    expect(calibrationFactor([])).toEqual({ factor: 1, sampleSize: 0, confidence: 0 });
  });
});

// ── architecture ───────────────────────────────────────────────────────────

const opt = (variant: string, base: number): OptionScores => ({
  optionId: `opt-${variant}`,
  variant,
  name: `Option ${variant}`,
  scores: [
    { criterion: 'DEVELOPMENT_SPEED', score: base, reasoning: 'r' },
    { criterion: 'COST', score: base, reasoning: 'r' },
    { criterion: 'SCALABILITY', score: base, reasoning: 'r' },
    { criterion: 'SECURITY', score: base, reasoning: 'r' },
    { criterion: 'MAINTAINABILITY', score: base, reasoning: 'r' },
    { criterion: 'OPERATIONAL_COMPLEXITY', score: base, reasoning: 'r' },
    { criterion: 'TEAM_FIT', score: base, reasoning: 'r' },
    { criterion: 'PERFORMANCE', score: base, reasoning: 'r' },
    { criterion: 'FUTURE_EXTENSIBILITY', score: base, reasoning: 'r' },
    { criterion: 'RISK', score: base, reasoning: 'r' },
  ],
});

describe('architecture scoring', () => {
  it('ranks by weighted score', () => {
    const rec = recommend([opt('A', 6), opt('B', 8), opt('C', 4)]);
    expect(rec.recommendedOptionId).toBe('opt-B');
    expect(rec.ranked.map((r) => r.variant)).toEqual(['B', 'A', 'C']);
  });

  it('weights security and risk above extensibility', () => {
    const secure: OptionScores = {
      ...opt('A', 5),
      scores: opt('A', 5).scores.map((s) =>
        s.criterion === 'SECURITY' || s.criterion === 'RISK' ? { ...s, score: 10 } : s,
      ),
    };
    const extensible: OptionScores = {
      ...opt('B', 5),
      scores: opt('B', 5).scores.map((s) =>
        s.criterion === 'FUTURE_EXTENSIBILITY' ? { ...s, score: 10 } : s,
      ),
    };
    expect(recommend([secure, extensible]).recommendedOptionId).toBe('opt-A');
  });

  it('flags a close call so the approver reads both', () => {
    const rec = recommend([opt('A', 7), opt('B', 7.2)]);
    expect(rec.closeCall).toBe(true);
    expect(rec.reasoning).toContain('judgement call');
  });

  it('reports options below the viability threshold', () => {
    const rec = recommend([opt('A', 8), opt('B', 3)]);
    expect(rec.belowThreshold).toEqual(['B']);
  });

  it('requires regeneration when every option is weak', () => {
    const rec = recommend([opt('A', 3), opt('B', 4)]);
    expect(requiresRegeneration(rec)).toBe(true);
  });

  it('records criteria the critic failed to score', () => {
    const partial: OptionScores = { ...opt('A', 8), scores: opt('A', 8).scores.slice(0, 3) };
    expect(scoreOptions([partial])[0]!.missingCriteria).toHaveLength(7);
  });

  it('blinds options deterministically so the critic cannot anchor on order', () => {
    const options = [
      { optionId: 'opt-A', variant: 'A', overview: 'a' },
      { optionId: 'opt-B', variant: 'B', overview: 'b' },
      { optionId: 'opt-C', variant: 'C', overview: 'c' },
    ];
    const first = blindOptions(options, 'run-1');
    const again = blindOptions(options, 'run-1');

    expect(first.blind.map((o) => o.label)).toEqual(again.blind.map((o) => o.label));
    expect(first.blind.every((o) => !('variant' in o))).toBe(true);
    expect(Object.keys(first.mapping)).toHaveLength(3);
    // A different seed generally yields a different arrangement.
    expect(blindOptions(options, 'run-2').mapping).not.toEqual(first.mapping);
  });
});

// ── backlog quality ────────────────────────────────────────────────────────

const story = (over: Partial<StoryLike> = {}): StoryLike => ({
  ref: 'US-1',
  title: 'Deactivate customer account',
  userStory: 'As an admin, I want to deactivate a customer, so that they lose access',
  description: 'Admins can deactivate customers from the detail page.',
  sizeSignal: 'M',
  acceptanceCriteria: [
    { kind: 'GWT', given: 'an active customer', when: 'the admin deactivates them', then: 'access is revoked' },
  ],
  edgeCases: ['customer has open invoices'],
  requirementRefs: ['REQ-014'],
  labels: [],
  ...over,
});

describe('backlog quality', () => {
  it('passes a well-formed story', () => {
    expect(analyseStory(story())).toEqual([]);
  });

  it('flags a story with no acceptance criteria as critical', () => {
    const flags = analyseStory(story({ acceptanceCriteria: [] }));
    expect(flags.some((f) => f.kind === 'MISSING_AC' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('flags an incomplete Given/When/Then', () => {
    const flags = analyseStory(
      story({ acceptanceCriteria: [{ kind: 'GWT', given: 'x', when: '', then: 'y' }] }),
    );
    expect(flags.some((f) => f.detail.includes('missing: when'))).toBe(true);
  });

  it('flags unmeasurable acceptance criteria', () => {
    const flags = analyseStory(
      story({
        acceptanceCriteria: [
          { kind: 'GWT', given: 'a user', when: 'they search', then: 'results appear quickly' },
        ],
      }),
    );
    expect(flags.some((f) => f.kind === 'UNTESTABLE')).toBe(true);
  });

  it('flags a malformed user story', () => {
    const flags = analyseStory(story({ userStory: 'Deactivate customers' }));
    expect(flags.some((f) => f.kind === 'AMBIGUOUS')).toBe(true);
  });

  it('flags XL stories for splitting', () => {
    expect(analyseStory(story({ sizeSignal: 'XL' })).some((f) => f.kind === 'TOO_LARGE')).toBe(true);
  });

  it('flags a story with no requirement trace', () => {
    const flags = analyseStory(story({ requirementRefs: [] }));
    expect(flags.some((f) => f.detail.includes('does not trace'))).toBe(true);
  });

  it('flags a technical task dressed as a business story', () => {
    const flags = analyseStory(
      story({
        title: 'Refactor the ORM layer',
        description: 'Refactor the orm and add a database index to the endpoint',
      }),
    );
    expect(flags.some((f) => f.kind === 'TECHNICAL_AS_BUSINESS')).toBe(true);
  });

  it('does not flag a technical story that is labelled as such', () => {
    const flags = analyseStory(
      story({
        title: 'Refactor the ORM layer',
        description: 'Refactor the orm and add a database index to the endpoint',
        labels: ['technical'],
      }),
    );
    expect(flags.some((f) => f.kind === 'TECHNICAL_AS_BUSINESS')).toBe(false);
  });

  it('detects near-duplicate stories and explains why', () => {
    const flags = findDuplicates([
      story({ ref: 'US-1', title: 'Deactivate customer account' }),
      story({
        ref: 'US-2',
        title: 'Deactivate customer account',
        userStory: 'As an admin, I want to deactivate a customer, so that they lose access',
      }),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.storyRef).toBe('US-2');
    expect(flags[0]!.detail).toContain('overlap with US-1');
  });

  it('does not flag distinct stories as duplicates', () => {
    expect(
      findDuplicates([
        story({ ref: 'US-1', title: 'Deactivate customer account' }),
        story({
          ref: 'US-2',
          title: 'Export invoices to CSV',
          userStory: 'As a finance manager, I want to export invoices, so that I can reconcile',
        }),
      ]),
    ).toEqual([]);
  });

  it('blocks readiness on critical flags and reports coverage', () => {
    const readiness = assessReadiness(
      [story({ ref: 'US-1' }), story({ ref: 'US-2', acceptanceCriteria: [] })],
      ['REQ-014', 'REQ-015'],
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blockingFlags.some((f) => f.kind === 'MISSING_AC')).toBe(true);
    expect(readiness.coverage).toMatchObject({ storiesWithCriteria: 1, totalStories: 2, requirementsCovered: 1 });
  });

  it('passes readiness for a clean backlog', () => {
    expect(assessReadiness([story()], ['REQ-014']).ready).toBe(true);
  });
});
