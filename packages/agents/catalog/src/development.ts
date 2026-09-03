/**
 * Developer, Code Reviewer and Security Reviewer agents — docs/18–22.
 *
 * The developer is the only agent that may write code, and it may not merge. That is enforced in
 * three independent places: the grant matrix has no merge scope, `AI_MERGE_PERMISSION` defaults to
 * false, and the API rejects the merge endpoint for non-human actors (invariant I7).
 */

import { z } from 'zod';
import { ArtifactKind, type ModelRequest } from '@sdlc/shared';
import type { RegisteredAgent } from '@sdlc/agent-runtime';
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

// ── Developer ──────────────────────────────────────────────────────────────

const FileChange = z.object({
  path: z.string(),
  action: z.enum(['CREATE', 'MODIFY', 'DELETE']),
  content: z.string().optional(),
  rationale: z.string(),
});

export const DeveloperOutput = z.object({
  plan: z
    .array(z.object({ step: z.string(), rationale: z.string(), files: z.array(z.string()).default([]) }))
    .min(1),
  changes: z.array(FileChange).default([]),
  tests: z
    .array(z.object({ path: z.string(), covers: z.array(z.string()), content: z.string().optional() }))
    .default([]),
  branchName: z.string().optional(),
  commitMessage: z.string().optional(),
  pullRequest: z
    .object({
      title: z.string(),
      summary: z.string(),
      implementationDetails: z.string(),
      acceptanceCriteriaCoverage: z
        .array(z.object({ criterionRef: z.string(), satisfiedBy: z.string(), satisfied: z.boolean() }))
        .default([]),
      testsAdded: z.array(z.string()).default([]),
      knownLimitations: z.array(z.string()).default([]),
      securityConsiderations: z.array(z.string()).default([]),
    })
    .optional(),
  unsatisfiedCriteria: z.array(z.object({ criterionRef: z.string(), reason: z.string() })).default([]),
  observedIssues: z
    .array(z.object({ description: z.string(), location: z.string() }))
    .default([])
    .describe('Problems noticed but deliberately left alone as out of scope'),
  decisionSummary: DecisionSummary,
});
export type DeveloperOutput = z.infer<typeof DeveloperOutput>;

const DeveloperInput = BaseInput.extend({
  phase: z.enum(['plan', 'implement', 'address-review', 'fix']).default('plan'),
  storyRef: z.string(),
  reviewComments: z
    .array(z.object({ path: z.string().optional(), line: z.number().optional(), body: z.string() }))
    .default([]),
  bugRefs: z.array(z.string()).default([]),
});

