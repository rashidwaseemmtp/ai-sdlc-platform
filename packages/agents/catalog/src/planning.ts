/**
 * Estimator, Resource Planner and Delivery Planner agents — docs/14–17.
 *
 * The estimator runs twice: once as PRIMARY and once as INDEPENDENT on a deliberately different
 * model. The variance between them is computed by `@sdlc/domain`, not by a model, and a large
 * disagreement forces a human review rather than being averaged away.
 */

import { z } from 'zod';
import { ArtifactKind, type ModelRequest } from '@sdlc/shared';
import type { RegisteredAgent } from '@sdlc/agent-runtime';
import {
  BaseInput,
  DecisionSummary,
  POLICY,
  RiskLevel,
  check,
  defineAgent,
  demoSummary,
  fail,
  mcp,
  pass,
  readJsonSection,
  readTask,
} from './common.js';

// ── Estimator ──────────────────────────────────────────────────────────────

const StoryEstimate = z.object({
  storyRef: z.string(),
  storyPoints: z.number().positive(),
  hoursEngineering: z.number().nonnegative(),
  hoursFrontend: z.number().nonnegative().default(0),
  hoursBackend: z.number().nonnegative().default(0),
  hoursQa: z.number().nonnegative().default(0),
  hoursDevops: z.number().nonnegative().default(0),
  hoursDesign: z.number().nonnegative().default(0),
  hoursSecurity: z.number().nonnegative().default(0),
  riskBuffer: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  riskLevel: RiskLevel,
  rangeLowHours: z.number().nonnegative(),
  rangeHighHours: z.number().nonnegative(),
  drivers: z.array(z.string()).min(1),
  assumptions: z.array(z.string()).default([]),
});

export const EstimatorOutput = z.object({
  estimates: z.array(StoryEstimate).min(1),
  decisionSummary: DecisionSummary,
});
export type EstimatorOutput = z.infer<typeof EstimatorOutput>;

const EstimatorInput = BaseInput.extend({
  estimatorKind: z.enum(['PRIMARY', 'INDEPENDENT']).default('PRIMARY'),
});

