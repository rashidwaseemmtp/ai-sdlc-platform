/**
 * Product Owner agent — docs/04 §5.
 *
 * Turns raw client material into structured product requirements. Notably it does **not** write
 * stories: `writes` excludes them, so a schema-valid attempt to emit a backlog is rejected at
 * persistence rather than quietly accepted.
 */

import { z } from 'zod';
import { ArtifactKind, type ArtifactRef, type ModelRequest } from '@sdlc/shared';
import type { RegisteredAgent } from '@sdlc/agent-runtime';
import {
  BaseInput,
  DecisionSummary,
  POLICY,
  Priority,
  Severity,
  SourceRef,
  check,
  defineAgent,
  demoSummary,
  fail,
  mcp,
  pass,
  readSection,
} from './common.js';

const RequirementOut = z.object({
  ref: z.string().regex(/^REQ-\d{3}$/),
  type: z.enum(['FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT']),
  priority: Priority,
  statement: z.string().min(10),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1),
  // Traceability is mandatory: a requirement nobody said is an assumption, not a requirement.
  sourceRefs: z.array(SourceRef).min(1),
});

export const ProductOwnerOutput = z.object({
  productVision: z.object({
    statement: z.string(),
    problem: z.string(),
    targetUsers: z.array(z.string()),
    valueProposition: z.string(),
    successMetrics: z.array(z.string()),
  }),
  businessGoals: z.array(
    z.object({
      ref: z.string(),
      title: z.string(),
      description: z.string(),
      metric: z.string().optional(),
      targetValue: z.string().optional(),
      priority: Priority,
    }),
  ),
  stakeholders: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      interests: z.array(z.string()),
      concerns: z.array(z.string()),
      influence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    }),
  ),
  requirements: z.array(RequirementOut).min(1),
  businessRules: z.array(
    z.object({ ref: z.string(), statement: z.string(), appliesTo: z.string().optional() }),
  ),
  constraints: z.array(z.object({ kind: z.string(), statement: z.string(), impact: z.string().optional() })),
  assumptions: z.array(
    z.object({ statement: z.string(), riskIfWrong: z.string(), confidence: z.number().min(0).max(1) }),
  ),
  openQuestions: z.array(
    z.object({
      question: z.string(),
      blocksRefs: z.array(z.string()).default([]),
      askedOf: z.string().optional(),
      severity: Severity,
    }),
  ),
  risks: z.array(
    z.object({
      description: z.string(),
      likelihood: z.string(),
      impact: z.string(),
      mitigation: z.string().optional(),
      severity: Severity,
    }),
  ),
  conflicts: z.array(
    z.object({
      leftRef: z.string(),
      rightRef: z.string(),
      nature: z.string(),
      suggestedResolution: z.string(),
    }),
  ),
  missingInformation: z.array(z.string()),
  decisionSummary: DecisionSummary,
});

export type ProductOwnerOutput = z.infer<typeof ProductOwnerOutput>;

const ProductOwnerInput = BaseInput.extend({
  focus: z.string().optional(),
});

export const productOwnerAgent: RegisteredAgent<
  z.infer<typeof ProductOwnerInput>,
  ProductOwnerOutput
