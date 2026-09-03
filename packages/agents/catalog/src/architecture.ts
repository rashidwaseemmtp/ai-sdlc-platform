/**
 * Architect and Architecture Critic agents — docs/04 §4, docs/11–13.
 *
 * The critic is a separate agent, routed to a different model where the fallback chain allows, and
 * receives the options author-blind with shuffled labels. Independence here is structural: a
 * database trigger also refuses an evaluation whose agent is not `architecture-critic`.
 */

import { z } from 'zod';
import { ArtifactKind, type ModelRequest } from '@sdlc/shared';
import type { RegisteredAgent } from '@sdlc/agent-runtime';
import { ARCH_CRITERIA } from '@sdlc/domain';
import {
  BaseInput,
  DecisionSummary,
  POLICY,
  Severity,
  check,
  defineAgent,
  demoSummary,
  fail,
  mcp,
  pass,
  readJsonSection,
  readTask,
} from './common.js';

// ── Architect ──────────────────────────────────────────────────────────────

const Component = z.object({
  name: z.string(),
  responsibility: z.string(),
  technology: z.string(),
  interfaces: z.array(z.string()).default([]),
});

export const ArchitectOutput = z.object({
  name: z.string(),
  overview: z.string().min(50),
  diagramMermaid: z.string().min(20),
  components: z.array(Component).min(2),
  dataFlow: z
    .array(z.object({ from: z.string(), to: z.string(), description: z.string(), protocol: z.string().optional() }))
    .min(1),
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
  infrastructure: z.object({ components: z.array(z.string()), management: z.string() }),
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

const ArchitectInput = BaseInput.extend({
  variant: z.enum(['A', 'B', 'C']),
  brief: z.string(),
  round: z.number().int().positive().default(1),
});

export const architectAgent: RegisteredAgent<z.infer<typeof ArchitectInput>, ArchitectOutput> = {
  definition: defineAgent({
    key: 'architect',
    name: 'Architect',
    role: 'Produces one committed architecture option from a specific brief.',
    // Three options run in parallel, so a single subscription seat must not serialise them.
    modelPolicy: POLICY.frontierReasoning({ effort: 'xhigh', allowSubscription: false }),
    contextRecipe: 'architect',
    mcpServers: [
      mcp('product', ['get_*'], ['product.read']),
      mcp('ba', ['get_*'], ['backlog.read']),
      mcp('github', ['get_*', 'search_*'], ['repository.read']),
    ],
    permissions: ['read_project', 'read_backlog', 'read_requirements', 'write_architecture'],
    writes: [ArtifactKind.ARCHITECTURE_OPTION],
    inputSchema: ArchitectInput,
    outputSchema: ArchitectOutput,
    timeoutSeconds: 1800,
    budget: { maxCostUsd: 4 },
    qualityChecks: [
      check<ArchitectOutput>(
        'DATA_FLOW_COMPONENTS_EXIST',
        'HARD',
        'components referenced in the data flow are declared',
        (output) => {
          const declared = new Set(output.components.map((c) => c.name.toLowerCase()));
          const missing = output.dataFlow
            .flatMap((flow) => [flow.from, flow.to])
            .filter((name) => !declared.has(name.toLowerCase()));
          return missing.length
            ? fail('data flow references undeclared components', { missing: [...new Set(missing)] })
            : pass();
        },
      ),
      check<ArchitectOutput>(
        'DIAGRAM_PARSES',
        'HARD',
        'the diagram looks like Mermaid',
        (output) => {
          const head = output.diagramMermaid.trim().split('\n')[0]?.trim() ?? '';
          return /^(graph|flowchart|sequenceDiagram|C4Context|erDiagram|classDiagram)\b/.test(head)
            ? pass()
            : fail('diagram does not start with a Mermaid diagram type', { head });
        },
      ),
      check<ArchitectOutput>(
        'HONEST_DISADVANTAGES',
        'SOFT',
        'disadvantages are substantive',
        (output) => {
          const thin = output.disadvantages.filter((d) => d.length < 30);
          return thin.length === output.disadvantages.length
            ? fail('disadvantages are too thin to be a real assessment', { disadvantages: output.disadvantages })
            : pass();
        },
      ),
    ],
  }),
  inputSchema: ArchitectInput,
  outputSchema: ArchitectOutput,

  promptVariables: (invocation) => ({
    brief: String((invocation.input as { brief?: string }).brief ?? 'balanced'),
  }),

  toArtifacts: (output, invocation) => {
    const variant = String((invocation.input as { variant?: string }).variant ?? 'A');
    return [
      {
        kind: ArtifactKind.ARCHITECTURE_OPTION,
        name: `architecture-option-${variant.toLowerCase()}`,
        scope: 'OPTION',
        scopeRef: variant,
        content: output,
      },
    ];
  },

  async project(output, { prisma, invocation }) {
    const input = invocation.input as { variant: string; round?: number };
    const round = input.round ?? 1;

    await prisma.architectureOption.upsert({
      where: {
        projectId_variant_round: { projectId: invocation.projectId, variant: input.variant, round },
      },
      create: {
        projectId: invocation.projectId,
        variant: input.variant,
        round,
        name: output.name,
        overview: output.overview,
        diagramMermaid: output.diagramMermaid,
        components: output.components as object,
        dataFlow: output.dataFlow as object,
        apiStrategy: output.apiStrategy as object,
        databaseStrategy: output.databaseStrategy as object,
        cachingStrategy: output.cachingStrategy as object,
        authentication: output.authentication as object,
        authorization: output.authorization as object,
        security: output.security as object,
        scalability: output.scalability as object,
        observability: output.observability as object,
        deployment: output.deployment as object,
        cicd: output.cicd as object,
        infrastructure: output.infrastructure as object,
        costConsiderations: output.costConsiderations as object,
        developmentComplexity: output.developmentComplexity,
        operationalComplexity: output.operationalComplexity,
        advantages: output.advantages as object,
        disadvantages: output.disadvantages as object,
        risks: output.risks as object,
        migrationStrategy: output.migrationStrategy,
      },
      update: { name: output.name, overview: output.overview },
    });
  },
};

// ── Architecture Critic ────────────────────────────────────────────────────

const CriterionEnum = z.enum(ARCH_CRITERIA);

export const ArchitectureCriticOutput = z.object({
  evaluations: z
    .array(
      z.object({
        label: z.string().describe('The blinded label, e.g. Alpha'),
        scores: z
          .array(
            z.object({
              criterion: CriterionEnum,
              score: z.number().min(0).max(10),
              reasoning: z.string().min(20),
            }),
          )
          .length(ARCH_CRITERIA.length),
        strengths: z.array(z.string()),
        weaknesses: z.array(z.string()),
        rightChoiceWhen: z.array(z.string()),
      }),
    )
    .min(2),
  crossCuttingRisks: z.array(z.object({ description: z.string(), severity: Severity })).default([]),
  preferredLabel: z.string(),
  decisionSummary: DecisionSummary,
});

export type ArchitectureCriticOutput = z.infer<typeof ArchitectureCriticOutput>;

const ArchitectureCriticInput = BaseInput.extend({
  labels: z.array(z.string()).min(2),
});

export const architectureCriticAgent: RegisteredAgent<
  z.infer<typeof ArchitectureCriticInput>,
  ArchitectureCriticOutput
> = {
  definition: defineAgent({
    key: 'architecture-critic',
    name: 'Architecture Critic',
    role: 'Independently scores architecture options against fixed weighted criteria.',
    // requireDistinctFrom is filled in by the workflow with the architect's chosen model, so the
    // critique is not correlated with the author by construction.
    modelPolicy: POLICY.frontierReasoning(),
    contextRecipe: 'architecture-critic',
    mcpServers: [mcp('github', ['get_*'], ['repository.read'])],
    permissions: ['read_project', 'read_architecture', 'write_architecture'],
    writes: [ArtifactKind.ARCHITECTURE_EVALUATION, ArtifactKind.ARCHITECTURE_RECOMMENDATION],
    inputSchema: ArchitectureCriticInput,
    outputSchema: ArchitectureCriticOutput,
    budget: { maxCostUsd: 2 },
    qualityChecks: [
      check<ArchitectureCriticOutput>(
        'ALL_CRITERIA_SCORED',
        'HARD',
        'every option is scored on every criterion',
        (output) => {
          const incomplete = output.evaluations.filter((evaluation) => {
            const seen = new Set(evaluation.scores.map((s) => s.criterion));
            return ARCH_CRITERIA.some((criterion) => !seen.has(criterion));
          });
          return incomplete.length
            ? fail('options with missing criteria', { labels: incomplete.map((e) => e.label) })
            : pass();
        },
      ),
      check<ArchitectureCriticOutput>(
        'SCORES_DIFFERENTIATED',
        'SOFT',
        'scores use the range rather than clustering',
        (output) => {
          const all = output.evaluations.flatMap((e) => e.scores.map((s) => s.score));
          const spread = Math.max(...all) - Math.min(...all);
          return spread < 2
            ? fail(`all scores fall within ${spread.toFixed(1)} points; this describes rather than evaluates`)
            : pass();
        },
      ),
      check<ArchitectureCriticOutput>(
        'REASONING_SUBSTANTIVE',
        'SOFT',
        'each score carries reasoning tied to the option',
        (output) => {
          const thin = output.evaluations.flatMap((e) =>
            e.scores.filter((s) => s.reasoning.length < 40).map((s) => `${e.label}/${s.criterion}`),
          );
          return thin.length ? fail('scores with thin reasoning', { thin }) : pass();
        },
      ),
    ],
  }),
  inputSchema: ArchitectureCriticInput,
  outputSchema: ArchitectureCriticOutput,

  contextVariables: (invocation) => ({
    blindOptions: (invocation.input as { blindOptions?: unknown }).blindOptions ?? [],
  }),

  toArtifacts: (output) => [
    {
      kind: ArtifactKind.ARCHITECTURE_EVALUATION,
      name: 'architecture-evaluation',
      content: output,
    },
  ],
};

// ── demo handlers ──────────────────────────────────────────────────────────

const BRIEFS: Record<string, { name: string; complexity: 'LOW' | 'MEDIUM' | 'HIGH' }> = {
  A: { name: 'Modular monolith on the existing estate', complexity: 'LOW' },
  B: { name: 'Modular monolith with an extracted billing service', complexity: 'MEDIUM' },
  C: { name: 'Event-driven microservices', complexity: 'HIGH' },
};

export function architectDemoHandler(req: ModelRequest): ArchitectOutput {
  const { variant = 'A' } = readTask<{ variant?: 'A' | 'B' | 'C' }>(req);
  const profile = BRIEFS[variant] ?? BRIEFS.A!;
  const isDistributed = variant === 'C';

  const components = [
    { name: 'Web App', responsibility: 'Administrator and support UI', technology: 'Next.js', interfaces: ['HTTPS'] },
    { name: 'API', responsibility: 'Customer, invoice and audit endpoints', technology: 'NestJS', interfaces: ['REST'] },
    { name: 'Database', responsibility: 'Customer, invoice and audit tables', technology: 'PostgreSQL', interfaces: ['SQL'] },
    ...(variant !== 'A'
      ? [{ name: 'Billing Service', responsibility: 'Invoice state and payment reconciliation', technology: 'NestJS', interfaces: ['REST'] }]
      : []),
    ...(isDistributed
      ? [{ name: 'Event Bus', responsibility: 'Domain events between services', technology: 'NATS JetStream', interfaces: ['pub/sub'] }]
      : []),
  ];

  return {
    name: profile.name,
    overview:
      `${profile.name}. The web application talks to a single API which owns the customer record; ` +
      (variant === 'A'
        ? 'billing lives in the same deployable, which keeps the transaction boundary simple and the operational surface small.'
        : variant === 'B'
          ? 'billing is extracted behind a synchronous interface so it can scale and be owned separately without paying for full asynchrony.'
          : 'services communicate through domain events, which decouples billing from the customer lifecycle at the cost of eventual consistency.'),
    diagramMermaid: [
      'graph TD',
      '  WebApp[Web App] --> API',
      '  API --> Database',
      ...(variant !== 'A' ? ['  API --> BillingService[Billing Service]', '  BillingService --> Database'] : []),
      ...(isDistributed ? ['  API --> EventBus[Event Bus]', '  EventBus --> BillingService'] : []),
    ].join('\n'),
    components,
    dataFlow: [
      { from: 'Web App', to: 'API', description: 'Administrator deactivates a customer', protocol: 'HTTPS' },
      ...(variant === 'A'
        ? [{ from: 'API', to: 'Database', description: 'Check unpaid invoices in the same transaction', protocol: 'SQL' }]
        : [{ from: 'API', to: 'Billing Service', description: 'Check unpaid invoices', protocol: 'REST' }]),
      { from: 'API', to: 'Database', description: 'Write status change and audit entry', protocol: 'SQL' },
    ],
    apiStrategy: { style: 'REST with OpenAPI', versioning: 'URI versioning (/api/v1)', contracts: 'Zod schemas generate the OpenAPI document' },
    databaseStrategy: { engine: 'PostgreSQL 16', schemaApproach: 'Normalised, Prisma-managed', migrations: 'Forward-only, one per PR' },
    cachingStrategy: isDistributed
      ? { approach: 'Redis read-through for customer lookups', invalidation: 'Event-driven on customer.updated' }
      : { approach: 'No cache initially; the workload is well inside PostgreSQL capability at this scale', invalidation: 'Not applicable until a measured need appears' },
    authentication: { mechanism: 'OIDC against the existing identity provider', sessionHandling: 'HTTP-only cookies, 12h expiry' },
    authorization: { model: 'Role-based (admin, support, finance)', enforcementPoints: ['API middleware', 'Row-level checks on customer access'] },
    security: {
      threats: ['Unauthorised deactivation', 'Cross-tenant data access', 'Audit tampering'],
      controls: ['Role checks at the endpoint', 'Tenant scoping in every query', 'Append-only audit table'],
    },
    scalability: isDistributed
      ? { approach: 'Independent horizontal scaling per service', limits: 'Bounded by database write throughput' }
      : { approach: 'Horizontal scaling of the API behind a load balancer', limits: 'Single database write node until ~5k writes/s' },
    observability: { logging: 'Structured JSON with request ids', metrics: 'Prometheus', tracing: isDistributed ? 'OpenTelemetry, required to debug cross-service flows' : 'OpenTelemetry, optional at this size' },
    deployment: { target: 'Existing container platform', strategy: 'Rolling deploy with health gates' },
    cicd: { pipeline: 'Lint, typecheck, test, build, deploy', gates: ['Tests pass', 'Security scan clean', 'Human approval to production'] },
    infrastructure: { components: ['Container platform', 'PostgreSQL', ...(isDistributed ? ['NATS', 'Redis'] : [])], management: 'Terraform' },
    costConsiderations: {
      drivers: isDistributed ? ['Multiple service instances', 'Message broker', 'Cache tier'] : ['Single API deployment', 'One database'],
      estimateNotes: isDistributed ? 'Roughly triple the baseline infrastructure cost, before the operational time to run it.' : 'Baseline cost; no additional infrastructure beyond what already exists.',
    },
    developmentComplexity: profile.complexity,
    operationalComplexity: profile.complexity,
    advantages: isDistributed
      ? ['Billing scales and deploys independently of the customer lifecycle', 'Failure in billing does not take down customer administration', 'Event log gives a natural audit and replay mechanism']
      : ['Single transaction boundary makes the unpaid-invoice rule trivially correct', 'One deployable to build, test and operate', 'No distributed failure modes to design around'],
    disadvantages: isDistributed
      ? ['The unpaid-invoice rule becomes eventually consistent, which is exactly the wrong property for a blocking business rule', 'Three additional infrastructure components to operate for a seven-story backlog', 'Debugging a failed deactivation now spans two services and a broker']
      : ['Billing and customer code share a deployment, so a billing change redeploys the customer API', 'Scaling is coarse-grained: the whole API scales together', 'A long-running billing job can affect API latency'],
    risks: [
      isDistributed
        ? { description: 'Eventual consistency lets a customer be deactivated while an invoice is still unpaid', severity: 'HIGH' as const, mitigation: 'Synchronous check on the deactivation path only, which partially defeats the architecture' }
        : { description: 'Billing growth eventually forces extraction', severity: 'MEDIUM' as const, mitigation: 'Keep billing behind a module boundary so extraction is mechanical' },
    ],
    migrationStrategy: 'Import the legacy CSV into the customer table, reconcile invoices, run both systems read-only in parallel for one billing cycle.',
    decisionSummary: demoSummary(
      `${profile.name}: ${isDistributed ? 'optimised for independent scale at a real cost in consistency and operations' : 'optimised for correctness and speed of delivery at this scale'}.`,
      0.8,
    ),
  };
}

export function architectureCriticDemoHandler(req: ModelRequest): ArchitectureCriticOutput {
  const { labels = ['Alpha', 'Beta', 'Gamma'] } = readTask<{ labels?: string[] }>(req);

  // Score the option *content*, not its position. The options arrive blinded and shuffled, so
  // anything keyed off label order would produce a random winner — which would make the demo look
  // like it worked while proving nothing about the blinding.
  const options =
    readJsonSection<
      { label: string; name?: string; operationalComplexity?: string; developmentComplexity?: string }[]
    >(req, 'architecture-options-blind') ?? [];

  const byLabel = new Map(options.map((option) => [option.label, option]));
  const rank = (level: string | undefined): number =>
    level === 'LOW' ? 9 : level === 'MEDIUM' ? 7 : level === 'HIGH' ? 4 : 6;

  const evaluations = labels.map((label) => {
    const option = byLabel.get(label);
    const ops = rank(option?.operationalComplexity);
    const dev = rank(option?.developmentComplexity);
    const distributed = /micro|event|distributed/i.test(option?.name ?? '');

    const scores: Partial<Record<(typeof ARCH_CRITERIA)[number], number>> = {
      DEVELOPMENT_SPEED: dev,
      COST: ops,
      OPERATIONAL_COMPLEXITY: ops,
      MAINTAINABILITY: Math.min(9, dev + 1),
      TEAM_FIT: dev,
      // A blocking business rule wants one transaction boundary, so distribution costs risk here.
      RISK: distributed ? 4 : 8,
      SCALABILITY: distributed ? 9 : 6,
      FUTURE_EXTENSIBILITY: distributed ? 9 : 6,
      PERFORMANCE: 7,
      SECURITY: distributed ? 6 : 8,
    };

    return {
      label,
      scores: ARCH_CRITERIA.map((criterion) => ({
        criterion,
        score: scores[criterion] ?? 7,
        reasoning:
          `${criterion} scored ${scores[criterion] ?? 7} for "${option?.name ?? label}": judged ` +
          `against this project's small backlog and the blocking unpaid-invoice rule, which wants ` +
          'a single transaction boundary rather than eventual consistency.',
      })),
      strengths: distributed
        ? ['Independent scaling', 'Service isolation']
        : ['Transactional correctness', 'Small operational surface'],
      weaknesses: distributed
        ? ['Eventual consistency on a blocking rule', 'Three extra components to operate']
        : ['Coarse-grained scaling'],
      rightChoiceWhen: distributed
        ? ['Billing volume outgrows one database write node', 'Separate teams own billing and lifecycle']
        : ['The team is small and the backlog is this size'],
    };
  });

  const best = [...evaluations].sort(
    (a, b) =>
      b.scores.reduce((sum, s) => sum + s.score, 0) - a.scores.reduce((sum, s) => sum + s.score, 0),
  )[0];

  return {
    evaluations,
    crossCuttingRisks: [
      { description: 'Legacy data quality is unknown regardless of the architecture chosen', severity: 'HIGH' },
    ],
    preferredLabel: best?.label ?? labels[0] ?? 'Alpha',
    decisionSummary: demoSummary(
      'The simplest option scores highest at this scale: the unpaid-invoice rule is a blocking ' +
        'business rule, and one transaction boundary makes it correct by construction. The ' +
        'distributed option buys scale this project does not yet need at a real cost in consistency.',
      0.82,
    ),
  };
}
