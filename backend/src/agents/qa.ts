/**
 * QA and Bug Analyzer.
 *
 * QA works in two phases against the same schema: `design` writes test cases from the acceptance
 * criteria, `execute` reports what happened when they were run. The split matters — a model asked
 * to design and report in one turn will tell you its own tests passed.
 *
 * How execution actually happens depends on what has been granted on the MCP page. With a browser
 * or shell server granted, QA runs the tests and reports observations. With nothing granted it can
 * only reason over the diff, and it must say so: an untested case is recorded as NOT_RUN, never as
 * a pass.
 */

import { z } from 'zod';
import { db } from '../db.js';
import { DecisionSummary, Priority, Severity, defineAgent, fail, pass } from './types.js';

// ── QA ─────────────────────────────────────────────────────────────────────

const TestCase = z.object({
  ref: z.string().regex(/^TC-\d+$/),
  title: z.string().min(3),
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
  /** The acceptance criterion this case verifies, where it maps to one. */
  criterionRef: z.string().optional(),
  steps: z.array(z.object({ action: z.string(), expected: z.string().optional() })).min(1),
  expectedResult: z.string().min(10),
});

const Result = z.object({
  ref: z.string(),
  /** NOT_RUN is a legitimate answer and the required one when nothing executed the case. */
  result: z.enum(['PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN']),
  observed: z.string().min(1),
  /** How this was established: which tool ran, or "reasoned from the diff". */
  evidence: z.string().min(1),
});

const QaOutput = z.object({
  testCases: z.array(TestCase).default([]),
  results: z.array(Result).default([]),
  verdict: z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']),
  summary: z.string().min(1),
  /** Things that should be tested and were not, with the reason. */
  gaps: z.array(z.string()).default([]),
  decisionSummary: DecisionSummary,
});

export type QaOutput = z.infer<typeof QaOutput>;

export const qa = defineAgent<QaOutput>({
  key: 'qa',
  name: 'QA',
  role: 'Designs test cases from the acceptance criteria and reports what happened when they ran.',
  context: ['story', 'code', 'qa'],
  schema: QaOutput,

  task: (input) => {
    const phase = String(input.vars.phase ?? 'design');
    if (phase === 'design') {
      return [
        `Design the test suite for story ${String(input.vars.storyRef)}.`,
        'Cover every acceptance criterion, plus the negative and edge cases the story names.',
        'Number cases TC-1, TC-2, … and leave `results` empty — nothing has run yet.',
        'Set verdict to NOT_RUN.',
      ].join('\n');
    }

    return [
      `Execute the test suite for story ${String(input.vars.storyRef)}. The cases are in the context.`,
      '',
      'Run what you can with the tools you have been granted. For anything you could not actually',
      'execute, report NOT_RUN — never PASSED. Say in `evidence` how each result was established:',
      'which tool ran it, or that you reasoned from the diff.',
      '',
      'Leave `testCases` empty; you are reporting on the existing suite, not redesigning it.',
    ].join('\n');
  },

  checks: [
    {
      code: 'UNIQUE_TEST_REFS',
      severity: 'HARD',
      description: 'test case refs are unique',
      run: (output) => {
        const seen = new Set<string>();
        const duplicates = output.testCases.filter((testCase) => !seen.add(testCase.ref)).map((t) => t.ref);
        return duplicates.length ? fail(`duplicate test case refs: ${duplicates.join(', ')}`) : pass();
      },
    },
    {
      code: 'RESULTS_CARRY_EVIDENCE',
      severity: 'HARD',
      description: 'every result says how it was established',
      run: (output) => {
        const bare = output.results.filter((result) => !result.evidence.trim()).map((r) => r.ref);
        return bare.length ? fail(`results with no evidence: ${bare.join(', ')}`) : pass();
      },
    },
    {
      code: 'VERDICT_MATCHES_RESULTS',
      severity: 'HARD',
      description: 'a pass verdict has no failing cases behind it',
      run: (output) => {
        const failed = output.results.filter((result) => result.result === 'FAILED');
        return output.verdict === 'PASS' && failed.length
          ? fail(`verdict PASS with ${failed.length} failing case(s)`)
          : pass();
      },
    },
    {
      code: 'NEGATIVE_AND_EDGE_COVERAGE',
      severity: 'SOFT',
      description: 'the suite includes negative and edge cases',
      run: (output) => {
        if (output.testCases.length === 0) return pass('not a design run');
        const types = new Set(output.testCases.map((testCase) => testCase.type));
        const missing = ['NEGATIVE', 'EDGE_CASE'].filter((type) => !types.has(type as 'NEGATIVE'));
        return missing.length
          ? fail(`defects live in the cases this suite does not cover: ${missing.join(', ')}`)
          : pass();
      },
    },
    {
      code: 'EXPECTATIONS_ARE_OBSERVABLE',
      severity: 'SOFT',
      description: 'expected results describe observable state',
      run: (output) => {
        const vague = output.testCases
          .filter((testCase) => /works|correct|as expected|properly/i.test(testCase.expectedResult))
          .map((testCase) => testCase.ref);
        return vague.length ? fail(`unobservable expected results: ${vague.join(', ')}`) : pass();
      },
    },
  ],

  async persist(output, input) {
    const storyRef = String(input.vars.storyRef);
    const story = await db.story.findUnique({
      where: { projectId_ref: { projectId: input.projectId, ref: storyRef } },
    });
    if (!story) return;

    const round = Number(input.vars.round ?? 0);

    for (const testCase of output.testCases) {
      // Refs are numbered per story, so two stories can both have a TC-1.
      const ref = `${storyRef}/${testCase.ref}`;
      const data = {
        title: testCase.title,
        objective: testCase.objective,
        type: testCase.type,
        priority: testCase.priority,
        criterionRef: testCase.criterionRef ?? null,
        steps: testCase.steps,
        expectedResult: testCase.expectedResult,
        status: 'DESIGNED',
      };
      await db.testCase.upsert({
        where: { projectId_ref: { projectId: input.projectId, ref } },
        create: { projectId: input.projectId, storyId: story.id, ref, ...data },
        update: data,
      });
    }

    for (const result of output.results) {
      const ref = result.ref.includes('/') ? result.ref : `${storyRef}/${result.ref}`;
      const existing = await db.testCase.findUnique({
        where: { projectId_ref: { projectId: input.projectId, ref } },
      });
      // A result for a case that was never designed is dropped rather than invented into being.
      if (!existing) continue;

      await db.testCase.update({
        where: { id: existing.id },
        data: {
          result: result.result,
          status: 'RUN',
          evidence: { observed: result.observed, evidence: result.evidence },
          runRound: round,
        },
      });
    }
  },

  summary: (output) => {
    if (output.testCases.length) return `${output.testCases.length} test cases designed. ${output.summary}`;
    const failed = output.results.filter((result) => result.result === 'FAILED').length;
    const passed = output.results.filter((result) => result.result === 'PASSED').length;
    return `${output.verdict}: ${passed} passed, ${failed} failed of ${output.results.length}. ${output.summary}`;
  },
});