export const estimatorAgent: RegisteredAgent<z.infer<typeof EstimatorInput>, EstimatorOutput> = {
  definition: defineAgent({
    key: 'estimator',
    name: 'Estimator',
    role: 'Estimates implementation effort per story with explicit confidence and a planning range.',
    modelPolicy: POLICY.structured(),
    contextRecipe: 'estimator',
    mcpServers: [mcp('ba', ['get_*'], ['backlog.read'])],
    permissions: ['read_project', 'read_backlog', 'read_architecture', 'write_estimation'],
    writes: [ArtifactKind.ESTIMATE],
    inputSchema: EstimatorInput,
    outputSchema: EstimatorOutput,
    budget: { maxCostUsd: 2 },
    qualityChecks: [
      check<EstimatorOutput>(
        'RANGE_PRESENT_AND_ORDERED',
        'HARD',
        'every estimate carries a coherent planning range',
        (output) => {
          const broken = output.estimates.filter(
            (e) => e.rangeLowHours > e.hoursEngineering || e.rangeHighHours < e.hoursEngineering,
          );
          return broken.length
            ? fail('point estimate falls outside its own range', { refs: broken.map((e) => e.storyRef) })
            : pass();
        },
      ),
      check<EstimatorOutput>(
        'RANGE_REFLECTS_CONFIDENCE',
        'SOFT',
        'low confidence implies a wide range',
        (output) => {
          const incoherent = output.estimates.filter((e) => {
            if (e.hoursEngineering === 0) return false;
            const width = (e.rangeHighHours - e.rangeLowHours) / e.hoursEngineering;
            return e.confidence < 0.6 && width < 0.4;
          });
          return incoherent.length
            ? fail('narrow ranges on low-confidence estimates overstate certainty', {
                refs: incoherent.map((e) => e.storyRef),
              })
            : pass();
        },
      ),
      check<EstimatorOutput>(
        'HIGH_RISK_HAS_BUFFER',
        'HARD',
        'high-risk stories carry a risk buffer',
        (output) => {
          const bad = output.estimates.filter((e) => e.riskLevel === 'HIGH' && e.riskBuffer === 0);
          return bad.length
            ? fail('HIGH risk with a zero buffer is not an estimate', { refs: bad.map((e) => e.storyRef) })
            : pass();
        },
      ),
      check<EstimatorOutput>(
        'DISCIPLINE_HOURS_RECONCILE',
        'SOFT',
        'discipline hours sum close to the engineering total',
        (output) => {
          const off = output.estimates.filter((e) => {
            const sum = e.hoursFrontend + e.hoursBackend + e.hoursDevops + e.hoursDesign + e.hoursSecurity;
            if (sum === 0) return false;
            return Math.abs(sum - e.hoursEngineering) / Math.max(e.hoursEngineering, 1) > 0.3;
          });
          return off.length
            ? fail('discipline breakdown does not reconcile with the engineering total', {
                refs: off.map((e) => e.storyRef),
              })
            : pass();
        },
      ),
      check<EstimatorOutput>(
        'CONFIDENCE_DIFFERENTIATED',
        'SOFT',
        'confidence values vary across the backlog',
        (output) => {
          const values = new Set(output.estimates.map((e) => e.confidence));
          return output.estimates.length >= 4 && values.size === 1
            ? fail('identical confidence on every story conveys no information')
            : pass();
        },
      ),
    ],
  }),
  inputSchema: EstimatorInput,
  outputSchema: EstimatorOutput,

  toArtifacts: (output, invocation) => {
    const kind = String((invocation.input as { estimatorKind?: string }).estimatorKind ?? 'PRIMARY');
    return [
      {
        kind: ArtifactKind.ESTIMATE,
        name: `estimate-${kind.toLowerCase()}`,
        scopeRef: kind,
        content: output,
      },
    ];
  },

  async project(output, { prisma, invocation }) {
    const estimatorKind =
      (invocation.input as { estimatorKind?: 'PRIMARY' | 'INDEPENDENT' }).estimatorKind ?? 'PRIMARY';

    for (const estimate of output.estimates) {
      const story = await prisma.story.findUnique({
        where: { projectId_ref: { projectId: invocation.projectId, ref: estimate.storyRef } },
      });
      if (!story) continue;

      const data = {
        storyPoints: estimate.storyPoints,
        hoursEngineering: estimate.hoursEngineering,
        hoursFrontend: estimate.hoursFrontend,
        hoursBackend: estimate.hoursBackend,
        hoursQa: estimate.hoursQa,
        hoursDevops: estimate.hoursDevops,
        hoursDesign: estimate.hoursDesign,
        hoursSecurity: estimate.hoursSecurity,
        riskBuffer: estimate.riskBuffer,
        confidence: estimate.confidence,
        riskLevel: estimate.riskLevel,
        rangeLowHours: estimate.rangeLowHours,
        rangeHighHours: estimate.rangeHighHours,
        drivers: estimate.drivers as object,
        assumptions: estimate.assumptions as object,
      };

      await prisma.estimate.upsert({
        where: { storyId_estimatorKind: { storyId: story.id, estimatorKind } },
        create: { projectId: invocation.projectId, storyId: story.id, estimatorKind, ...data },
        update: data,
      });
    }
  },
};

// ── Resource Planner ───────────────────────────────────────────────────────

export const ResourcePlannerOutput = z.object({
  allocations: z
    .array(
      z.object({
        role: z.string(),
        headcount: z.number().positive(),
        fteAllocation: z.number().min(0).max(1),
        skills: z.array(z.string()),
        notes: z.string().optional(),
      }),
    )
    .min(1),
  estimatedDurationWeeks: z.number().positive(),
  parallelizationNotes: z.array(z.string()).default([]),
  bottlenecks: z.array(z.object({ description: z.string(), impact: z.string() })).default([]),
  criticalDependencies: z.array(z.string()).default([]),
  decisionSummary: DecisionSummary,
});
export type ResourcePlannerOutput = z.infer<typeof ResourcePlannerOutput>;

