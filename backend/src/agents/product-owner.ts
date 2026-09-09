/**
 * Product Owner — turns raw client material into traceable requirements.
 *
 * It deliberately cannot write stories: the schema has no field for them, so a well-meaning attempt
 * to hand the Business Analyst a finished backlog fails validation rather than quietly succeeding.
 */

import { z } from 'zod';
import { db } from '../db.js';
import { DecisionSummary, Priority, Severity, defineAgent, fail, pass, renderChangeRequests } from './types.js';

const Requirement = z.object({
  ref: z.string().regex(/^REQ-\d{3}$/),
  type: z.enum(['FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT']),
  priority: Priority,
  statement: z.string().min(10),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1),
  /// Traceability is mandatory: a requirement nobody said is an assumption, not a requirement.
  sourceRefs: z.array(z.string()).min(1),
});

const Output = z.object({
  productVision: z.object({
    statement: z.string(),
    problem: z.string(),
    targetUsers: z.array(z.string()),
    successMetrics: z.array(z.string()),
  }),
  businessGoals: z.array(z.object({ ref: z.string(), title: z.string(), description: z.string(), priority: Priority })).default([]),
  stakeholders: z.array(z.object({ name: z.string(), role: z.string(), concerns: z.array(z.string()) })).default([]),
  requirements: z.array(Requirement).min(1),
  businessRules: z.array(z.object({ ref: z.string(), statement: z.string() })).default([]),
  constraints: z.array(z.object({ kind: z.string(), statement: z.string() })).default([]),
  assumptions: z.array(z.object({ statement: z.string(), riskIfWrong: z.string() })).default([]),
  openQuestions: z.array(z.object({ question: z.string(), blocksRefs: z.array(z.string()).default([]), severity: Severity })).default([]),
  risks: z.array(z.object({ description: z.string(), mitigation: z.string().optional(), severity: Severity })).default([]),
  /// Two sources disagreeing is information; picking one silently destroys it.
  conflicts: z.array(z.object({ leftRef: z.string(), rightRef: z.string(), nature: z.string(), suggestedResolution: z.string() })).default([]),
  decisionSummary: DecisionSummary,
});

export type ProductOwnerOutput = z.infer<typeof Output>;

export const productOwner = defineAgent<ProductOwnerOutput>({
  key: 'product-owner',
  name: 'Product Owner',
  role: 'Turns client conversations and documents into traceable product requirements.',
  context: ['documents', 'requirements'],
  schema: Output,

  task: (input) =>
    [
      'Read every source document and produce the requirements set.',
      'Cite the documentId shown in the context for each requirement in sourceRefs.',
      renderChangeRequests(input),
    ].join('\n'),

  checks: [
    {
      code: 'REQUIREMENT_TRACEABILITY',
      severity: 'HARD',
      description: 'every requirement cites at least one source document',
      run: (output) => {
        const untraced = output.requirements.filter((r) => r.sourceRefs.length === 0);
        return untraced.length
          ? fail(`${untraced.length} requirement(s) cite no source: ${untraced.map((r) => r.ref).join(', ')}`)
          : pass();
      },
    },
    {
      code: 'UNIQUE_REFS',
      severity: 'HARD',
      description: 'requirement refs are unique',
      run: (output) => {
        const seen = new Set<string>();
        const duplicates = output.requirements.filter((r) => !seen.add(r.ref)).map((r) => r.ref);
        return duplicates.length ? fail(`duplicate requirement refs: ${duplicates.join(', ')}`) : pass();
      },
    },
    {
      code: 'MEASURABLE_NFRS',
      severity: 'SOFT',
      description: 'non-functional requirements contain a measurable target',
      run: (output) => {
        const vague = output.requirements.filter((r) => r.type === 'NON_FUNCTIONAL' && !/\d/.test(r.statement));
        return vague.length
          ? fail(`non-functional requirements with no number are not testable: ${vague.map((r) => r.ref).join(', ')}`)
          : pass();
      },
    },
    {
      code: 'PRIORITISED',
      severity: 'SOFT',
      description: 'not everything is a MUST',
      run: (output) => {
        const musts = output.requirements.filter((r) => r.priority === 'MUST').length;
        return output.requirements.length >= 5 && musts === output.requirements.length
          ? fail('every requirement is MUST, which is not a prioritisation')
          : pass();
      },
    },
    {
      code: 'CONFIDENCE_SPREAD',
      severity: 'SOFT',
      description: 'confidence values are differentiated rather than uniform',
      run: (output) => {
        const values = new Set(output.requirements.map((r) => r.confidence));
        return output.requirements.length >= 5 && values.size === 1
          ? fail('every requirement carries the same confidence, which conveys no information')
          : pass();
      },
    },
  ],

  async persist(output, input) {
    // Only requirements become rows: the Business Analyst reads them, and traceability runs
    // through them. Vision, goals, risks and open questions stay on the run's output document,
    // which is what the dashboard renders.
    for (const requirement of output.requirements) {
      await db.requirement.upsert({
        where: { projectId_ref: { projectId: input.projectId, ref: requirement.ref } },
        create: {
          projectId: input.projectId,
          ref: requirement.ref,
          type: requirement.type,
          priority: requirement.priority,
          statement: requirement.statement,
          rationale: requirement.rationale ?? null,
          confidence: requirement.confidence,
          sourceRefs: requirement.sourceRefs,
          status: 'REVIEW',
        },
        update: {
          type: requirement.type,
          priority: requirement.priority,
          statement: requirement.statement,
          rationale: requirement.rationale ?? null,
          confidence: requirement.confidence,
          sourceRefs: requirement.sourceRefs,
        },
      });
    }
  },

  summary: (output) =>
    `${output.requirements.length} requirements, ${output.openQuestions.length} open questions, ` +
    `${output.conflicts.length} conflicts. ${output.decisionSummary.summary}`,
});
