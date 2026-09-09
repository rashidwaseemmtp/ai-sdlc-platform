/**
 * Resource Planner and Delivery Planner.
 *
 * Both write into the project's single `Plan` row: staffing shape from one, sequencing from the
 * other. Neither computes the dependency waves or the critical path — the planning stage does that
 * from the stories' own `dependsOn` edges, so the schedule is derived from the backlog rather than
 * from a model's recollection of it.
 */

import { z } from 'zod';
import { db } from '../db.js';
import { DecisionSummary, defineAgent, fail, pass, renderChangeRequests } from './types.js';

// ── Resource Planner ───────────────────────────────────────────────────────

const ResourceOutput = z.object({
  allocations: z
    .array(
      z.object({
        role: z.string(),
        headcount: z.number().positive(),
        fteAllocation: z.number().min(0).max(1),
        skills: z.array(z.string()),
      }),
    )
    .min(1),
  estimatedDurationWeeks: z.number().positive(),
  bottlenecks: z.array(z.object({ description: z.string(), impact: z.string() })).default([]),
  criticalDependencies: z.array(z.string()).default([]),
  decisionSummary: DecisionSummary,
});

export type ResourcePlannerOutput = z.infer<typeof ResourceOutput>;

export const resourcePlanner = defineAgent<ResourcePlannerOutput>({
  key: 'resource-planner',
  name: 'Resource Planner',
  role: 'Turns estimates into a staffing shape with fractional allocations.',
  context: ['stories', 'estimates'],
  schema: ResourceOutput,

  task: (input) => ['Staff the approved backlog from the estimates.', renderChangeRequests(input)].join('\n'),

  checks: [
    {
      code: 'HAS_QA',
      severity: 'SOFT',
      description: 'the plan staffs quality assurance',
      run: (output) =>
        output.allocations.some((a) => /qa|quality|test/i.test(a.role))
          ? pass()
          : fail('no QA capacity in the plan, so the QA hours in the estimates have nobody to do them'),
    },
    {
      code: 'BOTTLENECK_IDENTIFIED',
      severity: 'SOFT',
      description: 'the plan names at least one bottleneck',
      run: (output) =>
        output.bottlenecks.length ? pass() : fail('a plan with no identified bottleneck is usually an unexamined plan'),
    },
  ],

  async persist(output, input) {
    await db.plan.upsert({
      where: { projectId: input.projectId },
      create: { projectId: input.projectId, resourcePlan: output },
      update: { resourcePlan: output },
    });
  },

  summary: (output) => {
    const heads = output.allocations.reduce((sum, a) => sum + a.headcount * a.fteAllocation, 0);
    return `${heads.toFixed(1)} FTE across ${output.allocations.length} roles, ${output.estimatedDurationWeeks} weeks. ${output.decisionSummary.summary}`;
  },
});

// ── Delivery Planner ───────────────────────────────────────────────────────

const DeliveryOutput = z.object({
  strategy: z.string(),
  milestones: z
    .array(z.object({ name: z.string(), goal: z.string(), storyRefs: z.array(z.string()) }))
    .min(1),
  decisionSummary: DecisionSummary,
});

export type DeliveryPlannerOutput = z.infer<typeof DeliveryOutput>;

export const deliveryPlanner = defineAgent<DeliveryPlannerOutput>({
  key: 'delivery-planner',
  name: 'Delivery Planner',
  role: 'Sequences the backlog into milestones a team can actually deliver against.',
  context: ['stories', 'estimates'],
  schema: DeliveryOutput,

  task: (input) =>
    [
      'Group the backlog into milestones that respect the dependencies declared on the stories.',
      'Every story must appear in exactly one milestone.',
      renderChangeRequests(input),
    ].join('\n'),

  checks: [
    {
      code: 'ONE_MILESTONE_PER_STORY',
      severity: 'HARD',
      description: 'no story is scheduled into two milestones at once',
      run: (output) => {
        const seen = new Set<string>();
        const duplicated = output.milestones
          .flatMap((m) => m.storyRefs)
          .filter((ref) => !seen.add(ref));
        return duplicated.length
          ? fail(`stories appear in more than one milestone: ${[...new Set(duplicated)].join(', ')}`)
          : pass();
      },
    },
  ],

  async persist(output, input) {
    await db.plan.upsert({
      where: { projectId: input.projectId },
      create: { projectId: input.projectId, strategy: output.strategy, milestones: output.milestones },
      update: { strategy: output.strategy, milestones: output.milestones },
    });
  },

  summary: (output) =>
    `${output.milestones.length} milestones. ${output.decisionSummary.summary}`,
});
