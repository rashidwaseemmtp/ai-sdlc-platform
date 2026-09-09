/**
 * The delivery half of the pipeline: development and QA.
 *
 * Both stages work **one story per tick**. The runner calls the stage, it picks up the next story
 * whose dependencies are satisfied, takes it as far as it goes, records the result and returns
 * CONTINUE. That keeps the unit of lost work to one story when something dies mid-run, and it makes
 * progress visible on the dashboard instead of one long silence.
 *
 * Each has a bounded loop inside it — the developer answering reviewers, the developer answering
 * QA — and when the last story is done the stage opens its gate exactly once.
 */

import { db, logEvent } from './db.js';
import { runAgent } from './run-agent.js';
import {
  gateState,
  openGate,
  setPhase,
  settle,
  type Stage,
  type StageContext,
} from './stage-kit.js';
import { applyChanges, commitOnBranch, pushAndOpenPr, type FileChange } from './workspace.js';
import type { DeveloperOutput } from './agents/developer.js';
import type { ReviewOutput } from './agents/reviewers.js';
import type { BugAnalyzerOutput, QaOutput } from './agents/qa.js';

/** Statuses that mean a dependency is far enough along for its dependents to start. */
const SATISFIED = ['IMPLEMENTED', 'TESTED', 'DONE'];

/**
 * The next story that can be worked on, or undefined when the stage is finished.
 *
 * Respects the `dependsOn` edges the analyst declared: a story whose blocker is still outstanding
 * waits, however high its priority. When everything left is blocked by something that will never
 * arrive, this returns undefined and the stage moves on rather than spinning.
 */
async function nextStory(projectId: string, status: string) {
  const stories = await db.story.findMany({ where: { projectId }, orderBy: { orderIndex: 'asc' } });
  const byRef = new Map(stories.map((story) => [story.ref, story]));

  for (const story of stories) {
    if (story.status !== status) continue;
    const blockers = ((story.dependsOn ?? []) as string[]).filter((ref) => {
      const blocker = byRef.get(ref);
      return blocker && !SATISFIED.includes(blocker.status);
    });
    if (blockers.length === 0) return story;
  }
  return undefined;
}

