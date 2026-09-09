/**
 * Architect and Architecture Critic.
 *
 * Three architects run in parallel from three deliberately different briefs, then a separate critic
 * scores all three *blind*: the options reach it with authorship stripped and labels shuffled, so it
 * cannot prefer "the first one" or "the one the same model wrote". The arithmetic that turns its
 * scores into a recommendation is in `domain.ts`, not here — a model proposes, the platform ranks.
 */

import { z } from 'zod';
import { db } from '../db.js';
import { ARCH_CRITERIA } from '../domain.js';
import { DecisionSummary, Severity, defineAgent, fail, pass, renderChangeRequests } from './types.js';

// ── Architect ──────────────────────────────────────────────────────────────

const ArchitectOutput = z.object({
  name: z.string(),
  overview: z.string().min(50),
  diagramMermaid: z.string().min(20),
  components: z
    .array(z.object({ name: z.string(), responsibility: z.string(), technology: z.string() }))
    .min(2),
  dataFlow: z.array(z.object({ from: z.string(), to: z.string(), description: z.string() })).min(1),
  apiStrategy: z.object({ style: z.string(), versioning: z.string(), contracts: z.string() }),
  databaseStrategy: z.object({ engine: z.string(), schemaApproach: z.string(), migrations: z.string() }),
  cachingStrategy: z.object({ approach: z.string(), invalidation: z.string() }),
  authentication: z.object({ mechanism: z.string(), sessionHandling: z.string() }),
  authorization: z.object({ model: z.string(), enforcementPoints: z.array(z.string()) }),
  security: z.object({ threats: z.array(z.string()), controls: z.array(z.string()) }),
  scalability: z.object({ approach: z.string(), limits: z.string() }),
  observability: z.object({ logging: z.string(), metrics: z.string(), tracing: z.string() }),
  deployment: z.object({ target: z.string(), strategy: z.string() }),
  cicd: z.object({ pipeline: z.string(), gates: z.array(z.string()) }),
  costConsiderations: z.object({ drivers: z.array(z.string()), estimateNotes: z.string() }),
  developmentComplexity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  operationalComplexity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  advantages: z.array(z.string()).min(2),
  disadvantages: z.array(z.string()).min(2),
  risks: z.array(z.object({ description: z.string(), severity: Severity, mitigation: z.string() })).min(1),
  migrationStrategy: z.string(),
  decisionSummary: DecisionSummary,
});

export type ArchitectOutput = z.infer<typeof ArchitectOutput>;

export const architect = defineAgent<ArchitectOutput>({
  key: 'architect',
  name: 'Architect',
  role: 'Produces one committed architecture option from a specific brief.',
  context: ['requirements', 'stories'],
  schema: ArchitectOutput,

  task: (input) =>
    [
      `You are producing option ${String(input.vars.variant)} in round ${String(input.vars.round)}.`,
      'Commit fully to your brief. Do not hedge toward the other options.',
      renderChangeRequests(input),
    ].join('\n'),

  checks: [
    {
      code: 'DATA_FLOW_COMPONENTS_EXIST',
      severity: 'HARD',
      description: 'components referenced in the data flow are declared',
      run: (output) => {
        const declared = new Set(output.components.map((c) => c.name.toLowerCase()));
        const missing = [...new Set(
          output.dataFlow.flatMap((flow) => [flow.from, flow.to]).filter((name) => !declared.has(name.toLowerCase())),
        )];
        return missing.length ? fail(`data flow references undeclared components: ${missing.join(', ')}`) : pass();
      },
    },
    {
      code: 'DIAGRAM_PARSES',
      severity: 'HARD',
      description: 'the diagram looks like Mermaid',
      run: (output) => {
        const head = output.diagramMermaid.trim().split('\n')[0]?.trim() ?? '';
        return /^(graph|flowchart|sequenceDiagram|C4Context|erDiagram|classDiagram)\b/.test(head)
          ? pass()
          : fail(`the diagram does not start with a Mermaid diagram type: "${head}"`);
      },
    },
    {
      code: 'HONEST_DISADVANTAGES',
      severity: 'SOFT',
      description: 'disadvantages are substantive',
      run: (output) =>
        output.disadvantages.every((d) => d.length < 30)
          ? fail('the disadvantages are too thin to be a real assessment')
          : pass(),
    },
  ],

  async persist(output, input) {
    const variant = String(input.vars.variant);
    const round = Number(input.vars.round ?? 1);

    await db.architectureOption.upsert({
      where: { projectId_round_variant: { projectId: input.projectId, round, variant } },
      create: {
        projectId: input.projectId,
        round,
        variant,
        name: output.name,
        overview: output.overview,
        detail: output,
      },
      update: { name: output.name, overview: output.overview, detail: output },
    });
  },

  summary: (output) =>
    `${output.name} — ${output.developmentComplexity} to build, ${output.operationalComplexity} to run. ` +
    output.decisionSummary.summary,
});

// ── Architecture Critic ────────────────────────────────────────────────────

const CriticOutput = z.object({
  evaluations: z
    .array(
      z.object({
        label: z.string(),
        scores: z
          .array(
            z.object({
              criterion: z.enum(ARCH_CRITERIA),
              score: z.number().min(0).max(10),
              reasoning: z.string().min(20),
            }),
          )
          .length(ARCH_CRITERIA.length),
        strengths: z.array(z.string()),
        weaknesses: z.array(z.string()),
      }),
    )
    .min(2),
  crossCuttingRisks: z.array(z.object({ description: z.string(), severity: Severity })).default([]),
  preferredLabel: z.string(),
  decisionSummary: DecisionSummary,
});

export type ArchitectureCriticOutput = z.infer<typeof CriticOutput>;

export const architectureCritic = defineAgent<ArchitectureCriticOutput>({
  key: 'architecture-critic',
  name: 'Architecture Critic',
  role: 'Independently scores architecture options against fixed weighted criteria.',
  // Deliberately no architecture context: the only options it sees are the blinded ones below.
  context: ['requirements', 'stories'],
  schema: CriticOutput,

  task: (input) =>
    [
      'Score every option below on all ten criteria. The options are anonymised and shuffled; you',
      'do not know who wrote which, and there is no significance to the order.',
      '',
      '<options>',
      JSON.stringify(input.vars.blindOptions ?? [], null, 2),
      '</options>',
    ].join('\n'),

  checks: [
    {
      code: 'ALL_CRITERIA_SCORED',
      severity: 'HARD',
      description: 'every option is scored on every criterion',
      run: (output) => {
        const incomplete = output.evaluations
          .filter((evaluation) => {
            const seen = new Set(evaluation.scores.map((s) => s.criterion));
            return ARCH_CRITERIA.some((criterion) => !seen.has(criterion));
          })
          .map((e) => e.label);
        return incomplete.length ? fail(`options with missing criteria: ${incomplete.join(', ')}`) : pass();
      },
    },
    {
      code: 'SCORES_DIFFERENTIATED',
      severity: 'SOFT',
      description: 'scores use the range rather than clustering',
      run: (output) => {
        const all = output.evaluations.flatMap((e) => e.scores.map((s) => s.score));
        const spread = Math.max(...all) - Math.min(...all);
        return spread < 2
          ? fail(`all scores fall within ${spread.toFixed(1)} points, which describes rather than evaluates`)
          : pass();
      },
    },
  ],

  summary: (output) =>
    `Scored ${output.evaluations.length} options; prefers ${output.preferredLabel}. ${output.decisionSummary.summary}`,
});
