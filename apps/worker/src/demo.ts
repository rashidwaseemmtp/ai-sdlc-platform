/**
 * Demo runner — drives the whole pipeline end to end with no credentials.
 *
 * It starts `ProjectWorkflow` and then plays the human: polling for pending approvals and
 * signalling a decision. That is deliberately the *same* path the dashboard uses (write the
 * decision, then signal the workflow), so this exercises the real approval mechanism rather than a
 * shortcut around it.
 *
 * Usage:
 *   pnpm demo                 approve everything
 *   pnpm demo --changes 1     request changes once at the backlog gate, then approve
 */

import 'dotenv/config';
import { Client, Connection } from '@temporalio/client';
import { getPrisma, disconnectPrisma } from '@sdlc/database';
import { loadEnv } from '@sdlc/shared/node';
import { getLogger } from '@sdlc/observability';

const log = getLogger({ component: 'demo' });
const prisma = getPrisma();

const args = process.argv.slice(2);
const changeRequestRounds = Number(args[args.indexOf('--changes') + 1] ?? 0) || 0;
const projectKey = args.includes('--project') ? args[args.indexOf('--project') + 1]! : 'CMS';

async function main(): Promise<void> {
  const env = loadEnv();
  const project = await prisma.project.findUniqueOrThrow({ where: { key: projectKey } });
  const approver = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });

  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });

  const workflowId = `project-${project.key}`;
  log.info({ workflowId }, 'starting ProjectWorkflow');

  const handle = await client.workflow.start('ProjectWorkflow', {
    taskQueue: env.TEMPORAL_TASK_QUEUE_MAIN,
    workflowId,
    workflowIdReusePolicy: 'ALLOW_DUPLICATE' as never,
    args: [
      {
        projectId: project.id,
        projectKey: project.key,
        repositoryKey: 'api',
        limits: {
          maxBacklogRevisions: env.MAX_BACKLOG_REVISIONS,
          maxArchitectureRounds: env.MAX_ARCHITECTURE_ROUNDS,
          maxPrFixIterations: env.MAX_PR_FIX_ITERATIONS,
          maxQaFixIterations: env.MAX_QA_FIX_ITERATIONS,
          maxBuildFixIterations: env.MAX_BUILD_FIX_ITERATIONS,
          maxParallelStories: env.MAX_PARALLEL_STORIES,
          maxWorkflowCostUsd: env.MAX_WORKFLOW_COST_USD,
          estimationVarianceThreshold: env.ESTIMATION_VARIANCE_THRESHOLD,
          // Short timeout so an unanswered gate fails the demo fast instead of hanging.
          approvalDefaultTimeoutHours: 1,
        },
      },
    ],
  });

  let changesRequested = 0;
  const seen = new Set<string>();
  const deadline = Date.now() + 10 * 60_000;

  // The dashboard does exactly this: write the decision, then signal. Polling here stands in for a
  // human noticing the approval in their inbox.
  while (Date.now() < deadline) {
    const pending = await prisma.approvalRequest.findMany({
      where: { projectId: project.id, status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
    });

    for (const request of pending) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);

      const isIntervention = (request.context as { intervention?: boolean })?.intervention === true;
      if (isIntervention) {
        log.warn({ requestId: request.id, title: request.title }, 'intervention required — retrying');
        await prisma.approvalRequest.update({
          where: { id: request.id },
          data: { status: 'APPROVED', resolvedAt: new Date() },
        });
        await client.workflow
          .getHandle(request.workflowId)
          .signal('intervention', { requestId: request.id, action: 'RETRY', userId: approver.id });
        continue;
      }

      const wantsChanges = request.gateKey === 'BACKLOG' && changesRequested < changeRequestRounds;
      const decision = wantsChanges ? 'CHANGES_REQUESTED' : 'APPROVED';
      if (wantsChanges) changesRequested += 1;

      log.info({ gate: request.gateKey, decision, title: request.title }, 'deciding');

      await prisma.approvalDecision.create({
        data: {
          requestId: request.id,
          userId: approver.id,
          decision,
          comment: wantsChanges
            ? 'Demo: requesting one revision to exercise the loop.'
            : 'Demo: approved.',
          changeRequests: wantsChanges
            ? ([
                {
                  target: { kind: 'story', ref: 'US-101' },
                  instruction: 'Add an explicit edge case for a customer that is already inactive.',
                  severity: 'SHOULD',
                },
              ] as object)
            : ([] as object),
        },
      });

      await client.workflow.getHandle(request.workflowId).signal('approval', {
        gate: request.gateKey,
        requestId: request.id,
        decision,
        userId: approver.id,
        changeRequests: wantsChanges
          ? [
              {
                target: { kind: 'story', ref: 'US-101' },
                instruction: 'Add an explicit edge case for a customer that is already inactive.',
                severity: 'SHOULD',
              },
            ]
          : [],
      });
    }

    const description = await handle.describe();
    if (description.status.name !== 'RUNNING') break;

    await new Promise((r) => setTimeout(r, 1000));
  }

  const result = await handle.result().catch((error: unknown) => ({ error: (error as Error).message }));
  log.info({ result }, 'ProjectWorkflow finished');

  await report(project.id);
  await connection.close();
}