export const developerAgent: RegisteredAgent<z.infer<typeof DeveloperInput>, DeveloperOutput> = {
  definition: defineAgent({
    key: 'developer',
    name: 'Developer',
    role: 'Implements one story against the development context package and opens a pull request.',
    modelPolicy: POLICY.coding({ minimumTier: 'FRONTIER', effort: 'xhigh' }),
    contextRecipe: 'developer',
    mcpServers: [
      mcp('github', ['get_*', 'search_*', 'create_branch', 'commit', 'push', 'create_pull_request'], [
        'repository.read',
        'branch.create',
        'commit.create',
        'push',
        'pull_request.create',
      ]),
      mcp('figma', ['get_*'], ['design.read']),
      mcp('filesystem', ['*'], ['fs.read', 'fs.write']),
      mcp('ba', ['get_*'], ['backlog.read']),
    ],
    permissions: ['read_project', 'read_backlog', 'create_branch', 'write_code', 'push_code', 'create_pr'],
    writes: [ArtifactKind.IMPLEMENTATION_PLAN],
    inputSchema: DeveloperInput,
    outputSchema: DeveloperOutput,
    timeoutSeconds: 2400,
    budget: { maxCostUsd: 10, maxTokens: 900_000, maxToolCalls: 200, maxIterations: 60, maxWallClockSeconds: 2400 },
    qualityChecks: [
      check<DeveloperOutput>(
        'NO_SECRETS_IN_DIFF',
        'HARD',
        'no credentials in the produced changes',
        (output) => {
          const patterns = [
            /\bsk-[A-Za-z0-9_-]{16,}/,
            /\bgh[pousr]_[A-Za-z0-9]{16,}/,
            /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
            /\b(password|secret|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
          ];
          const offenders = output.changes
            .filter((change) => change.content && patterns.some((p) => p.test(change.content!)))
            .map((change) => change.path);
          return offenders.length ? fail('possible secret in the diff', { files: offenders }) : pass();
        },
      ),
      check<DeveloperOutput>(
        'NO_PROTECTED_PATHS',
        'HARD',
        'the change does not touch protected files',
        (output) => {
          const protectedPaths = /(^|\/)(\.env|\.git\/config|.*\.pem|.*\.key|id_rsa)/;
          const offenders = output.changes.filter((c) => protectedPaths.test(c.path)).map((c) => c.path);
          return offenders.length ? fail('change touches protected paths', { files: offenders }) : pass();
        },
      ),
      check<DeveloperOutput>(
        'CRITERIA_ACCOUNTED_FOR',
        'SOFT',
        'every acceptance criterion is either satisfied or explicitly reported as unsatisfied',
        (output) => {
          if (!output.pullRequest) return pass('no PR in this phase');
          const unsatisfied = output.pullRequest.acceptanceCriteriaCoverage.filter((c) => !c.satisfied);
          const declared = new Set(output.unsatisfiedCriteria.map((c) => c.criterionRef));
          const silent = unsatisfied.filter((c) => !declared.has(c.criterionRef));
          return silent.length
            ? fail('criteria marked unsatisfied but not reported in unsatisfiedCriteria', {
                refs: silent.map((c) => c.criterionRef),
              })
            : pass();
        },
      ),
      check<DeveloperOutput>(
        'TESTS_ACCOMPANY_CODE',
        'SOFT',
        'implementation changes are accompanied by tests',
        (output) => {
          const codeChanges = output.changes.filter(
            (c) => c.action !== 'DELETE' && !/\.(md|json|ya?ml)$/.test(c.path) && !/test|spec/.test(c.path),
          );
          return codeChanges.length > 0 && output.tests.length === 0
            ? fail('code changed with no tests added')
            : pass();
        },
      ),
    ],
  }),
  inputSchema: DeveloperInput,
  outputSchema: DeveloperOutput,

  promptVariables: (invocation) => ({
    phase: String((invocation.input as { phase?: string }).phase ?? 'plan'),
  }),

  contextVariables: (invocation) => {
    const input = invocation.input as { reviewComments?: unknown; changeRequests?: unknown };
    return {
      changeRequests: input.changeRequests ?? [],
      reviewComments: input.reviewComments ?? [],
      retrievalQuery: 'implementation, endpoints, validation, authorisation',
    };
  },

  toArtifacts: (output, invocation) => {
    const storyRef = String((invocation.input as { storyRef?: string }).storyRef ?? 'unknown');
    return [
      {
        kind: ArtifactKind.IMPLEMENTATION_PLAN,
        name: `implementation-plan-${storyRef}`,
        scope: 'STORY',
        scopeRef: invocation.subjectRef ?? storyRef,
        content: output,
      },
    ];
  },
};

// ── Code Reviewer ──────────────────────────────────────────────────────────

const Finding = z.object({
  path: z.string(),
  line: z.number().int().nonnegative().optional(),
  severity: Severity,
  category: z.string(),
  body: z.string().min(20),
});

export const CodeReviewOutput = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'REJECT', 'COMMENT']),
  summary: z.string(),
  findings: z.array(Finding).default([]),
  criteriaVerified: z
    .array(z.object({ criterionRef: z.string(), verified: z.boolean(), evidence: z.string() }))
    .default([]),
  notChecked: z.array(z.string()).default([]),
  decisionSummary: DecisionSummary,
});
export type CodeReviewOutput = z.infer<typeof CodeReviewOutput>;

const ReviewInput = BaseInput.extend({
  storyRef: z.string(),
  prNumber: z.number().int().positive().optional(),
});

const reviewChecks = [
  check<CodeReviewOutput>(
    'FINDINGS_LOCATED',
    'HARD',
    'every finding names a file',
    (output) => {
      const unlocated = output.findings.filter((f) => !f.path.trim());
      return unlocated.length ? fail('findings without a file are not actionable') : pass();
    },
  ),
  check<CodeReviewOutput>(
    'VERDICT_MATCHES_FINDINGS',
    'HARD',
    'an approval carries no blocking findings',
    (output) => {
      const blocking = output.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
      return output.verdict === 'APPROVE' && blocking.length
        ? fail('approved despite blocking findings', { count: blocking.length })
        : pass();
    },
  ),
];

