/**
 * QA activities — test execution, evidence capture and the bounded bug-fix loop bookkeeping.
 *
 * Playwright runs on the `sdlc-heavy` queue with a hard wall-clock cap, and every result carries
 * evidence: a QA failure nobody can inspect is not actionable.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FailureCode, PlatformError, type InvocationContext } from '@sdlc/shared';
import { getLogger } from '@sdlc/observability';
import type { ActivityDeps } from './context.js';
import { recordEvent } from './approval-activities.js';

const log = getLogger({ component: 'qa-activity' });

export interface TestOutcome {
  testCaseRef: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
  durationMs: number;
  failureMessage?: string;
  evidence: { kind: string; path: string }[];
}

export function qaActivities(deps: ActivityDeps) {
  const prisma = deps.prisma;

  function systemContext(projectId: string, agentRunId: string): InvocationContext {
    return {
      projectId,
      agentKey: 'qa',
      agentRunId,
      grants: deps.grants.filter((grant) => grant.agentKey === 'qa'),
      callCounts: {},
    };
  }

  return {
    /**
     * Execute the automated suite through the configured testing MCP server, capturing evidence
     * per case. Failures are results, not errors — the workflow decides what to do with them.
     */
    async runTests(input: {
      projectId: string;
      storyRef: string;
      agentRunId: string;
      baseUrl?: string;
      prId?: string;
      commitSha?: string;
    }): Promise<{ runId: string; passed: number; failed: number; outcomes: TestOutcome[] }> {
      const story = await prisma.story.findUnique({
        where: { projectId_ref: { projectId: input.projectId, ref: input.storyRef } },
        include: { testCases: true },
      });
      if (!story) {
        throw new PlatformError({
          code: FailureCode.NOT_FOUND,
          message: `story ${input.storyRef} not found`,
        });
      }

      const run = await prisma.testRun.create({
        data: {
          projectId: input.projectId,
          ...(input.prId ? { prId: input.prId } : {}),
          trigger: 'STORY_QA',
          ...(input.commitSha ? { commitSha: input.commitSha } : {}),
          environment: 'local',
          status: 'RUNNING',
        },
      });

      const context = systemContext(input.projectId, input.agentRunId);
      const evidenceRoot = resolve(
        process.env.ARTIFACT_STORAGE ?? './.artifacts',
        input.projectId,
        run.id,
      );
      await mkdir(evidenceRoot, { recursive: true });

      const outcomes: TestOutcome[] = [];

      await deps.mcp.callTool(context, 'playwright', 'open_browser', { headless: true });
      if (input.baseUrl) {
        await deps.mcp.callTool(context, 'playwright', 'navigate', { url: input.baseUrl });
      }

      for (const testCase of story.testCases) {
        const started = Date.now();
        try {
          const assertion = await deps.mcp.callTool(context, 'playwright', 'assert', {
            testCaseRef: testCase.ref,
            selector: 'body',
            expected: testCase.expectedResult,
          });
          const verdict = assertion.content as { status?: string; failureMessage?: string };

          const shot = await deps.mcp.callTool(context, 'playwright', 'screenshot', {
            name: `${testCase.ref}`,
          });
          const shotPath = join(evidenceRoot, `${testCase.ref}.png.json`);
          await writeFile(shotPath, JSON.stringify(shot.content), 'utf8');

          outcomes.push({
            testCaseRef: testCase.ref,
            status: verdict.status === 'FAIL' ? 'FAIL' : 'PASS',
            durationMs: Date.now() - started,
            ...(verdict.failureMessage ? { failureMessage: verdict.failureMessage } : {}),
            evidence: [{ kind: 'SCREENSHOT', path: shotPath }],
          });
        } catch (error) {
          outcomes.push({
            testCaseRef: testCase.ref,
            status: 'ERROR',
            durationMs: Date.now() - started,
            failureMessage: (error as Error).message,
            evidence: [],
          });
        }
      }

      // Console and network logs are captured once per run, not per case.
      const consoleLogs = await deps.mcp.callTool(context, 'playwright', 'get_console_logs', {});
      const consolePath = join(evidenceRoot, 'console.json');
      await writeFile(consolePath, JSON.stringify(consoleLogs.content, null, 2), 'utf8');
      await deps.mcp.callTool(context, 'playwright', 'close', {});

      for (const outcome of outcomes) {
        const testCase = story.testCases.find((t) => t.ref === outcome.testCaseRef);
        if (!testCase) continue;

        const result = await prisma.testResult.upsert({
          where: { runId_testCaseId: { runId: run.id, testCaseId: testCase.id } },
          create: {
            runId: run.id,
            testCaseId: testCase.id,
            status: outcome.status,
            durationMs: outcome.durationMs,
            ...(outcome.failureMessage ? { failureMessage: outcome.failureMessage } : {}),
          },
          update: { status: outcome.status, durationMs: outcome.durationMs },
        });

        for (const evidence of [...outcome.evidence, { kind: 'CONSOLE_LOG', path: consolePath }]) {
          await prisma.testEvidence.create({
            data: {
              resultId: result.id,
              kind: evidence.kind as 'SCREENSHOT',
              storagePath: evidence.path,
            },
          });
        }
      }

      const passed = outcomes.filter((o) => o.status === 'PASS').length;
      const failed = outcomes.filter((o) => o.status === 'FAIL' || o.status === 'ERROR').length;

      await prisma.testRun.update({
        where: { id: run.id },
        data: {
          status: failed > 0 ? 'FAILED' : 'PASSED',
          finishedAt: new Date(),
          summary: { total: outcomes.length, passed, failed } as object,
        },
      });

      await recordEvent(prisma, deps, {
        projectId: input.projectId,
        type: 'TEST_RUN_COMPLETED',
        payload: { runId: run.id, storyRef: input.storyRef, passed, failed },
        actor: 'agent:qa',
      });

      log.info({ storyRef: input.storyRef, passed, failed }, 'test run complete');
      return { runId: run.id, passed, failed, outcomes };
    },

    /** Coverage gate: every acceptance criterion must have at least one test case. */
    async assertCriteriaCovered(input: {
      projectId: string;
      storyRef: string;
    }): Promise<{ covered: string[]; uncovered: string[] }> {
      const story = await prisma.story.findUnique({
        where: { projectId_ref: { projectId: input.projectId, ref: input.storyRef } },
        include: { acceptanceCriteria: true, testCases: true },
      });
      if (!story) return { covered: [], uncovered: [] };

      const coveredIds = new Set(
        story.testCases.map((t) => t.acceptanceCriterionId).filter((id): id is string => Boolean(id)),
      );

      const covered = story.acceptanceCriteria.filter((c) => coveredIds.has(c.id)).map((c) => c.ref);
      const uncovered = story.acceptanceCriteria.filter((c) => !coveredIds.has(c.id)).map((c) => c.ref);
      return { covered, uncovered };
    },

    async recordQaFixIteration(input: {
      storyId: string;
      iteration: number;
      bugRefs: string[];
      outcome?: string;
    }): Promise<void> {
      await prisma.qaFixIteration.upsert({
        where: { storyId_iteration: { storyId: input.storyId, iteration: input.iteration } },
        create: {
          storyId: input.storyId,
          iteration: input.iteration,
          bugRefs: input.bugRefs,
          ...(input.outcome ? { outcome: input.outcome } : {}),
        },
        update: { ...(input.outcome ? { outcome: input.outcome } : {}) },
      });
    },

    async markBugsFixed(projectId: string, bugRefs: string[], fixPrId?: string): Promise<void> {
      await prisma.bug.updateMany({
        where: { projectId, ref: { in: bugRefs } },
        data: { status: 'FIXED', ...(fixPrId ? { fixPrId } : {}) },
      });
      await recordEvent(prisma, deps, {
        projectId,
        type: 'BUG_FIXED',
        payload: { bugRefs },
        actor: 'agent:developer',
      });
    },

    async getOpenBugRefs(projectId: string, storyRef: string): Promise<string[]> {
      const story = await prisma.story.findUnique({
        where: { projectId_ref: { projectId, ref: storyRef } },
      });
      if (!story) return [];
      const bugs = await prisma.bug.findMany({
        where: { storyId: story.id, status: { in: ['OPEN', 'ANALYSING', 'FIXING'] } },
        select: { ref: true },
      });
      return bugs.map((b) => b.ref);
    },
  };
}