export const resourcePlannerAgent: RegisteredAgent<z.infer<typeof BaseInput>, ResourcePlannerOutput> = {
  definition: defineAgent({
    key: 'resource-planner',
    name: 'Resource Planner',
    role: 'Turns estimates into a staffing shape with fractional allocations.',
    modelPolicy: POLICY.structured(),
    contextRecipe: 'resource-planner',
    mcpServers: [mcp('ba', ['get_*'], ['backlog.read'])],
    permissions: ['read_project', 'read_estimation', 'write_estimation'],
    writes: [ArtifactKind.RESOURCE_PLAN],
    inputSchema: BaseInput,
    outputSchema: ResourcePlannerOutput,
    budget: { maxCostUsd: 1.5 },
    qualityChecks: [
      check<ResourcePlannerOutput>(
        'HAS_QA',
        'SOFT',
        'the plan staffs quality assurance',
        (output) =>
          output.allocations.some((a) => /qa|quality|test/i.test(a.role))
            ? pass()
            : fail('no QA capacity in the plan; QA hours in the estimates will have nobody to do them'),
      ),
      check<ResourcePlannerOutput>(
        'BOTTLENECK_IDENTIFIED',
        'SOFT',
        'the plan names at least one bottleneck',
        (output) =>
          output.bottlenecks.length
            ? pass()
            : fail('a plan with no identified bottleneck is usually an unexamined plan'),
      ),
    ],
  }),
  inputSchema: BaseInput,
  outputSchema: ResourcePlannerOutput,
  toArtifacts: (output) => [{ kind: ArtifactKind.RESOURCE_PLAN, name: 'resource-plan', content: output }],

  async project(output, { prisma, invocation }) {
    const latest = await prisma.resourcePlan.findFirst({
      where: { projectId: invocation.projectId },
      orderBy: { version: 'desc' },
    });
    const plan = await prisma.resourcePlan.create({
      data: {
        projectId: invocation.projectId,
        version: (latest?.version ?? 0) + 1,
        estimatedDurationWeeks: output.estimatedDurationWeeks,
        parallelizationNotes: output.parallelizationNotes as object,
        bottlenecks: output.bottlenecks as object,
        criticalDependencies: output.criticalDependencies as object,
      },
    });
    await prisma.resourceAllocation.createMany({
      data: output.allocations.map((allocation) => ({
        planId: plan.id,
        role: allocation.role,
        headcount: allocation.headcount,
        fteAllocation: allocation.fteAllocation,
        skills: allocation.skills,
        ...(allocation.notes ? { notes: allocation.notes } : {}),
      })),
    });
  },
};

// ── Delivery Planner ───────────────────────────────────────────────────────

export const DeliveryPlannerOutput = z.object({
  strategy: z.string(),
  tasks: z
    .array(
      z.object({
        storyRef: z.string(),
        kind: z.enum(['FRONTEND', 'BACKEND', 'DATABASE', 'INFRA', 'TEST', 'DESIGN', 'DOCS']),
        title: z.string(),
        description: z.string().optional(),
        estimateHours: z.number().nonnegative().optional(),
        repositoryKey: z.string().optional(),
      }),
    )
    .default([]),
  milestones: z
    .array(z.object({ name: z.string(), storyRefs: z.array(z.string()), goal: z.string() }))
    .min(1),
  criticalPath: z.array(z.string()),
  cycles: z.array(z.array(z.string())).default([]),
  decisionSummary: DecisionSummary,
});
export type DeliveryPlannerOutput = z.infer<typeof DeliveryPlannerOutput>;