> = {
  definition: defineAgent({
    key: 'product-owner',
    name: 'Product Owner',
    role: 'Turns client conversations and documents into traceable product requirements.',
    modelPolicy: POLICY.frontierReasoning(),
    contextRecipe: 'product-owner',
    mcpServers: [mcp('product', ['*'], ['product.read', 'product.write'])],
    permissions: ['read_project', 'read_requirements', 'write_requirements'],
    // Deliberately excludes BACKLOG and STORY — decomposition is the BA's job.
    writes: [ArtifactKind.REQUIREMENTS, ArtifactKind.PRODUCT_VISION],
    inputSchema: ProductOwnerInput,
    outputSchema: ProductOwnerOutput,
    budget: { maxCostUsd: 3 },
    qualityChecks: [
      check<ProductOwnerOutput>(
        'REQUIREMENT_TRACEABILITY',
        'HARD',
        'every requirement cites at least one source document',
        (output) => {
          const untraced = output.requirements.filter((r) => r.sourceRefs.length === 0);
          return untraced.length
            ? fail(`${untraced.length} requirement(s) have no source`, {
                refs: untraced.map((r) => r.ref),
              })
            : pass();
        },
      ),
      check<ProductOwnerOutput>(
        'UNIQUE_REFS',
        'HARD',
        'requirement refs are unique',
        (output) => {
          const seen = new Set<string>();
          const duplicates = output.requirements.filter((r) => !seen.add(r.ref));
          return duplicates.length
            ? fail('duplicate requirement refs', { refs: duplicates.map((r) => r.ref) })
            : pass();
        },
      ),
      check<ProductOwnerOutput>(
        'MEASURABLE_NFRS',
        'SOFT',
        'non-functional requirements contain a measurable target',
        (output) => {
          const vague = output.requirements.filter(
            (r) => r.type === 'NON_FUNCTIONAL' && !/\d/.test(r.statement),
          );
          return vague.length
            ? fail('non-functional requirements without a number are not testable', {
                refs: vague.map((r) => r.ref),
              })
            : pass();
        },
      ),
      check<ProductOwnerOutput>(
        'CONFIDENCE_SPREAD',
        'SOFT',
        'confidence values are differentiated rather than uniform',
        (output) => {
          const values = new Set(output.requirements.map((r) => r.confidence));
          return output.requirements.length >= 5 && values.size === 1
            ? fail('every requirement carries the same confidence, which conveys no information')
            : pass();
        },
      ),
      check<ProductOwnerOutput>(
        'PRIORITISED',
        'SOFT',
        'not everything is a MUST',
        (output) => {
          const musts = output.requirements.filter((r) => r.priority === 'MUST').length;
          return output.requirements.length >= 5 && musts === output.requirements.length
            ? fail('all requirements are MUST, which is not a prioritisation')
            : pass();
        },
      ),
    ],
  }),
  inputSchema: ProductOwnerInput,
  outputSchema: ProductOwnerOutput,

  toArtifacts: (output) => [
    {
      kind: ArtifactKind.REQUIREMENTS,
      name: 'requirements',
      content: output,
    },
  ],

  contextVariables: (invocation) => ({
    changeRequests: (invocation.input as { changeRequests?: unknown }).changeRequests ?? [],
    retrievalQuery: 'business goals, requirements, constraints, stakeholders',
  }),

  async project(output, { prisma, invocation }) {
    const projectId = invocation.projectId;

    await prisma.productVision.upsert({
      where: { projectId },
      create: { projectId, ...output.productVision },
      update: { ...output.productVision, version: { increment: 1 } },
    });

    for (const goal of output.businessGoals) {
      await prisma.businessGoal.upsert({
        where: { projectId_ref: { projectId, ref: goal.ref } },
        create: { projectId, ...goal },
        update: goal,
      });
    }

    for (const stakeholder of output.stakeholders) {
      const existing = await prisma.stakeholder.findFirst({
        where: { projectId, name: stakeholder.name },
      });
      if (existing) {
        await prisma.stakeholder.update({ where: { id: existing.id }, data: stakeholder });
      } else {
        await prisma.stakeholder.create({ data: { projectId, ...stakeholder } });
      }
    }

    for (const requirement of output.requirements) {
      await prisma.requirement.upsert({
        where: { projectId_ref: { projectId, ref: requirement.ref } },
        create: {
          projectId,
          ref: requirement.ref,
          type: requirement.type,
          priority: requirement.priority,
          statement: requirement.statement,
          ...(requirement.rationale ? { rationale: requirement.rationale } : {}),
          confidence: requirement.confidence,
          sourceRefs: requirement.sourceRefs as object,
          status: 'REVIEW',
        },
        update: {
          statement: requirement.statement,
          priority: requirement.priority,
          confidence: requirement.confidence,
          sourceRefs: requirement.sourceRefs as object,
        },
      });
    }

    for (const rule of output.businessRules) {
      await prisma.businessRule.upsert({
        where: { projectId_ref: { projectId, ref: rule.ref } },
        create: { projectId, ...rule },
        update: rule,
      });
    }

    for (const constraint of output.constraints) {
      await prisma.constraint.create({ data: { projectId, ...constraint } });
    }
    for (const assumption of output.assumptions) {
      await prisma.assumption.create({ data: { projectId, ...assumption } });
    }
    for (const question of output.openQuestions) {
      await prisma.openQuestion.create({
        data: { projectId, ...question, blocksRefs: question.blocksRefs as object },
      });
    }
    for (const risk of output.risks) {
      await prisma.risk.create({ data: { projectId, ...risk } });
    }

    // Conflicts become typed links between requirements, so the BA and the UI can act on them.
    for (const conflict of output.conflicts) {
      const [left, right] = await Promise.all([
        prisma.requirement.findUnique({ where: { projectId_ref: { projectId, ref: conflict.leftRef } } }),
        prisma.requirement.findUnique({ where: { projectId_ref: { projectId, ref: conflict.rightRef } } }),
      ]);
      if (left && right) {
        await prisma.requirementLink.upsert({
          where: { fromId_toId_kind: { fromId: left.id, toId: right.id, kind: 'CONFLICTS_WITH' } },
          create: {
            fromId: left.id,
            toId: right.id,
            kind: 'CONFLICTS_WITH',
            detail: `${conflict.nature} — suggested: ${conflict.suggestedResolution}`,
          },
          update: {},
        });
      }
    }
  },
};

