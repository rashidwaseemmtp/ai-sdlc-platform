/**
 * Developer — implements one story.
 *
 * The only agent that may write code, and it may not merge. That is enforced in three independent
 * places: the MCP deny list refuses any tool whose name looks like a merge or a force-push, the
 * platform (not the agent) is what opens a pull request, and the GitHub token never reaches the
 * tool layer at all.
 *
 * It returns a change set rather than writing files itself. The platform applies it, which is what
 * makes the path guards, the diff and the audit trail possible — and means a refused path is
 * reported rather than silently landing somewhere unexpected.
 */

import { z } from 'zod';
import { DecisionSummary, defineAgent, fail, pass, renderChangeRequests } from './types.js';

const FileChange = z.object({
  /** Repository-relative. Anything escaping the workspace is refused by the platform. */
  path: z.string().min(1),
  action: z.enum(['CREATE', 'MODIFY', 'DELETE']),
  /** The complete file after the change — not a patch. Omitted only for DELETE. */
  content: z.string().optional(),
  rationale: z.string(),
});

const Output = z.object({
  plan: z.array(z.object({ step: z.string(), rationale: z.string() })).min(1),
  changes: z.array(FileChange).min(1),
  tests: z
    .array(z.object({ path: z.string(), covers: z.array(z.string()), content: z.string() }))
    .default([]),
  branchName: z.string().min(1),
  commitMessage: z.string().min(1),
  pullRequest: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    implementationDetails: z.string(),
    acceptanceCriteriaCoverage: z
      .array(z.object({ criterion: z.string(), satisfiedBy: z.string(), satisfied: z.boolean() }))
      .default([]),
    knownLimitations: z.array(z.string()).default([]),
  }),
  /** Criteria this change does not satisfy, said out loud rather than left to the reviewer. */
  unsatisfiedCriteria: z.array(z.object({ criterion: z.string(), reason: z.string() })).default([]),
  decisionSummary: DecisionSummary,
});

export type DeveloperOutput = z.infer<typeof Output>;

/** Patterns that mean a credential has been written into the diff. */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|secret|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
];

export const developer = defineAgent<DeveloperOutput>({
  key: 'developer',
  name: 'Developer',
  role: 'Implements one story against the chosen architecture and proposes a pull request.',
  context: ['story', 'architecture', 'code'],
  schema: Output,

  task: (input) => {
    const phase = String(input.vars.phase ?? 'implement');
    const lines = [`Story: ${String(input.vars.storyRef)}`];

    if (phase === 'address-review') {
      lines.push(
        'A reviewer found problems with your previous change. The diff and the findings are in the',
        'context. Return the complete change set again, with those findings addressed — not a patch',
        'on top, the whole set of files as they should now be.',
        '',
        'Reviewer findings:',
        JSON.stringify(input.vars.findings ?? [], null, 2),
      );
    } else if (phase === 'fix-bugs') {
      lines.push(
        'QA found defects in your implementation. Fix the root causes described below and return the',
        'complete change set again.',
        '',
        'Bugs:',
        JSON.stringify(input.vars.bugs ?? [], null, 2),
      );
    } else {
      lines.push(
        'Implement this story completely: source files and the tests that prove them.',
        'Every file you return must be its full content after the change, not a diff.',
      );
    }

    lines.push(renderChangeRequests(input));
    return lines.join('\n');
  },

  checks: [
    {
      code: 'NO_SECRETS_IN_DIFF',
      severity: 'HARD',
      description: 'no credentials in the produced changes',
      run: (output) => {
        const offenders = output.changes
          .filter((change) => change.content && SECRET_PATTERNS.some((pattern) => pattern.test(change.content!)))
          .map((change) => change.path);
        return offenders.length ? fail(`possible secret in: ${offenders.join(', ')}`) : pass();
      },
    },
    {
      code: 'NO_PROTECTED_PATHS',
      severity: 'HARD',
      description: 'the change does not touch git internals, env files or key material',
      run: (output) => {
        const guard = /(^|\/)(\.git|\.env|\.ssh)(\/|$)|\.(pem|key)$|(^|\/)id_rsa/;
        const offenders = output.changes.filter((change) => guard.test(change.path)).map((c) => c.path);
        return offenders.length ? fail(`change touches protected paths: ${offenders.join(', ')}`) : pass();
      },
    },
    {
      code: 'CONTENT_PRESENT',
      severity: 'HARD',
      description: 'every created or modified file carries its content',
      run: (output) => {
        const empty = output.changes
          .filter((change) => change.action !== 'DELETE' && change.content === undefined)
          .map((change) => change.path);
        return empty.length ? fail(`no content supplied for: ${empty.join(', ')}`) : pass();
      },
    },
    {
      code: 'CRITERIA_ACCOUNTED_FOR',
      severity: 'SOFT',
      description: 'criteria marked unsatisfied are also reported as such',
      run: (output) => {
        const declared = new Set(output.unsatisfiedCriteria.map((entry) => entry.criterion));
        const silent = output.pullRequest.acceptanceCriteriaCoverage
          .filter((entry) => !entry.satisfied && !declared.has(entry.criterion))
          .map((entry) => entry.criterion);
        return silent.length
          ? fail(`criteria marked unsatisfied but not explained: ${silent.join(', ')}`)
          : pass();
      },
    },
    {
      code: 'TESTS_ACCOMPANY_CODE',
      severity: 'SOFT',
      description: 'implementation changes are accompanied by tests',
      run: (output) => {
        const code = output.changes.filter(
          (change) =>
            change.action !== 'DELETE' &&
            !/\.(md|json|ya?ml|txt)$/.test(change.path) &&
            !/test|spec/.test(change.path),
        );
        return code.length > 0 && output.tests.length === 0 ? fail('code changed with no tests added') : pass();
      },
    },
  ],

  // Nothing is persisted here: the development stage applies the change set to the workspace,
  // commits it and records the pull request, because those are side effects the platform owns.

  summary: (output) =>
    `${output.changes.length} file(s), ${output.tests.length} test file(s) on ${output.branchName}. ` +
    output.decisionSummary.summary,
});