// ── Bug Analyzer ───────────────────────────────────────────────────────────

const BugOutput = z.object({
  bugs: z
    .array(
      z.object({
        ref: z.string().regex(/^BUG-\d+$/),
        title: z.string().min(3),
        description: z.string().min(10),
        severity: Severity,
        testCaseRefs: z.array(z.string()).min(1),
        reproSteps: z.array(z.string()).min(1),
        /** The mechanism, not the layer. "The controller has a bug" is not a root cause. */
        rootCause: z.string().min(30),
        suspectedLocation: z.string().optional(),
        /** True when the test is wrong rather than the code. Fixing the wrong one wastes a round. */
        isTestDefect: z.boolean().default(false),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  /** Failures the evidence cannot explain, with what would be needed to explain them. */
  insufficientEvidence: z.array(z.object({ testCaseRef: z.string(), needed: z.string() })).default([]),
  fixOrder: z.array(z.string()).default([]),
  decisionSummary: DecisionSummary,
});

export type BugAnalyzerOutput = z.infer<typeof BugOutput>;

export const bugAnalyzer = defineAgent<BugAnalyzerOutput>({
  key: 'bug-analyzer',
  name: 'Bug Analyzer',
  role: 'Finds the root cause behind failing tests, so the fix addresses the cause and not the symptom.',
  context: ['story', 'code', 'qa'],
  schema: BugOutput,

  task: (input) =>
    [
      `Diagnose the failing tests for story ${String(input.vars.storyRef)}.`,
      'The failures, the diff and the story are in the context.',
      '',
      'For each failure, decide whether the code is wrong or the test is wrong, and say which in',
      '`isTestDefect` — fixing the wrong one wastes a whole round. Where the evidence does not',
      'support a diagnosis, put it in `insufficientEvidence` and say what would settle it, rather',
      'than guessing.',
    ].join('\n'),

  checks: [
    {
      code: 'BUGS_REFERENCE_FAILURES',
      severity: 'HARD',
      description: 'every bug references at least one failing test',
      run: (output) => {
        const orphans = output.bugs.filter((bug) => bug.testCaseRefs.length === 0).length;
        return orphans ? fail(`${orphans} bug(s) with no failing test behind them`) : pass();
      },
    },
    {
      code: 'ROOT_CAUSE_IS_SPECIFIC',
      severity: 'SOFT',
      description: 'the root cause names a mechanism, not a layer',
      run: (output) => {
        const vague = output.bugs
          .filter((bug) => /error in the|problem with the|issue in the/i.test(bug.rootCause))
          .map((bug) => bug.ref);
        return vague.length ? fail(`root causes naming a layer rather than a mechanism: ${vague.join(', ')}`) : pass();
      },
    },
    {
      code: 'LOW_CONFIDENCE_IS_ESCALATED',
      severity: 'SOFT',
      description: 'low-confidence diagnoses ask for evidence instead of guessing',
      run: (output) => {
        const guesses = output.bugs.filter((bug) => bug.confidence < 0.4);
        return guesses.length && output.insufficientEvidence.length === 0
          ? fail('low-confidence root causes with no request for further evidence')
          : pass();
      },
    },
  ],

  async persist(output, input) {
    const storyRef = String(input.vars.storyRef);
    const story = await db.story.findUnique({
      where: { projectId_ref: { projectId: input.projectId, ref: storyRef } },
    });
    if (!story) return;

    for (const bug of output.bugs) {
      const ref = `${storyRef}/${bug.ref}`;
      const data = {
        title: bug.title,
        description: bug.description,
        severity: bug.severity,
        testCaseRefs: bug.testCaseRefs,
        rootCause: bug.rootCause,
        isTestDefect: bug.isTestDefect,
        status: 'OPEN',
      };
      await db.bug.upsert({
        where: { projectId_ref: { projectId: input.projectId, ref } },
        create: { projectId: input.projectId, storyId: story.id, ref, ...data },
        update: data,
      });
    }
  },

  summary: (output) =>
    `${output.bugs.length} bug(s), ${output.bugs.filter((bug) => bug.isTestDefect).length} of them test defects. ` +
    output.decisionSummary.summary,
});