export const deliveryPlannerAgent: RegisteredAgent<z.infer<typeof BaseInput>, DeliveryPlannerOutput> = {
  definition: defineAgent({
    key: 'delivery-planner',
    name: 'Delivery Planner',
    role: 'Sequences the backlog into dependency-ordered waves, tasks and milestones.',
    modelPolicy: POLICY.structured(),
    contextRecipe: 'delivery-planner',
    mcpServers: [mcp('ba', ['*'], ['backlog.read', 'backlog.write'])],
    permissions: ['read_project', 'read_backlog', 'write_backlog', 'read_estimation'],
    writes: [ArtifactKind.DELIVERY_PLAN],
    inputSchema: BaseInput,
    outputSchema: DeliveryPlannerOutput,
    budget: { maxCostUsd: 1.5 },
    qualityChecks: [
      check<DeliveryPlannerOutput>(
        'NO_UNREPORTED_CYCLES',
        'HARD',
        'cyclic dependencies are reported rather than silently broken',
        (output) => {
          const inMilestones = new Set(output.milestones.flatMap((m) => m.storyRefs));
          const onPath = output.criticalPath.filter((ref) => !inMilestones.has(ref));
          return onPath.length
            ? fail('critical path references stories that appear in no milestone', { refs: onPath })
            : pass();
        },
      ),
      check<DeliveryPlannerOutput>(
        'TASKS_ARE_CONCRETE',
        'SOFT',
        'task titles name a deliverable',
        (output) => {
          const vague = output.tasks.filter((t) => t.title.trim().split(/\s+/).length < 3);
          return vague.length
            ? fail('tasks too vague to implement', { titles: vague.map((t) => t.title) })
            : pass();
        },
      ),
    ],
  }),
  inputSchema: BaseInput,
  outputSchema: DeliveryPlannerOutput,
  toArtifacts: (output) => [{ kind: ArtifactKind.DELIVERY_PLAN, name: 'delivery-plan', content: output }],

  async project(output, { prisma, invocation }) {
    const projectId = invocation.projectId;
    const latest = await prisma.deliveryPlan.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
    });

    const plan = await prisma.deliveryPlan.create({
      data: {
        projectId,
        version: (latest?.version ?? 0) + 1,
        strategy: output.strategy,
        criticalPath: output.criticalPath as object,
        waves: [] as object,
      },
    });

    await prisma.milestone.createMany({
      data: output.milestones.map((milestone, index) => ({
        planId: plan.id,
        name: milestone.name,
        orderIndex: index,
        storyIds: milestone.storyRefs,
      })),
    });

    for (const [index, task] of output.tasks.entries()) {
      const story = await prisma.story.findUnique({
        where: { projectId_ref: { projectId, ref: task.storyRef } },
      });
      if (!story) continue;

      const repository = task.repositoryKey
        ? await prisma.projectRepository.findUnique({
            where: { projectId_key: { projectId, key: task.repositoryKey } },
          })
        : null;

      await prisma.task.create({
        data: {
          storyId: story.id,
          kind: task.kind,
          title: task.title,
          ...(task.description ? { description: task.description } : {}),
          ...(task.estimateHours !== undefined ? { estimateHours: task.estimateHours } : {}),
          ...(repository ? { repositoryId: repository.id } : {}),
          orderIndex: index,
        },
      });
    }

    // Stories that survived approval and now have a plan are ready to be picked up.
    await prisma.story.updateMany({
      where: { projectId, status: 'APPROVED' },
      data: { status: 'PLANNED' },
    });
  },
};

// ── demo handlers ──────────────────────────────────────────────────────────

interface DemoStory {
  ref: string;
  sizeSignal?: string;
  title?: string;
}

