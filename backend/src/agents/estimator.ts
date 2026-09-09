/**
 * Estimator.
 *
 * Runs twice per project — once as PRIMARY, once as INDEPENDENT — and the two are never averaged.
 * The gap between them is computed in `domain.ts`; anything over the configured threshold sends the
 * story to a human to reconcile. An AI estimate is a planning range with a confidence, never a
 * commitment, which is why the schema refuses a point estimate without a range around it.
 */

import { z } from 'zod';
import { db } from '../db.js';
import { DecisionSummary, RiskLevel, defineAgent, fail, pass, renderChangeRequests } from './types.js';

const Output = z.object({
  estimates: z
    .array(
      z.object({
        storyRef: z.string(),
        storyPoints: z.number().positive(),
        hoursEngineering: z.number().nonnegative(),
        riskBuffer: z.number().nonnegative(),
        confidence: z.number().min(0).max(1),
        riskLevel: RiskLevel,
        rangeLowHours: z.number().nonnegative(),
        rangeHighHours: z.number().nonnegative(),
        drivers: z.array(z.string()).min(1),
      }),
    )
    .min(1),
  decisionSummary: DecisionSummary,
});

export type EstimatorOutput = z.infer<typeof Output>;

export const estimator = defineAgent<EstimatorOutput>({
  key: 'estimator',
  name: 'Estimator',
  role: 'Estimates implementation effort per story with explicit confidence and a planning range.',
  context: ['stories', 'architecture'],
  schema: Output,

  task: (input) =>
    [
      input.vars.estimatorKind === 'INDEPENDENT'
        ? 'You are the independent estimator. Reason from the stories and the architecture directly; ' +
          'do not try to guess what another estimator would say.'
        : 'You are the primary estimator.',
      'Estimate every story in the backlog. Every estimate needs a range that contains its own point value.',
      renderChangeRequests(input),
    ].join('\n'),

  checks: [
    {
      code: 'RANGE_CONTAINS_ESTIMATE',
      severity: 'HARD',
      description: 'every estimate carries a coherent planning range',
      run: (output) => {
        const broken = output.estimates
          .filter((e) => e.rangeLowHours > e.hoursEngineering || e.rangeHighHours < e.hoursEngineering)
          .map((e) => e.storyRef);
        return broken.length
          ? fail(`point estimate falls outside its own range: ${broken.join(', ')}`)
          : pass();
      },
    },
    {
      code: 'HIGH_RISK_HAS_BUFFER',
      severity: 'HARD',
      description: 'high-risk stories carry a risk buffer',
      run: (output) => {
        const bad = output.estimates.filter((e) => e.riskLevel === 'HIGH' && e.riskBuffer === 0).map((e) => e.storyRef);
        return bad.length ? fail(`HIGH risk with a zero buffer is not an estimate: ${bad.join(', ')}`) : pass();
      },
    },
    {
      code: 'RANGE_REFLECTS_CONFIDENCE',
      severity: 'SOFT',
      description: 'low confidence implies a wide range',
      run: (output) => {
        const incoherent = output.estimates
          .filter((e) => {
            if (e.hoursEngineering === 0) return false;
            const width = (e.rangeHighHours - e.rangeLowHours) / e.hoursEngineering;
            return e.confidence < 0.6 && width < 0.4;
          })
          .map((e) => e.storyRef);
        return incoherent.length
          ? fail(`narrow ranges on low-confidence estimates overstate certainty: ${incoherent.join(', ')}`)
          : pass();
      },
    },
    {
      code: 'CONFIDENCE_DIFFERENTIATED',
      severity: 'SOFT',
      description: 'confidence values vary across the backlog',
      run: (output) => {
        const values = new Set(output.estimates.map((e) => e.confidence));
        return output.estimates.length >= 4 && values.size === 1
          ? fail('identical confidence on every story conveys no information')
          : pass();
      },
    },
  ],

  async persist(output, input) {
    const kind = String(input.vars.estimatorKind ?? 'PRIMARY');

    for (const estimate of output.estimates) {
      const story = await db.story.findUnique({
        where: { projectId_ref: { projectId: input.projectId, ref: estimate.storyRef } },
      });
      // An estimate for a story that does not exist is dropped rather than invented into being.
      if (!story) continue;

      const data = {
        storyPoints: estimate.storyPoints,
        hours: estimate.hoursEngineering,
        rangeLowHours: estimate.rangeLowHours,
        rangeHighHours: estimate.rangeHighHours,
        confidence: estimate.confidence,
        riskLevel: estimate.riskLevel,
        riskBuffer: estimate.riskBuffer,
        drivers: estimate.drivers,
      };

      await db.estimate.upsert({
        where: { storyId_estimatorKind: { storyId: story.id, estimatorKind: kind } },
        create: { projectId: input.projectId, storyId: story.id, estimatorKind: kind, ...data },
        update: data,
      });
    }
  },

  summary: (output) => {
    const total = output.estimates.reduce((sum, e) => sum + e.hoursEngineering, 0);
    return `${output.estimates.length} stories, ${total.toFixed(0)}h total. ${output.decisionSummary.summary}`;
  },
});
