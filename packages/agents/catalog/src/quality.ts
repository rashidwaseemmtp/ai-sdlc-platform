/**
 * QA and Bug Analyzer agents — docs/23–27.
 *
 * The QA agent's hardest quality gate is coverage: every acceptance criterion must map to at least
 * one test case. A criterion with no test is an untested requirement, and the platform refuses to
 * let that pass silently.
 */

import { z } from 'zod';
import { ArtifactKind, type ModelRequest } from '@sdlc/shared';
import type { RegisteredAgent } from '@sdlc/agent-runtime';
import {
  BaseInput,
  DecisionSummary,
  POLICY,
  Priority,
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

// ── QA ─────────────────────────────────────────────────────────────────────

const TestCase = z.object({
  ref: z.string().regex(/^TC-\d+$/),
  title: z.string(),
  objective: z.string(),
  type: z.enum([
    'FUNCTIONAL',
    'REGRESSION',
    'INTEGRATION',
    'E2E',
    'ACCESSIBILITY',
    'SECURITY',
    'PERFORMANCE',
    'NEGATIVE',
    'EDGE_CASE',
    'API',
    'UI',
  ]),
  priority: Priority,
  criterionRef: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  testData: z.record(z.unknown()).default({}),
  steps: z.array(z.object({ action: z.string(), expected: z.string().optional() })).min(1),
  expectedResult: z.string().min(10),
  automationStatus: z.enum(['NOT_AUTOMATED', 'AUTOMATED', 'MANUAL_ONLY', 'FLAKY']).default('NOT_AUTOMATED'),
  specPath: z.string().optional(),
});

export const QaOutput = z.object({
  testCases: z.array(TestCase).default([]),
  specs: z.array(z.object({ path: z.string(), content: z.string(), covers: z.array(z.string()) })).default([]),
  report: z
    .object({
      verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
      summary: z.string(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      defects: z
        .array(
          z.object({
            title: z.string(),
            severity: Severity,
            testCaseRef: z.string(),
            description: z.string(),
            isTestDefect: z.boolean().default(false),
          }),
        )
        .default([]),
      notTested: z.array(z.string()).default([]),
    })
    .optional(),
  excludedTypes: z.array(z.object({ type: z.string(), reason: z.string() })).default([]),
  decisionSummary: DecisionSummary,
});
export type QaOutput = z.infer<typeof QaOutput>;

const QaInput = BaseInput.extend({
  phase: z.enum(['design-tests', 'automate', 'analyse']).default('design-tests'),
  storyRef: z.string(),
  criterionRefs: z.array(z.string()).default([]),
});

export const qaAgent: RegisteredAgent<z.infer<typeof QaInput>, QaOutput> = {
  definition: defineAgent({
    key: 'qa',
    name: 'QA',
    role: 'Designs, automates and interprets tests for an implemented story.',
    modelPolicy: POLICY.coding(),
    contextRecipe: 'qa',
    mcpServers: [
      mcp('playwright', ['*'], ['browser.full']),
      mcp('github', ['get_*'], ['repository.read']),
      mcp('figma', ['get_*'], ['design.read']),
      mcp('filesystem', ['*'], ['fs.read', 'fs.write']),
    ],
    permissions: ['read_project', 'read_backlog', 'run_tests'],
    writes: [ArtifactKind.TEST_PLAN, ArtifactKind.TEST_CASES, ArtifactKind.QA_REPORT],
    inputSchema: QaInput,
    outputSchema: QaOutput,
    timeoutSeconds: 1800,
    budget: { maxCostUsd: 5, maxToolCalls: 150, maxIterations: 40 },
    qualityChecks: [
      check<QaOutput>(
        'UNIQUE_TEST_REFS',
        'HARD',
        'test case refs are unique',
        (output) => {
          const seen = new Set<string>();
          const duplicates = output.testCases.filter((t) => !seen.add(t.ref)).map((t) => t.ref);
          return duplicates.length ? fail('duplicate test case refs', { duplicates }) : pass();
        },
      ),
      check<QaOutput>(
        'NEGATIVE_AND_EDGE_COVERAGE',
        'SOFT',
        'the suite includes negative and edge cases',
        (output) => {
          if (output.testCases.length === 0) return pass('no test cases in this phase');
          const types = new Set(output.testCases.map((t) => t.type));
          const missing = ['NEGATIVE', 'EDGE_CASE'].filter((type) => !types.has(type as 'NEGATIVE'));
          return missing.length
            ? fail('defects live in the cases this suite does not cover', { missing })
            : pass();
        },
      ),
      check<QaOutput>(
        'STEPS_ARE_CONCRETE',
        'SOFT',
        'expected results describe observable state',
        (output) => {
          const vague = output.testCases.filter((t) => /works|correct|as expected/i.test(t.expectedResult));
          return vague.length
            ? fail('expected results that assert nothing observable', { refs: vague.map((t) => t.ref) })
            : pass();
        },
      ),
      check<QaOutput>(
        'REPORT_COUNTS_RECONCILE',
        'HARD',
        'the report totals match its defect list',
        (output) => {
          if (!output.report) return pass('no report in this phase');
          const { verdict, failed, defects } = output.report;
          if (failed > 0 && defects.length === 0) {
            return fail('failures reported with no defects raised');
          }
          if (verdict === 'PASS' && failed > 0) {
            return fail('verdict PASS with failing tests');
          }
          return pass();
        },
      ),
    ],
  }),
  inputSchema: QaInput,
  outputSchema: QaOutput,

  promptVariables: (invocation) => ({
    phase: String((invocation.input as { phase?: string }).phase ?? 'design-tests'),
  }),

  toArtifacts: (output, invocation) => {
    const input = invocation.input as { phase?: string; storyRef?: string };
    const kind =
      input.phase === 'analyse'
        ? ArtifactKind.QA_REPORT
        : input.phase === 'automate'
          ? ArtifactKind.TEST_PLAN
          : ArtifactKind.TEST_CASES;
    return [
      {
        kind,
        name: `${kind.toLowerCase().replace(/_/g, '-')}-${input.storyRef ?? ''}`,
        scope: 'STORY',
        scopeRef: invocation.subjectRef ?? input.storyRef ?? '',
        content: output,
      },
    ];
  },

  async project(output, { prisma, invocation }) {
    const projectId = invocation.projectId;
    const storyRef = (invocation.input as { storyRef?: string }).storyRef;
    if (!storyRef || output.testCases.length === 0) return;

    const story = await prisma.story.findUnique({ where: { projectId_ref: { projectId, ref: storyRef } } });
    if (!story) return;

    const criteria = await prisma.acceptanceCriterion.findMany({ where: { storyId: story.id } });
    const criterionByRef = new Map(criteria.map((c) => [c.ref, c.id]));

    for (const testCase of output.testCases) {
      const data = {
        title: testCase.title,
        objective: testCase.objective,
        type: testCase.type,
        priority: testCase.priority,
        preconditions: testCase.preconditions as object,
        testData: testCase.testData as object,
        steps: testCase.steps as object,
        expectedResult: testCase.expectedResult,
        automationStatus: testCase.automationStatus,
        ...(testCase.specPath ? { specPath: testCase.specPath } : {}),
        ...(testCase.criterionRef && criterionByRef.has(testCase.criterionRef)
          ? { acceptanceCriterionId: criterionByRef.get(testCase.criterionRef)! }
          : {}),
      };

      await prisma.testCase.upsert({
        where: { projectId_ref: { projectId, ref: testCase.ref } },
        create: { projectId, storyId: story.id, ref: testCase.ref, ...data },
        update: data,
      });
    }
  },
};

// ── Bug Analyzer ───────────────────────────────────────────────────────────

export const BugAnalyzerOutput = z.object({
  bugs: z
    .array(
      z.object({
        ref: z.string(),
        title: z.string(),
        description: z.string(),
        severity: Severity,
        testCaseRefs: z.array(z.string()).min(1),
        reproSteps: z.array(z.string()).min(1),
        rootCauseAnalysis: z.string().min(30),
        suspectedLocation: z.string().optional(),
        isTestDefect: z.boolean().default(false),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  insufficientEvidence: z.array(z.object({ testCaseRef: z.string(), needed: z.string() })).default([]),
  fixOrder: z.array(z.string()).default([]),
  decisionSummary: DecisionSummary,
});
export type BugAnalyzerOutput = z.infer<typeof BugAnalyzerOutput>;

const BugAnalyzerInput = BaseInput.extend({ storyRef: z.string(), testRunId: z.string().optional() });

export const bugAnalyzerAgent: RegisteredAgent<z.infer<typeof BugAnalyzerInput>, BugAnalyzerOutput> = {
  definition: defineAgent({
    key: 'bug-analyzer',
    name: 'Bug Analyzer',
    role: 'Determines the root cause behind failing tests so the fix addresses the cause.',
    modelPolicy: POLICY.coding(),
    contextRecipe: 'bug-analyzer',
    mcpServers: [
      mcp('github', ['get_*'], ['repository.read']),
      mcp('playwright', ['get_*'], ['browser.read']),
      mcp('filesystem', ['read_file', 'search'], ['fs.read']),
    ],
    permissions: ['read_project', 'read_backlog'],
    writes: [ArtifactKind.BUG],
    inputSchema: BugAnalyzerInput,
    outputSchema: BugAnalyzerOutput,
    budget: { maxCostUsd: 2 },
    qualityChecks: [
      check<BugAnalyzerOutput>(
        'BUGS_REFERENCE_FAILURES',
        'HARD',
        'every bug references at least one failing test',
        (output) => {
          const orphans = output.bugs.filter((b) => b.testCaseRefs.length === 0);
          return orphans.length ? fail('bugs with no failing test behind them') : pass();
        },
      ),
      check<BugAnalyzerOutput>(
        'ROOT_CAUSE_IS_SPECIFIC',
        'SOFT',
        'root cause names a mechanism, not a layer',
        (output) => {
          const vague = output.bugs.filter((b) => /error in the|problem with the|issue in/i.test(b.rootCauseAnalysis));
          return vague.length
            ? fail('root causes that name a layer rather than a mechanism', { refs: vague.map((b) => b.ref) })
            : pass();
        },
      ),
      check<BugAnalyzerOutput>(
        'LOW_CONFIDENCE_IS_ESCALATED',
        'SOFT',
        'low-confidence diagnoses ask for evidence instead of guessing',
        (output) => {
          const guesses = output.bugs.filter((b) => b.confidence < 0.4);
          return guesses.length && output.insufficientEvidence.length === 0
            ? fail('low-confidence root causes with no request for further evidence', {
                refs: guesses.map((b) => b.ref),
              })
            : pass();
        },
      ),
    ],
  }),
  inputSchema: BugAnalyzerInput,
  outputSchema: BugAnalyzerOutput,

  toArtifacts: (output, invocation) => [
    {
      kind: ArtifactKind.BUG,
      name: `bugs-${String((invocation.input as { storyRef?: string }).storyRef ?? '')}`,
      scope: 'STORY',
      scopeRef: invocation.subjectRef ?? '',
      content: output,
    },
  ],

  async project(output, { prisma, invocation }) {
    const projectId = invocation.projectId;
    const storyRef = (invocation.input as { storyRef?: string }).storyRef;
    const story = storyRef
      ? await prisma.story.findUnique({ where: { projectId_ref: { projectId, ref: storyRef } } })
      : null;

    for (const bug of output.bugs) {
      const testCase = await prisma.testCase.findUnique({
        where: { projectId_ref: { projectId, ref: bug.testCaseRefs[0]! } },
      });

      await prisma.bug.upsert({
        where: { projectId_ref: { projectId, ref: bug.ref } },
        create: {
          projectId,
          ...(story ? { storyId: story.id } : {}),
          ...(testCase ? { testCaseId: testCase.id } : {}),
          ref: bug.ref,
          title: bug.title,
          description: bug.description,
          severity: bug.severity,
          reproSteps: bug.reproSteps as object,
          rootCauseAnalysis: bug.rootCauseAnalysis,
          status: 'OPEN',
        },
        update: { rootCauseAnalysis: bug.rootCauseAnalysis, severity: bug.severity },
      });
    }
  },
};

// ── demo handlers ──────────────────────────────────────────────────────────

interface DemoCriterion {
  ref: string;
  given?: string | null;
  whenText?: string | null;
  thenText?: string | null;
}

/**
 * The demo deliberately fails one test on the first pass. That is what exercises the bug-analysis
 * and bounded fix loop end to end rather than leaving them as untested code paths.
 */
let demoQaPass = 0;

export function resetQaDemoState(): void {
  demoQaPass = 0;
}

export function qaDemoHandler(req: ModelRequest): QaOutput {
  const { phase = 'design-tests', storyRef = 'US-101' } = readTask<{ phase?: string; storyRef?: string }>(req);
  const criteria = readJsonSection<DemoCriterion[]>(req, 'acceptance-criteria') ?? [];

  // Refs are unique per *project*, so they must incorporate the story. Deriving them from the
  // criterion index alone made three stories collide on TC-10..TC-12 and steal each other's cases.
  const storyNumber = Number(storyRef.replace(/\D/g, '')) || 1;
  const base = (index: number): number => storyNumber * 100 + index * 10;

  const testCases = criteria.flatMap((criterion, index) => [
    {
      ref: `TC-${base(index)}`,
      title: `${criterion.thenText ?? 'Expected behaviour'} (${criterion.ref})`,
      objective: `Verify acceptance criterion ${criterion.ref}`,
      type: 'FUNCTIONAL' as const,
      priority: 'MUST' as const,
      criterionRef: criterion.ref,
      preconditions: [criterion.given ?? 'the system is in its default state'],
      testData: { customer: 'CUST-001' },
      steps: [{ action: criterion.whenText ?? 'perform the action', expected: criterion.thenText ?? undefined }],
      expectedResult: criterion.thenText ?? 'the documented outcome is observable in the UI and the API response',
      automationStatus: 'AUTOMATED' as const,
      specPath: `tests/e2e/${storyRef.toLowerCase()}.spec.ts`,
    },
    {
      ref: `TC-${base(index) + 1}`,
      title: `Negative: ${criterion.ref} with invalid input`,
      objective: `Verify the system rejects invalid input for ${criterion.ref}`,
      type: 'NEGATIVE' as const,
      priority: 'SHOULD' as const,
      criterionRef: criterion.ref,
      preconditions: ['an authenticated administrator'],
      testData: { customer: 'MISSING' },
      steps: [{ action: 'submit the action against a non-existent customer' }],
      expectedResult: 'the API returns 404 and no audit entry is written',
      automationStatus: 'AUTOMATED' as const,
      specPath: `tests/e2e/${storyRef.toLowerCase()}.spec.ts`,
    },
    {
      ref: `TC-${base(index) + 2}`,
      title: `Edge case: ${criterion.ref} under concurrent modification`,
      objective: 'Verify concurrent actions cannot bypass the business rule',
      type: 'EDGE_CASE' as const,
      priority: 'SHOULD' as const,
      criterionRef: criterion.ref,
      preconditions: ['two administrators acting simultaneously'],
      testData: {},
      steps: [{ action: 'issue two deactivation requests concurrently' }],
      expectedResult: 'exactly one succeeds and the audit log contains one entry',
      automationStatus: 'AUTOMATED' as const,
      specPath: `tests/e2e/${storyRef.toLowerCase()}.spec.ts`,
    },
  ]);

  if (phase === 'design-tests') {
    return {
      testCases,
      specs: [],
      excludedTypes: [
        { type: 'PERFORMANCE', reason: 'No performance criterion in this story' },
        { type: 'ACCESSIBILITY', reason: 'Covered by the shared component suite, not per story' },
      ],
      decisionSummary: demoSummary(
        `Designed ${testCases.length} cases covering every acceptance criterion plus negative and ` +
          'concurrency edge cases.',
        0.82,
      ),
    };
  }

  if (phase === 'automate') {
    return {
      testCases: [],
      specs: [
        {
          path: `tests/e2e/${storyRef.toLowerCase()}.spec.ts`,
          covers: testCases.map((t) => t.ref),
          content: '// Playwright spec generated in demo mode\n',
        },
      ],
      excludedTypes: [],
      decisionSummary: demoSummary('Automated every designed case into one spec file.', 0.8),
    };
  }

  // analyse — first pass fails one edge case, second pass passes.
  demoQaPass += 1;
  const firstPass = demoQaPass === 1;
  const failingRef = testCases.find((t) => t.type === 'EDGE_CASE')?.ref ?? `TC-${base(0) + 2}`;

  return {
    testCases: [],
    specs: [],
    excludedTypes: [],
    report: {
      verdict: firstPass ? 'FAIL' : 'PASS',
      summary: firstPass
        ? 'Concurrent deactivation allowed two audit entries; the guard is not serialised.'
        : 'All cases pass, including the concurrency edge case after the fix.',
      passed: firstPass ? testCases.length - 1 : testCases.length,
      failed: firstPass ? 1 : 0,
      skipped: 0,
      defects: firstPass
        ? [
            {
              title: 'Concurrent deactivation writes two audit entries',
              severity: 'HIGH' as const,
              testCaseRef: failingRef,
              description:
                'Two simultaneous deactivation requests both succeed; the audit log shows two ' +
                'entries for one state transition.',
              isTestDefect: false,
            },
          ]
        : [],
      notTested: ['Performance under load'],
    },
    decisionSummary: demoSummary(
      firstPass
        ? 'One HIGH defect: the business rule is not protected against concurrent execution.'
        : 'Re-test after the fix passes; the concurrency case is now serialised.',
      0.85,
    ),
  };
}

export function bugAnalyzerDemoHandler(req: ModelRequest): BugAnalyzerOutput {
  const { storyRef = 'US-101' } = readTask<{ storyRef?: string }>(req);
  return {
    bugs: [
      {
        ref: 'BUG-1',
        title: 'Concurrent deactivation writes two audit entries',
        description:
          'Two simultaneous deactivation requests both pass the unpaid-invoice guard and both ' +
          'write an audit entry for the same state transition.',
        severity: 'HIGH',
        testCaseRefs: ['TC-12'],
        reproSteps: [
          `Create an active customer with no unpaid invoices in ${storyRef}`,
          'Issue two deactivation requests concurrently',
          'Inspect the audit log',
        ],
        rootCauseAnalysis:
          'The transaction reads the invoice count and the customer status without a row lock, so ' +
          'both transactions see the pre-update state before either commits. The guard is correct ' +
          'in isolation and wrong under concurrency; a SELECT ... FOR UPDATE on the customer row ' +
          'inside the transaction serialises them.',
        suspectedLocation: `src/customers/${storyRef.toLowerCase()}.service.ts`,
        isTestDefect: false,
        confidence: 0.86,
      },
    ],
    insufficientEvidence: [],
    fixOrder: ['BUG-1'],
    decisionSummary: demoSummary(
      'One defect, high confidence: the guard is not serialised. A row lock on the customer inside ' +
        'the existing transaction is the minimal fix.',
      0.86,
    ),
  };
}