export function estimatorDemoHandler(req: ModelRequest): EstimatorOutput {
  const { estimatorKind = 'PRIMARY' } = readTask<{ estimatorKind?: 'PRIMARY' | 'INDEPENDENT' }>(req);
  const stories = readJsonSection<DemoStory[]>(req, 'approved-backlog') ?? [];

  const sizeHours: Record<string, number> = { XS: 4, S: 8, M: 16, L: 32, XL: 64 };

  // The independent estimator is deliberately more pessimistic on larger stories, which is what
  // produces a realistic variance and exercises the ESTIMATION_REVIEW_REQUIRED path.
  const bias = estimatorKind === 'INDEPENDENT' ? 1.45 : 1;

  const estimates = (stories.length ? stories : [{ ref: 'US-101', sizeSignal: 'M' }]).map((story, index) => {
    const base = (sizeHours[story.sizeSignal ?? 'M'] ?? 16) * bias;
    const confidence = index === 0 ? 0.82 : index === 1 ? 0.61 : 0.74;
    const spread = confidence < 0.7 ? 0.55 : 0.3;

    return {
      storyRef: story.ref,
      storyPoints: Math.round(base / 4),
      hoursEngineering: Math.round(base),
      hoursFrontend: Math.round(base * 0.35),
      hoursBackend: Math.round(base * 0.45),
      hoursQa: Math.round(base * 0.25),
      hoursDevops: Math.round(base * 0.05),
      hoursDesign: Math.round(base * 0.1),
      hoursSecurity: Math.round(base * 0.05),
      riskBuffer: confidence < 0.7 ? Math.round(base * 0.2) : Math.round(base * 0.1),
      confidence,
      riskLevel: (confidence < 0.7 ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
      rangeLowHours: Math.round(base * (1 - spread)),
      rangeHighHours: Math.round(base * (1 + spread)),
      drivers: [
        'Acceptance criteria include a blocking business rule with an override path',
        'Audit logging is required on every lifecycle change',
      ],
      assumptions: ['Existing authentication can be reused without modification'],
    };
  });

  return {
    estimates,
    decisionSummary: demoSummary(
      `${estimatorKind} estimate across ${estimates.length} stories. Uncertainty is concentrated ` +
        'in the deactivation rule, where the override authorisation is still an open question.',
      estimatorKind === 'INDEPENDENT' ? 0.66 : 0.74,
    ),
  };
}

export function resourcePlannerDemoHandler(req: ModelRequest): ResourcePlannerOutput {
  const estimates = readJsonSection<{ hoursEngineering: number }[]>(req, 'estimates') ?? [];
  const totalHours = estimates.reduce((sum, e) => sum + (e.hoursEngineering ?? 0), 0) || 80;
  const weeks = Math.max(2, Math.ceil(totalHours / (2 * 30)));

  return {
    allocations: [
      { role: 'BACKEND_DEVELOPER', headcount: 1, fteAllocation: 1, skills: ['NestJS', 'PostgreSQL', 'Prisma'] },
      { role: 'FRONTEND_DEVELOPER', headcount: 1, fteAllocation: 0.75, skills: ['Next.js', 'React', 'TypeScript'] },
      { role: 'QA_ENGINEER', headcount: 1, fteAllocation: 0.5, skills: ['Playwright', 'API testing'] },
      { role: 'DEVOPS', headcount: 0.25, fteAllocation: 0.25, skills: ['Docker', 'CI/CD'] },
      { role: 'ARCHITECT', headcount: 0.25, fteAllocation: 0.25, skills: ['System design', 'PostgreSQL'] },
      { role: 'PRODUCT_OWNER', headcount: 0.25, fteAllocation: 0.25, skills: ['Requirements', 'Stakeholder management'] },
    ],
    estimatedDurationWeeks: weeks,
    parallelizationNotes: [
      'Customer CRUD and invoice read can proceed in parallel once the schema lands',
      'Frontend can start against the API contract before the backend is complete',
    ],
    bottlenecks: [
      {
        description: 'A single QA engineer at 0.5 FTE serialises verification of every story',
        impact: `Adds roughly ${Math.ceil(weeks * 0.3)} week(s) to the tail of the schedule`,
      },
    ],
    criticalDependencies: ['Customer schema must land before any lifecycle story'],
    decisionSummary: demoSummary(
      `Roughly ${totalHours} engineering hours across ${weeks} weeks with 2.0 FTE of engineering. ` +
        'QA capacity is the binding constraint, not engineering capacity.',
      0.72,
    ),
  };
}

export function deliveryPlannerDemoHandler(req: ModelRequest): DeliveryPlannerOutput {
  const stories = readJsonSection<DemoStory[]>(req, 'approved-backlog') ?? [];
  const refs = (stories.length ? stories : [{ ref: 'US-101' }]).map((s) => s.ref);

  return {
    strategy: 'Foundations first, then lifecycle features, with QA following each wave.',
    tasks: refs.flatMap((ref) => [
      {
        storyRef: ref,
        kind: 'DATABASE' as const,
        title: `Add schema and migration for ${ref}`,
        estimateHours: 2,
        repositoryKey: 'api',
      },
      {
        storyRef: ref,
        kind: 'BACKEND' as const,
        title: `Implement API endpoints and authorisation for ${ref}`,
        estimateHours: 6,
        repositoryKey: 'api',
      },
      {
        storyRef: ref,
        kind: 'FRONTEND' as const,
        title: `Build the administrator screen for ${ref}`,
        estimateHours: 5,
        repositoryKey: 'web',
      },
      { storyRef: ref, kind: 'TEST' as const, title: `Write end-to-end coverage for ${ref}`, estimateHours: 3 },
    ]),
    milestones: [
      {
        name: 'Milestone 1 — Customer record',
        storyRefs: refs.slice(0, Math.max(1, Math.ceil(refs.length / 2))),
        goal: 'An administrator can create and find a customer.',
      },
      ...(refs.length > 1
        ? [
            {
              name: 'Milestone 2 — Lifecycle',
              storyRefs: refs.slice(Math.ceil(refs.length / 2)),
              goal: 'An administrator can deactivate a customer, with the finance rule enforced.',
            },
          ]
        : []),
    ],
    criticalPath: refs,
    cycles: [],
    decisionSummary: demoSummary(
      'Schema and the customer record come first because every lifecycle story depends on them. ' +
        'The deactivation story is the longest pole and sits on the critical path.',
      0.8,
    ),
  };
}
