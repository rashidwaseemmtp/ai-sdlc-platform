/**
 * Code Reviewer and Security Reviewer.
 *
 * Two agents rather than one, with the same output schema and different prompts, because a single
 * "review this" pass reliably finds the correctness bugs and skips the security ones. They run
 * independently over the same diff and their verdicts are combined by the strictest — a security
 * rejection is not softened by a code approval.
 *
 * Neither can approve while holding a blocking finding. That is a check, not a convention.
 */

import { z } from 'zod';
import { DecisionSummary, Severity, defineAgent, fail, pass } from './types.js';

const Finding = z.object({
  path: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
  severity: Severity,
  category: z.string(),
  body: z.string().min(20),
  /** What to do about it. A finding without one is an observation, not a review. */
  suggestion: z.string(),
});

const Output = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'REJECT']),
  summary: z.string().min(1),
  findings: z.array(Finding).default([]),
  /** Parts of the change this reviewer did not examine, said plainly. */
  notChecked: z.array(z.string()).default([]),
  decisionSummary: DecisionSummary,
});

export type ReviewOutput = z.infer<typeof Output>;

const checks = [
  {
    code: 'FINDINGS_LOCATED',
    severity: 'HARD' as const,
    description: 'every finding names a file',
    run: (output: ReviewOutput) => {
      const unlocated = output.findings.filter((finding) => !finding.path.trim()).length;
      return unlocated ? fail(`${unlocated} finding(s) name no file, so they are not actionable`) : pass();
    },
  },
  {
    code: 'VERDICT_MATCHES_FINDINGS',
    severity: 'HARD' as const,
    description: 'an approval carries no blocking findings',
    run: (output: ReviewOutput) => {
      const blocking = output.findings.filter(
        (finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH',
      );
      return output.verdict === 'APPROVE' && blocking.length
        ? fail(`approved despite ${blocking.length} blocking finding(s)`)
        : pass();
    },
  },
];

export const codeReviewer = defineAgent<ReviewOutput>({
  key: 'code-reviewer',
  name: 'Code Reviewer',
  role: 'Reviews a change for correctness, edge cases and conformance to the chosen architecture.',
  context: ['story', 'architecture', 'code'],
  schema: Output,
  task: (input) =>
    [
      `Review the change for story ${String(input.vars.storyRef)}.`,
      'Judge it against the acceptance criteria and the chosen architecture, both in the context.',
      'Report what you did not examine rather than implying you examined everything.',
    ].join('\n'),
  checks,
  summary: (output) =>
    `${output.verdict} — ${output.findings.length} finding(s). ${output.summary}`,
});

export const securityReviewer = defineAgent<ReviewOutput>({
  key: 'security-reviewer',
  name: 'Security Reviewer',
  role: 'Reviews a change for security defects only.',
  context: ['story', 'architecture', 'code'],
  schema: Output,
  task: (input) =>
    [
      `Review the change for story ${String(input.vars.storyRef)} for security defects only.`,
      'Injection, authentication and authorisation gaps, secrets in code, unsafe deserialisation,',
      'missing validation on untrusted input, information disclosure in errors and logs.',
      'Do not report style, naming or performance — another reviewer covers those.',
    ].join('\n'),
  checks,
  summary: (output) =>
    `${output.verdict} — ${output.findings.length} security finding(s). ${output.summary}`,
});