/** Demo handler — derives requirements from the ingested documents so the pipeline feels real. */
export function productOwnerDemoHandler(req: ModelRequest): ProductOwnerOutput {
  // The source-documents section is markdown, not JSON — the resolver renders each document as
  // `## [<id>] KIND — Title`, so the ids are recoverable. Tracing to a real document id is the
  // whole point of sourceRefs; a placeholder would make the traceability query silently empty.
  const section = readSection(req, 'source-documents') ?? '';
  const documentIds = [...section.matchAll(/^##\s*\[([0-9a-f-]{8,})\]/gim)].map((m) => m[1]!);
  const source = documentIds.length
    ? documentIds.slice(0, 1).map((documentId) => ({ documentId }))
    : [{ documentId: 'demo-document' }];
  const secondary = documentIds.length > 1 ? [{ documentId: documentIds[1]! }] : source;
  return {
    productVision: {
      statement:
        'A customer management platform that lets support and finance teams manage customer ' +
        'accounts, subscriptions and invoices from one place.',
      problem:
        'Customer data is split across a CRM, a billing spreadsheet and email, so nobody can ' +
        'answer a customer question without checking three systems.',
      targetUsers: ['Support agent', 'Finance manager', 'Account administrator'],
      valueProposition: 'One record per customer, with billing state visible to the people who answer the phone.',
      successMetrics: [
        'Average time to answer a billing question under 2 minutes',
        'Zero manual spreadsheet reconciliation by end of quarter',
      ],
    },
    businessGoals: [
      {
        ref: 'BG-1',
        title: 'Consolidate customer data',
        description: 'One authoritative customer record replacing the CRM and the billing sheet.',
        metric: 'Systems of record for customer data',
        targetValue: '1',
        priority: 'MUST',
      },
      {
        ref: 'BG-2',
        title: 'Reduce support handling time',
        description: 'Support agents answer billing questions without escalating to finance.',
        metric: 'Median handling time',
        targetValue: 'under 2 minutes',
        priority: 'SHOULD',
      },
    ],
    stakeholders: [
      {
        name: 'Head of Support',
        role: 'Support lead',
        interests: ['Fast answers', 'Fewer escalations'],
        concerns: ['Agents seeing data they should not'],
        influence: 'HIGH',
      },
      {
        name: 'Finance Manager',
        role: 'Finance',
        interests: ['Accurate invoicing', 'Audit trail'],
        concerns: ['Deactivating a customer with unpaid invoices'],
        influence: 'HIGH',
      },
    ],
    requirements: [
      {
        ref: 'REQ-001',
        type: 'FUNCTIONAL',
        priority: 'MUST',
        statement: 'An administrator can create, view, edit and search customer records.',
        rationale: 'Core of the consolidated customer record.',
        confidence: 0.92,
        sourceRefs: source,
      },
      {
        ref: 'REQ-002',
        type: 'FUNCTIONAL',
        priority: 'MUST',
        statement: 'An administrator can deactivate a customer account, revoking their access.',
        rationale: 'Requested explicitly as the most common lifecycle action.',
        confidence: 0.88,
        sourceRefs: secondary,
      },
      {
        ref: 'REQ-003',
        type: 'BUSINESS_RULE',
        priority: 'MUST',
        statement:
          'A customer with outstanding unpaid invoices cannot be deactivated without an explicit ' +
          'finance override.',
        rationale: 'Finance raised this as a hard rule during discovery.',
        confidence: 0.85,
        sourceRefs: source,
      },
      {
        ref: 'REQ-004',
        type: 'FUNCTIONAL',
        priority: 'SHOULD',
        statement: 'A support agent can view a customer invoice history without editing it.',
        confidence: 0.7,
        sourceRefs: source,
      },
      {
        ref: 'REQ-005',
        type: 'NON_FUNCTIONAL',
        priority: 'SHOULD',
        statement: 'Customer search returns results within 500ms at p95 for up to 50,000 customers.',
        confidence: 0.6,
        sourceRefs: source,
      },
      {
        ref: 'REQ-006',
        type: 'NON_FUNCTIONAL',
        priority: 'MUST',
        statement: 'Every customer lifecycle change is recorded in an audit log retained for 24 months.',
        confidence: 0.75,
        sourceRefs: source,
      },
      {
        ref: 'REQ-007',
        type: 'CONSTRAINT',
        priority: 'MUST',
        statement: 'The system must run on the existing PostgreSQL and Node.js estate.',
        confidence: 0.95,
        sourceRefs: source,
      },
    ],
    businessRules: [
      {
        ref: 'BR-1',
        statement: 'Deactivation is blocked while unpaid invoices exist unless finance overrides it.',
        appliesTo: 'Customer lifecycle',
      },
    ],
    constraints: [
      { kind: 'TECHNICAL', statement: 'PostgreSQL and Node.js estate', impact: 'Rules out a different data store' },
      { kind: 'TIMELINE', statement: 'First release needed within one quarter', impact: 'Limits scope' },
    ],
    assumptions: [
      {
        statement: 'Existing CRM data can be exported as CSV for a one-off migration.',
        riskIfWrong: 'Migration becomes a project of its own.',
        confidence: 0.5,
      },
    ],
    openQuestions: [
      {
        question: 'Who is authorised to grant the finance override on deactivation?',
        blocksRefs: ['REQ-003'],
        askedOf: 'Finance Manager',
        severity: 'HIGH',
      },
      {
        question: 'Is the 24-month audit retention a regulatory requirement or a preference?',
        blocksRefs: ['REQ-006'],
        severity: 'MEDIUM',
      },
    ],
    risks: [
      {
        description: 'Migration data quality from the legacy spreadsheet is unknown.',
        likelihood: 'MEDIUM',
        impact: 'HIGH',
        mitigation: 'Profile the export before committing to a migration approach.',
        severity: 'HIGH',
      },
    ],
    conflicts: [],
    missingInformation: [
      'Expected customer volume growth over the next 24 months',
      'Whether support agents need write access to invoices',
    ],
    decisionSummary: demoSummary(
      'Derived seven requirements from the discovery material, all traceable to the imported ' +
        'documents. Two open questions block the deactivation rule and the audit retention period.',
      0.78,
    ),
  };
}