export const codeReviewerAgent: RegisteredAgent<z.infer<typeof ReviewInput>, CodeReviewOutput> = {
  definition: defineAgent({
    key: 'code-reviewer',
    name: 'Code Reviewer',
    role: 'Reviews a pull request for correctness, bugs, edge cases and architecture conformance.',
    modelPolicy: POLICY.coding(),
    contextRecipe: 'code-reviewer',
    mcpServers: [
      mcp('github', ['get_*', 'search_*'], ['repository.read']),
      mcp('filesystem', ['read_file', 'search'], ['fs.read']),
    ],
    permissions: ['read_project', 'read_backlog'],
    writes: [ArtifactKind.CODE_REVIEW],
    inputSchema: ReviewInput,
    outputSchema: CodeReviewOutput,
    budget: { maxCostUsd: 2 },
    qualityChecks: reviewChecks,
  }),
  inputSchema: ReviewInput,
  outputSchema: CodeReviewOutput,
  toArtifacts: (output, invocation) => [
    {
      kind: ArtifactKind.CODE_REVIEW,
      name: `code-review-${String((invocation.input as { storyRef?: string }).storyRef ?? '')}`,
      scope: 'STORY',
      scopeRef: invocation.subjectRef ?? '',
      content: output,
    },
  ],
};

export const securityReviewerAgent: RegisteredAgent<z.infer<typeof ReviewInput>, CodeReviewOutput> = {
  definition: defineAgent({
    key: 'security-reviewer',
    name: 'Security Reviewer',
    role: 'Reviews a pull request for security defects only.',
    modelPolicy: POLICY.coding(),
    contextRecipe: 'security-reviewer',
    mcpServers: [
      mcp('github', ['get_*'], ['repository.read']),
      mcp('filesystem', ['read_file', 'search'], ['fs.read']),
    ],
    permissions: ['read_project'],
    writes: [ArtifactKind.SECURITY_REVIEW],
    inputSchema: ReviewInput,
    outputSchema: CodeReviewOutput,
    budget: { maxCostUsd: 2 },
    qualityChecks: reviewChecks,
  }),
  inputSchema: ReviewInput,
  outputSchema: CodeReviewOutput,
  toArtifacts: (output, invocation) => [
    {
      kind: ArtifactKind.SECURITY_REVIEW,
      name: `security-review-${String((invocation.input as { storyRef?: string }).storyRef ?? '')}`,
      scope: 'STORY',
      scopeRef: invocation.subjectRef ?? '',
      content: output,
    },
  ],
};

// ── demo handlers ──────────────────────────────────────────────────────────

interface DemoCriterion {
  ref: string;
  given?: string;
  whenText?: string;
  thenText?: string;
}