/** The strictest verdict wins: a security rejection is not softened by a code approval. */
function combine(reviews: ReviewOutput[]): 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT' {
  if (reviews.some((review) => review.verdict === 'REJECT')) return 'REJECT';
  if (reviews.some((review) => review.verdict === 'REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  return 'APPROVE';
}

function toFileChanges(output: DeveloperOutput): FileChange[] {
  return [
    ...output.changes.map((change) => ({
      path: change.path,
      action: change.action,
      ...(change.content !== undefined ? { content: change.content } : {}),
    })),
    // Tests are changes too, so one apply and one commit covers the whole story.
    ...output.tests.map((test) => ({ path: test.path, action: 'CREATE' as const, content: test.content })),
  ];
}

// ── Development ────────────────────────────────────────────────────────────

/**
 * Implement one story, then have it reviewed until the reviewers are satisfied or the fix budget
 * runs out. Whatever the outcome, the pull request row records every round — a change that ran out
 * of rounds still reaches the gate, clearly marked, rather than disappearing.
 */
export async function developOneStory(ctx: StageContext, projectKey: string, storyRef: string): Promise<void> {
  const { projectId } = ctx.run;
  const limit = ctx.settings.limits.prFixIterations;

  const built = await runAgent({
    agentKey: 'developer',
    projectId,
    phase: `${storyRef} implement`,
    vars: { storyRef, phase: 'implement' },
  });
  await ctx.spend(built.costUsd);

  let output = built.output as DeveloperOutput;
  let applied = await applyChanges(projectKey, toFileChanges(output));
  let commit = await commitOnBranch(projectKey, output.branchName, output.commitMessage);

  const story = await db.story.findUniqueOrThrow({
    where: { projectId_ref: { projectId, ref: storyRef } },
  });

  const pr = await db.pullRequest.upsert({
    where: { storyId: story.id },
    create: {
      projectId,
      storyId: story.id,
      branch: commit.branch,
      title: output.pullRequest.title,
      summary: output.pullRequest.summary,
      files: commit.files,
      diff: commit.diff,
      reviews: [],
    },
    update: {
      branch: commit.branch,
      title: output.pullRequest.title,
      summary: output.pullRequest.summary,
      files: commit.files,
      diff: commit.diff,
      reviews: [],
      fixRounds: 0,
    },
  });

  if (applied.refused.length) {
    await logEvent(projectId, 'CHANGES_REFUSED', { storyRef, refused: applied.refused });
  }

  // ── the review loop ──────────────────────────────────────────────────────
  const rounds: unknown[] = [];
  let verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT' = 'REQUEST_CHANGES';

  for (let round = 0; round <= limit; round += 1) {
    // Two reviewers over the same diff, independently. Neither sees the other's findings.
    const [code, security] = await Promise.all([
      runAgent({
        agentKey: 'code-reviewer',
        projectId,
        phase: `${storyRef} review-${round + 1}`,
        vars: { storyRef },
      }),
      runAgent({
        agentKey: 'security-reviewer',
        projectId,
        phase: `${storyRef} security-${round + 1}`,
        vars: { storyRef },
      }),
    ]);
    await ctx.spend(code.costUsd + security.costUsd);

    const reviews = [code.output as ReviewOutput, security.output as ReviewOutput];
    verdict = combine(reviews);
    rounds.push({
      round: round + 1,
      verdict,
      code: { verdict: reviews[0]!.verdict, summary: reviews[0]!.summary, findings: reviews[0]!.findings },
      security: { verdict: reviews[1]!.verdict, summary: reviews[1]!.summary, findings: reviews[1]!.findings },
    });

    await db.pullRequest.update({ where: { id: pr.id }, data: { reviews: rounds as object, fixRounds: round } });

    if (verdict === 'APPROVE' || round === limit) break;

    // Back to the developer with every finding both reviewers raised.
    const findings = reviews.flatMap((review) => review.findings);
    const fix = await runAgent({
      agentKey: 'developer',
      projectId,
      phase: `${storyRef} address-review-${round + 1}`,
      vars: { storyRef, phase: 'address-review', findings },
    });
    await ctx.spend(fix.costUsd);

    output = fix.output as DeveloperOutput;
    applied = await applyChanges(projectKey, toFileChanges(output));
    commit = await commitOnBranch(projectKey, pr.branch, output.commitMessage);
    await db.pullRequest.update({
      where: { id: pr.id },
      data: { files: commit.files, diff: commit.diff },
    });
  }

  await maybePush(ctx, projectKey, pr.id, commit.branch, output);

  await db.story.update({ where: { id: story.id }, data: { status: 'IMPLEMENTED' } });
  await logEvent(projectId, 'STORY_IMPLEMENTED', {
    storyRef,
    branch: commit.branch,
    files: commit.files.length,
    verdict,
  });
}

/**
 * Push the branch and open a real pull request, when a token says to.
 *
 * A failure here does not fail the story. The code exists, the reviews happened, and the gate can
 * still be decided from the diff the platform holds — so the failure is recorded and surfaced
 * rather than throwing away a completed implementation because GitHub was unreachable.
 */
async function maybePush(
  ctx: StageContext,
  projectKey: string,
  prId: string,
  branch: string,
  output: DeveloperOutput,
): Promise<void> {
  const github = ctx.settings.github;
  if (!github.push || !github.token || !github.repository) return;

  try {
    const created = await pushAndOpenPr(
      projectKey,
      branch,
      output.pullRequest.title,
      [
        output.pullRequest.summary,
        '',
        '## Implementation',
        output.pullRequest.implementationDetails,
        '',
        '## Acceptance criteria',
        ...output.pullRequest.acceptanceCriteriaCoverage.map(
          (entry) => `- [${entry.satisfied ? 'x' : ' '}] ${entry.criterion} — ${entry.satisfiedBy}`,
        ),
        ...(output.pullRequest.knownLimitations.length
          ? ['', '## Known limitations', ...output.pullRequest.knownLimitations.map((item) => `- ${item}`)]
          : []),
        '',
        '_Opened by the AI SDLC platform. A human decides whether it merges._',
      ].join('\n'),
      github,
    );
    await db.pullRequest.update({
      where: { id: prId },
      data: { status: 'OPEN', number: created.number, url: created.url },
    });
    await logEvent(ctx.run.projectId, 'PULL_REQUEST_OPENED', { number: created.number, url: created.url });
  } catch (error) {
    await db.pullRequest.update({ where: { id: prId }, data: { status: 'PUSH_FAILED' } });
    await logEvent(ctx.run.projectId, 'PULL_REQUEST_PUSH_FAILED', { error: (error as Error).message });
  }
}

export async function developmentSummary(projectId: string): Promise<{
  summary: string;
  context: Record<string, unknown>;
}> {
  const prs = await db.pullRequest.findMany({
    where: { projectId },
    include: { story: { select: { ref: true, title: true } } },
  });

  const outstanding = prs.filter((pr) => {
    const rounds = (pr.reviews ?? []) as { verdict?: string }[];
    return rounds.at(-1)?.verdict !== 'APPROVE';
  });

  return {
    summary:
      `${prs.length} change set(s) across ${prs.length} stor${prs.length === 1 ? 'y' : 'ies'}. ` +
      (outstanding.length
        ? `${outstanding.length} still carr${outstanding.length === 1 ? 'ies' : 'y'} unresolved reviewer findings.`
        : 'Every change set was approved by both reviewers.'),
    context: {
      pullRequests: prs.map((pr) => {
        const rounds = (pr.reviews ?? []) as { verdict?: string; code?: unknown; security?: unknown }[];
        const last = rounds.at(-1);
        return {
          storyRef: pr.story.ref,
          storyTitle: pr.story.title,
          branch: pr.branch,
          title: pr.title,
          files: (pr.files ?? []) as string[],
          verdict: last?.verdict ?? 'NOT_REVIEWED',
          rounds: rounds.length,
          url: pr.url,
          status: pr.status,
        };
      }),
    },
  };
}

// ── QA ─────────────────────────────────────────────────────────────────────

/**
 * Design the tests for one story, run them, and give the developer a bounded number of chances to
 * fix what failed. A case nobody could actually execute is recorded NOT_RUN — the one thing this
 * loop must never do is convert an untested case into a pass.
 */
export async function testOneStory(ctx: StageContext, projectKey: string, storyRef: string): Promise<void> {
  const { projectId } = ctx.run;
  const limit = ctx.settings.limits.qaFixIterations;

  const designed = await runAgent({
    agentKey: 'qa',
    projectId,
    phase: `${storyRef} design-tests`,
    vars: { storyRef, phase: 'design' },
  });
  await ctx.spend(designed.costUsd);

  for (let round = 0; round <= limit; round += 1) {
    const executed = await runAgent({
      agentKey: 'qa',
      projectId,
      phase: `${storyRef} execute-${round + 1}`,
      vars: { storyRef, phase: 'execute', round },
    });
    await ctx.spend(executed.costUsd);

    const report = executed.output as QaOutput;
    const failed = report.results.filter((result) => result.result === 'FAILED');
    if (failed.length === 0 || round === limit) {
      await logEvent(projectId, 'STORY_TESTED', { storyRef, verdict: report.verdict, failures: failed.length });
      break;
    }

    // Diagnose before fixing: a fix aimed at a symptom costs a whole round and teaches nobody.
    const diagnosis = await runAgent({
      agentKey: 'bug-analyzer',
      projectId,
      phase: `${storyRef} diagnose-${round + 1}`,
      vars: { storyRef },
    });
    await ctx.spend(diagnosis.costUsd);

    const bugs = (diagnosis.output as BugAnalyzerOutput).bugs;
    // A test defect is fixed by fixing the test, which is QA's job on the next design pass — the
    // developer is only sent the bugs that are actually in the code.
    const codeBugs = bugs.filter((bug) => !bug.isTestDefect);
    if (codeBugs.length === 0) break;

    const fix = await runAgent({
      agentKey: 'developer',
      projectId,
      phase: `${storyRef} fix-bugs-${round + 1}`,
      vars: { storyRef, phase: 'fix-bugs', bugs: codeBugs },
    });
    await ctx.spend(fix.costUsd);

    const output = fix.output as DeveloperOutput;
    await applyChanges(projectKey, toFileChanges(output));
    const commit = await commitOnBranch(projectKey, output.branchName, output.commitMessage);

    const story = await db.story.findUniqueOrThrow({
      where: { projectId_ref: { projectId, ref: storyRef } },
    });
    await db.pullRequest.updateMany({
      where: { storyId: story.id },
      data: { files: commit.files, diff: commit.diff },
    });
    await db.bug.updateMany({ where: { storyId: story.id, status: 'OPEN' }, data: { status: 'FIXED' } });
  }

  await db.story.update({
    where: { projectId_ref: { projectId, ref: storyRef } },
    data: { status: 'TESTED' },
  });
}

export async function qaSummary(projectId: string): Promise<{ summary: string; context: Record<string, unknown> }> {
  const cases = await db.testCase.findMany({
    where: { projectId },
    include: { story: { select: { ref: true } } },
  });
  const bugs = await db.bug.findMany({ where: { projectId }, include: { story: { select: { ref: true } } } });

  const passed = cases.filter((testCase) => testCase.result === 'PASSED').length;
  const failed = cases.filter((testCase) => testCase.result === 'FAILED').length;
  const notRun = cases.filter((testCase) => testCase.result === 'NOT_RUN').length;
  const open = bugs.filter((bug) => bug.status === 'OPEN');

  return {
    summary:
      `${cases.length} test case(s): ${passed} passed, ${failed} failed, ${notRun} not run. ` +
      `${open.length} bug(s) still open.` +
      (notRun > 0
        ? ' Cases marked "not run" were never executed — grant QA a browser or shell server on the MCP page if you want them actually run.'
        : ''),
    context: {
      totals: { total: cases.length, passed, failed, notRun },
      failures: cases
        .filter((testCase) => testCase.result === 'FAILED')
        .map((testCase) => ({
          ref: testCase.ref,
          storyRef: testCase.story.ref,
          title: testCase.title,
          evidence: testCase.evidence,
        })),
      bugs: bugs.map((bug) => ({
        ref: bug.ref,
        storyRef: bug.story.ref,
        title: bug.title,
        severity: bug.severity,
        status: bug.status,
        rootCause: bug.rootCause,
      })),
    },
  };
}

// ── The Development stage ──────────────────────────────────────────────────

export const development: Stage = {
  key: 'development',
  name: 'Development',
  async run(ctx) {
    const gate = await gateState(ctx.run.projectId, 'PULL_REQUEST');
    if (gate.kind === 'pending') return { status: 'AWAITING_APPROVAL' };
    if (gate.kind === 'expired') {
      return { status: 'PARKED', code: 'APPROVAL_TIMEOUT', reason: 'The pull-request gate expired unanswered.' };
    }

    if (gate.kind === 'decided') {
      const settled = await settle(ctx, gate, {
        rejectedCode: 'CHANGES_REJECTED',
        maxIterations: ctx.settings.limits.prFixIterations + 1,
        exhaustedReason: 'The change sets were sent back repeatedly without converging.',
      });
      if (settled.kind === 'parked') return { status: 'PARKED', ...settled };
      if (settled.kind === 'approved') {
        await setPhase(ctx.run.projectId, 'CODE_APPROVED');
        return { status: 'COMPLETED' };
      }

      // Changes requested at the gate: every story goes back to the developer.
      await db.story.updateMany({
        where: { projectId: ctx.run.projectId, status: 'IMPLEMENTED' },
        data: { status: 'PLANNED' },
      });
      await ctx.checkpoint({ iteration: ctx.run.iteration + 1 });
    }

    const project = await db.project.findUniqueOrThrow({ where: { id: ctx.run.projectId } });
    await setPhase(ctx.run.projectId, 'DEVELOPMENT');

    const story = await nextStory(ctx.run.projectId, 'PLANNED');
    if (story) {
      await developOneStory(ctx, project.key, story.ref);
      // One story per tick, so a crash costs one story rather than the whole backlog.
      return { status: 'CONTINUE' };
    }

    const implemented = await db.story.count({
      where: { projectId: ctx.run.projectId, status: 'IMPLEMENTED' },
    });
    if (implemented === 0) {
      return {
        status: 'PARKED',
        code: 'NOTHING_TO_BUILD',
        reason:
          'No story reached development. Approve the delivery plan first, or check the backlog for a ' +
          'dependency cycle that leaves every story blocked.',
      };
    }

    const { summary, context } = await developmentSummary(ctx.run.projectId);
    return openGate(ctx, {
      gate: 'PULL_REQUEST',
      title: `Code review — ${implemented} change set(s)`,
      summary,
      context,
    });
  },
};

// ── The QA stage ───────────────────────────────────────────────────────────

export const quality: Stage = {
  key: 'qa',
  name: 'QA',
  async run(ctx) {
    const gate = await gateState(ctx.run.projectId, 'QA');
    if (gate.kind === 'pending') return { status: 'AWAITING_APPROVAL' };
    if (gate.kind === 'expired') {
      return { status: 'PARKED', code: 'APPROVAL_TIMEOUT', reason: 'The QA gate expired unanswered.' };
    }

    if (gate.kind === 'decided') {
      const settled = await settle(ctx, gate, {
        rejectedCode: 'QA_REJECTED',
        maxIterations: ctx.settings.limits.qaFixIterations + 1,
        exhaustedReason: 'QA was re-run repeatedly without reaching an acceptable result.',
      });
      if (settled.kind === 'parked') return { status: 'PARKED', ...settled };
      if (settled.kind === 'approved') {
        await db.story.updateMany({
          where: { projectId: ctx.run.projectId, status: 'TESTED' },
          data: { status: 'DONE' },
        });
        await setPhase(ctx.run.projectId, 'RELEASE_READY');
        return { status: 'COMPLETED' };
      }

      await db.story.updateMany({
        where: { projectId: ctx.run.projectId, status: 'TESTED' },
        data: { status: 'IMPLEMENTED' },
      });
      await ctx.checkpoint({ iteration: ctx.run.iteration + 1 });
    }

    const project = await db.project.findUniqueOrThrow({ where: { id: ctx.run.projectId } });
    await setPhase(ctx.run.projectId, 'QA');

    const story = await nextStory(ctx.run.projectId, 'IMPLEMENTED');
    if (story) {
      await testOneStory(ctx, project.key, story.ref);
      return { status: 'CONTINUE' };
    }

    const tested = await db.story.count({ where: { projectId: ctx.run.projectId, status: 'TESTED' } });
    if (tested === 0) {
      return { status: 'PARKED', code: 'NOTHING_TO_TEST', reason: 'No implemented story reached QA.' };
    }

    const { summary, context } = await qaSummary(ctx.run.projectId);
    return openGate(ctx, {
      gate: 'QA',
      title: `QA sign-off — ${tested} stor${tested === 1 ? 'y' : 'ies'}`,
      summary,
      context,
    });
  },
};