async function report(projectId: string): Promise<void> {
  const [project, requirements, stories, options, adrs, estimates, prs, testCases, results, bugs, runs] =
    await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
      prisma.requirement.count({ where: { projectId } }),
      prisma.story.count({ where: { projectId } }),
      prisma.architectureOption.count({ where: { projectId } }),
      prisma.adr.count({ where: { projectId } }),
      prisma.estimate.count({ where: { projectId } }),
      prisma.pullRequest.count({ where: { projectId } }),
      prisma.testCase.count({ where: { projectId } }),
      prisma.testResult.count({ where: { testCase: { projectId } } }),
      prisma.bug.count({ where: { projectId } }),
      prisma.agentRun.findMany({
        where: { projectId },
        select: { agentKey: true, status: true, totalCostUsd: true, durationMs: true },
      }),
    ]);

  const byAgent = new Map<string, { runs: number; cost: number; ms: number; failed: number }>();
  for (const run of runs) {
    const entry = byAgent.get(run.agentKey) ?? { runs: 0, cost: 0, ms: 0, failed: 0 };
    entry.runs += 1;
    entry.cost += run.totalCostUsd;
    entry.ms += run.durationMs ?? 0;
    if (run.status !== 'SUCCEEDED') entry.failed += 1;
    byAgent.set(run.agentKey, entry);
  }

  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log(`  ${project.name} (${project.key}) — phase ${project.phase}`);
  console.log(line);
  console.log(`  requirements ${requirements}   stories ${stories}   arch options ${options}   ADRs ${adrs}`);
  console.log(`  estimates ${estimates}   pull requests ${prs}`);
  console.log(`  test cases ${testCases}   results ${results}   bugs ${bugs}`);
  console.log(line);
  console.log('  agent                 runs   failed        cost       time');
  for (const [agentKey, entry] of [...byAgent.entries()].sort()) {
    console.log(
      `  ${agentKey.padEnd(20)} ${String(entry.runs).padStart(4)} ${String(entry.failed).padStart(8)}` +
        `   ${`$${entry.cost.toFixed(4)}`.padStart(9)}  ${`${(entry.ms / 1000).toFixed(1)}s`.padStart(9)}`,
    );
  }
  console.log(line);
  console.log(
    `  total ${runs.length} agent runs, $${runs.reduce((s, r) => s + r.totalCostUsd, 0).toFixed(4)} ` +
      '(mock provider — real cost is zero)',
  );
  console.log(`${line}\n`);
}

main()
  .catch((error: unknown) => {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'demo failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