export function developerDemoHandler(req: ModelRequest): DeveloperOutput {
  const { phase = 'plan', storyRef = 'US-101' } = readTask<{ phase?: string; storyRef?: string }>(req);
  const criteria = readJsonSection<DemoCriterion[]>(req, 'acceptance-criteria') ?? [];
  const slug = storyRef.toLowerCase();

  if (phase === 'plan') {
    return {
      plan: [
        { step: 'Add the status column and migration', rationale: 'Deactivation needs persisted state', files: ['prisma/schema.prisma'] },
        { step: 'Implement the service method with the unpaid-invoice guard', rationale: 'The blocking business rule lives in one place', files: [`src/customers/${slug}.service.ts`] },
        { step: 'Expose the endpoint with role checks', rationale: 'Only administrators may deactivate', files: [`src/customers/${slug}.controller.ts`] },
        { step: 'Write the audit entry in the same transaction', rationale: 'An audit gap is worse than a failed request', files: [`src/customers/${slug}.service.ts`] },
        { step: 'Cover the criteria and edge cases with tests', rationale: 'Each acceptance criterion needs a failing-first test', files: [`src/customers/${slug}.service.spec.ts`] },
      ],
      changes: [],
      tests: [],
      unsatisfiedCriteria: [],
      observedIssues: [],
      decisionSummary: demoSummary(
        `Plan for ${storyRef}: keep the invoice check and the status change in one transaction so ` +
          'the business rule cannot be raced.',
        0.82,
      ),
    };
  }

  return {
    plan: [{ step: 'Implement the approved plan', rationale: 'Plan approved in the previous phase', files: [] }],
    changes: [
      {
        path: `src/customers/${slug}.service.ts`,
        action: 'CREATE',
        rationale: 'Service method enforcing the unpaid-invoice rule inside one transaction',
        content:
          `export class ${slug.replace(/[^a-z]/g, '')}Service {\n` +
          '  async deactivate(customerId: string, actorId: string) {\n' +
          '    return this.prisma.$transaction(async (tx) => {\n' +
          '      const unpaid = await tx.invoice.count({ where: { customerId, status: "UNPAID" } });\n' +
          '      if (unpaid > 0) throw new BlockedByUnpaidInvoicesError(customerId, unpaid);\n' +
          '      const customer = await tx.customer.update({\n' +
          '        where: { id: customerId },\n' +
          '        data: { status: "INACTIVE", deactivatedAt: new Date() },\n' +
          '      });\n' +
          '      await tx.auditEntry.create({\n' +
          '        data: { actorId, customerId, action: "CUSTOMER_DEACTIVATED" },\n' +
          '      });\n' +
          '      return customer;\n' +
          '    });\n' +
          '  }\n' +
          '}\n',
      },
    ],
    tests: [
      {
        path: `src/customers/${slug}.service.spec.ts`,
        covers: criteria.map((c) => c.ref),
        content: '// generated in demo mode; covers each acceptance criterion and the concurrency edge case\n',
      },
    ],
    branchName: `feat/${storyRef}-implementation`,
    commitMessage: `feat(${storyRef}): implement customer deactivation with the unpaid-invoice guard`,
    pullRequest: {
      title: `${storyRef}: Deactivate customer account`,
      summary: 'Adds the deactivation endpoint, the blocking unpaid-invoice rule, and audit logging.',
      implementationDetails:
        'The invoice check and the status change run inside a single transaction, so a customer ' +
        'cannot be deactivated concurrently with an invoice being raised.',
      acceptanceCriteriaCoverage: criteria.map((criterion) => ({
        criterionRef: criterion.ref,
        satisfiedBy: `src/customers/${slug}.service.ts`,
        satisfied: true,
      })),
      testsAdded: [`src/customers/${slug}.service.spec.ts`],
      knownLimitations: ['The finance override path is not implemented; its authorisation rule is still an open question.'],
      securityConsiderations: ['Endpoint requires the admin role', 'Audit entry is written in the same transaction as the change'],
    },
    unsatisfiedCriteria: [],
    observedIssues: [
      { description: 'Invoice status is a string rather than an enum', location: 'prisma/schema.prisma' },
    ],
    decisionSummary: demoSummary(
      `Implemented ${storyRef} with the business rule enforced transactionally. The finance ` +
        'override is deliberately not implemented pending an answer on who may authorise it.',
      0.8,
    ),
  };
}

export function codeReviewerDemoHandler(req: ModelRequest): CodeReviewOutput {
  const criteria = readJsonSection<DemoCriterion[]>(req, 'acceptance-criteria') ?? [];
  return {
    verdict: 'APPROVE',
    summary:
      'The unpaid-invoice rule is enforced inside the same transaction as the status change, which ' +
      'closes the obvious race. Audit logging is present. Tests cover each acceptance criterion.',
    findings: [
      {
        path: 'src/customers/us-101.service.ts',
        line: 5,
        severity: 'LOW',
        category: 'maintainability',
        body: 'The invoice status literal "UNPAID" is repeated; an enum would prevent a typo from silently disabling the guard.',
      },
    ],
    criteriaVerified: criteria.map((criterion) => ({
      criterionRef: criterion.ref,
      verified: true,
      evidence: 'Covered by a test in us-101.service.spec.ts and by the transactional guard.',
    })),
    notChecked: ['Frontend rendering of the blocking warning was not in this diff'],
    decisionSummary: demoSummary(
      'Approved. One low-severity maintainability note; nothing blocking.',
      0.85,
    ),
  };
}

export function securityReviewerDemoHandler(): CodeReviewOutput {
  return {
    verdict: 'APPROVE',
    summary:
      'Authorisation is enforced at the endpoint, the audit entry is written transactionally, and ' +
      'no user-controlled input reaches an interpreter unparameterised.',
    findings: [],
    criteriaVerified: [],
    notChecked: ['Dependency changes — this diff adds none'],
    decisionSummary: demoSummary('No security findings in the reviewed surface.', 0.8),
  };
}
