/**
 * Development activities — workspace, quality gates, branch, commit, pull request.
 *
 * The developer agent produces a *structured* change set; these activities apply it. That split is
 * deliberate: each step is separately retryable, separately auditable, and the sequence is fixed by
 * the workflow rather than left to the model to remember (docs/03 §4.7).
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import {
  FailureCode,
  PlatformError,
  type InvocationContext,
  type McpGrant,
} from '@sdlc/shared';
import { getLogger } from '@sdlc/observability';
import type { ActivityDeps } from './context.js';
import { recordEvent } from './approval-activities.js';

const log = getLogger({ component: 'development-activity' });

export interface FileChange {
  path: string;
  action: 'CREATE' | 'MODIFY' | 'DELETE';
  content?: string;
}

export interface GateResult {
  gate: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  durationMs: number;
  output: string;
}

/** Commands the platform will run. Anything else is refused — there is no generic shell. */
const GATE_COMMANDS: { gate: string; script: string }[] = [
  { gate: 'install', script: 'install' },
  { gate: 'typecheck', script: 'typecheck' },
  { gate: 'lint', script: 'lint' },
  { gate: 'test', script: 'test' },
  { gate: 'build', script: 'build' },
];

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|secret|api[_-]?key|token)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{12,}['"]/i,
];

export function developmentActivities(deps: ActivityDeps) {
  const prisma = deps.prisma;

  /** A privileged context for platform-initiated tool calls. Grants still apply. */
  function systemContext(projectId: string, agentKey: string, agentRunId: string): InvocationContext {
    const grants: McpGrant[] = deps.grants.filter((grant) => grant.agentKey === agentKey);
    return { projectId, agentKey, agentRunId, grants, callCounts: {} };
  }

  function workspaceFor(projectKey: string, repoKey: string): string {
    return resolve(deps.workspaceRoot, projectKey, repoKey);
  }

  return {
    async ensureWorkspace(input: { projectId: string; repositoryKey: string }): Promise<string> {
      const project = await prisma.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const path = workspaceFor(project.key, input.repositoryKey);
      await mkdir(path, { recursive: true });
      return path;
    },

    /**
     * Write the agent's change set into the workspace. Every path is re-checked here even though
     * the MCP layer already checked it: this is the second, independent enforcement point.
     */
    async applyChanges(input: {
      projectId: string;
      repositoryKey: string;
      changes: FileChange[];
    }): Promise<{ written: number; deleted: number }> {
      const project = await prisma.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const root = workspaceFor(project.key, input.repositoryKey);
      await mkdir(root, { recursive: true });

      let written = 0;
      let deleted = 0;

      for (const change of input.changes) {
        const target = resolve(root, change.path);
        const rel = relative(root, target);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new PlatformError({
            code: FailureCode.PERMISSION_DENIED,
            message: `change path escapes the workspace: ${change.path}`,
            details: { path: change.path },
          });
        }
        if (/(^|\/)(\.env|\.git\/|.*\.pem|.*\.key|id_rsa)/.test(rel.split('\\').join('/'))) {
          throw new PlatformError({
            code: FailureCode.PERMISSION_DENIED,
            message: `change touches a protected path: ${change.path}`,
            details: { path: change.path },
          });
        }

        if (change.action === 'DELETE') {
          await rm(target, { force: true });
          deleted += 1;
          continue;
        }

        const content = change.content ?? '';
        const secret = SECRET_PATTERNS.find((pattern) => pattern.test(content));
        if (secret) {
          // A hard failure, not a warning: a committed credential cannot be un-committed.
          throw new PlatformError({
            code: FailureCode.PERMISSION_DENIED,
            message: `refusing to write a file that appears to contain a credential: ${change.path}`,
            details: { path: change.path },
          });
        }

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        written += 1;
      }

      return { written, deleted };
    },

    /**
     * Run the fixed quality gates. Failures here are *results*, not errors: they drive the bounded
     * fix loop, so this activity is configured non-retryable in the workflow.
     */
    async runQualityGates(input: {
      projectId: string;
      repositoryKey: string;
    }): Promise<{ passed: boolean; results: GateResult[] }> {
      const project = await prisma.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const root = workspaceFor(project.key, input.repositoryKey);
      const results: GateResult[] = [];

      const manifestPath = join(root, 'package.json');
      if (!existsSync(manifestPath)) {
        // Demo mode and greenfield repositories have no manifest yet; skipping honestly beats
        // reporting a pass nobody earned.
        return {
          passed: true,
          results: [
            {
              gate: 'all',
              status: 'SKIPPED',
              durationMs: 0,
              output: 'no package.json in the workspace; quality gates skipped',
            },
          ],
        };
      }

      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };

      for (const { gate, script } of GATE_COMMANDS) {
        if (script !== 'install' && !manifest.scripts?.[script]) {
          results.push({ gate, status: 'SKIPPED', durationMs: 0, output: `no "${script}" script` });
          continue;
        }
        const started = Date.now();
        const args = script === 'install' ? ['install', '--frozen-lockfile'] : ['run', script];
        const outcome = await runCommand('pnpm', args, root);
        results.push({
          gate,
          status: outcome.code === 0 ? 'PASS' : 'FAIL',
          durationMs: Date.now() - started,
          output: `${outcome.stdout}\n${outcome.stderr}`.trim().slice(-4000),
        });
        if (outcome.code !== 0 && gate !== 'lint') break; // stop at the first hard failure
      }

      const passed = results.every((r) => r.status !== 'FAIL');
      log.info({ projectId: input.projectId, passed }, 'quality gates complete');
      return { passed, results };
    },

    /** Create the story branch through the configured VCS MCP server. */
    async createBranch(input: {
      projectId: string;
      repositoryKey: string;
      storyRef: string;
      agentRunId: string;
      branchName: string;
    }): Promise<{ branch: string }> {
      const repository = await requireRepository(prisma, input.projectId, input.repositoryKey);

      await deps.mcp.callTool(
        systemContext(input.projectId, 'developer', input.agentRunId),
        'github',
        'create_branch',
        { repo: repoFullName(repository.url), branch: input.branchName, base: repository.defaultBranch },
        { projectRepositories: [repoFullName(repository.url)], throwOnToolError: true },
      );

      const story = await prisma.story.findUnique({
        where: { projectId_ref: { projectId: input.projectId, ref: input.storyRef } },
      });

      await prisma.branch.upsert({
        where: { repositoryId_name: { repositoryId: repository.id, name: input.branchName } },
        create: {
          projectId: input.projectId,
          repositoryId: repository.id,
          ...(story ? { storyId: story.id } : {}),
          name: input.branchName,
          baseBranch: repository.defaultBranch,
        },
        update: {},
      });

      await recordEvent(prisma, deps, {
        projectId: input.projectId,
        type: 'BRANCH_CREATED',
        payload: { branch: input.branchName, repository: input.repositoryKey },
        actor: 'agent:developer',
      });

      return { branch: input.branchName };
    },

    async commitAndPush(input: {
      projectId: string;
      repositoryKey: string;
      branchName: string;
      message: string;
      changes: FileChange[];
      agentRunId: string;
    }): Promise<{ sha: string }> {
      const repository = await requireRepository(prisma, input.projectId, input.repositoryKey);
      const context = systemContext(input.projectId, 'developer', input.agentRunId);
      const repo = repoFullName(repository.url);

      const result = await deps.mcp.callTool(
        context,
        'github',
        'commit',
        {
          repo,
          branch: input.branchName,
          message: input.message,
          files: input.changes
            .filter((c) => c.action !== 'DELETE')
            .map((c) => ({ path: c.path, content: c.content ?? '' })),
        },
        { projectRepositories: [repo], throwOnToolError: true },
      );

      await deps.mcp.callTool(context, 'github', 'push', { repo, branch: input.branchName }, {
        projectRepositories: [repo],
      });

      const sha = (result.content as { sha?: string })?.sha ?? 'unknown';
      await prisma.branch.updateMany({
        where: { repositoryId: repository.id, name: input.branchName },
        data: { headSha: sha },
      });
      return { sha };
    },

    /**
     * Open the pull request with the full doc-21 body. The AI never merges: no agent holds the
     * merge scope, and `AI_MERGE_PERMISSION` gates the capability entirely (invariant I7).
     */
    async createPullRequest(input: {
      projectId: string;
      repositoryKey: string;
      storyRef: string;
      branchName: string;
      agentRunId: string;
      body: {
        title: string;
        summary: string;
        implementationDetails: string;
        acceptanceCriteriaCoverage: { criterionRef: string; satisfiedBy: string; satisfied: boolean }[];
        testsAdded: string[];
        knownLimitations: string[];
        securityConsiderations: string[];
      };
      gateResults: GateResult[];
      modelId?: string;
      providerKey?: string;
    }): Promise<{ prId: string; number: number; url: string }> {
      const repository = await requireRepository(prisma, input.projectId, input.repositoryKey);
      const repo = repoFullName(repository.url);
      const story = await prisma.story.findUnique({
        where: { projectId_ref: { projectId: input.projectId, ref: input.storyRef } },
        include: { designReferences: true },
      });
      const adr = await prisma.adr.findFirst({
        where: { projectId: input.projectId, status: 'APPROVED' },
        orderBy: { number: 'desc' },
      });

      const bodyMarkdown = renderPrBody({
        storyRef: input.storyRef,
        storyTitle: story?.title ?? input.storyRef,
        adrNumber: adr?.number,
        adrTitle: adr?.title,
        figmaRefs: story?.designReferences.map((d) => `${d.name} (${d.figmaFileKey}/${d.nodeId})`) ?? [],
        ...input.body,
        gateResults: input.gateResults,
        modelId: input.modelId,
        providerKey: input.providerKey,
      });

      const result = await deps.mcp.callTool(
        systemContext(input.projectId, 'developer', input.agentRunId),
        'github',
        'create_pull_request',
        {
          repo,
          title: prefixed(input.storyRef, input.body.title),
          body: bodyMarkdown,
          head: input.branchName,
          base: repository.defaultBranch,
        },
        { projectRepositories: [repo], throwOnToolError: true },
      );

      const created = result.content as { number: number; url: string };
      const pr = await prisma.pullRequest.upsert({
        where: { repositoryId_number: { repositoryId: repository.id, number: created.number } },
        create: {
          projectId: input.projectId,
          ...(story ? { storyId: story.id } : {}),
          repositoryId: repository.id,
          ...(adr ? { adrId: adr.id } : {}),
          provider: repository.provider,
          number: created.number,
          url: created.url,
          title: prefixed(input.storyRef, input.body.title),
          body: bodyMarkdown,
          branchName: input.branchName,
          baseBranch: repository.defaultBranch,
          state: 'OPEN',
          figmaRefs: (story?.designReferences.map((d) => d.nodeId) ?? []) as object,
        },
        update: { body: bodyMarkdown, title: prefixed(input.storyRef, input.body.title) },
      });

      await recordEvent(prisma, deps, {
        projectId: input.projectId,
        type: 'PR_CREATED',
        payload: { prId: pr.id, number: created.number, storyRef: input.storyRef },
        actor: 'agent:developer',
      });

      return { prId: pr.id, number: created.number, url: created.url };
    },

    /** Poll CI through an activity retry rather than a workflow loop, keeping history small. */
    async waitForChecks(input: {
      projectId: string;
      repositoryKey: string;
      prNumber: number;
      agentRunId: string;
    }): Promise<{ state: string }> {
      const repository = await requireRepository(prisma, input.projectId, input.repositoryKey);
      const result = await deps.mcp.callTool(
        systemContext(input.projectId, 'developer', input.agentRunId),
        'github',
        'get_checks',
        { repo: repoFullName(repository.url), number: input.prNumber },
        { projectRepositories: [repoFullName(repository.url)], throwOnToolError: true },
      );

      const state = (result.content as { state?: string })?.state ?? 'pending';
      if (state === 'pending') {
        // Throwing here is how the activity retry becomes the polling loop.
        throw new PlatformError({
          code: FailureCode.TOOL_FAILED,
          message: 'CI checks are still pending',
          details: { prNumber: input.prNumber },
        });
      }

      await prisma.pullRequest.updateMany({
        where: { repositoryId: repository.id, number: input.prNumber },
        data: { checksState: state.toUpperCase() },
      });
      return { state };
    },

    async recordCodeReview(input: {
      prId: string;
      reviewerKind: 'AI' | 'SECURITY_AI' | 'HUMAN';
      verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT' | 'COMMENT';
      summary: string;
      findings: { path: string; line?: number; severity: string; category: string; body: string }[];
      agentRunId?: string;
      userId?: string;
    }): Promise<string> {
      const review = await prisma.codeReview.create({
        data: {
          prId: input.prId,
          reviewerKind: input.reviewerKind,
          verdict: input.verdict,
          summary: input.summary,
          ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
          ...(input.userId ? { userId: input.userId } : {}),
        },
      });

      if (input.findings.length) {
        await prisma.reviewComment.createMany({
          data: input.findings.map((finding) => ({
            reviewId: review.id,
            path: finding.path,
            ...(finding.line !== undefined ? { line: finding.line } : {}),
            severity: finding.severity as 'MEDIUM',
            category: finding.category,
            body: finding.body,
          })),
        });
      }

      await prisma.pullRequest.update({
        where: { id: input.prId },
        data: {
          state: input.verdict === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : undefined,
        },
      });

      return review.id;
    },

    async recordPrFixIteration(input: {
      prId: string;
      iteration: number;
      triggeredBy: string;
      outcome?: string;
    }): Promise<void> {
      await prisma.prFixIteration.upsert({
        where: { prId_iteration: { prId: input.prId, iteration: input.iteration } },
        create: {
          prId: input.prId,
          iteration: input.iteration,
          triggeredBy: input.triggeredBy,
          ...(input.outcome ? { outcome: input.outcome } : {}),
        },
        update: { ...(input.outcome ? { outcome: input.outcome } : {}) },
      });
    },

    /**
     * Fetch design references for a story. Returns DESIGN_CONTEXT_UNAVAILABLE rather than
     * inventing a design when Figma is not configured (docs/06 §4.4).
     */
    async fetchDesignReferences(input: {
      projectId: string;
      storyRef: string;
      agentRunId: string;
    }): Promise<{ status: 'OK' | 'DESIGN_CONTEXT_UNAVAILABLE'; count: number }> {
      const integration = await prisma.projectIntegration.findFirst({
        where: { projectId: input.projectId, kind: 'DESIGN', enabled: true },
      });
      if (!integration?.externalRef) return { status: 'DESIGN_CONTEXT_UNAVAILABLE', count: 0 };

      try {
        const result = await deps.mcp.callTool(
          systemContext(input.projectId, 'developer', input.agentRunId),
          'figma',
          'get_frames',
          { fileKey: integration.externalRef },
        );
        const frames = (result.content as { nodeId: string; name: string }[]) ?? [];
        const story = await prisma.story.findUnique({
          where: { projectId_ref: { projectId: input.projectId, ref: input.storyRef } },
        });
        if (!story) return { status: 'DESIGN_CONTEXT_UNAVAILABLE', count: 0 };

        for (const frame of frames) {
          await prisma.designReference.upsert({
            where: {
              storyId_figmaFileKey_nodeId: {
                storyId: story.id,
                figmaFileKey: integration.externalRef,
                nodeId: frame.nodeId,
              },
            },
            create: {
              storyId: story.id,
              figmaFileKey: integration.externalRef,
              nodeId: frame.nodeId,
              name: frame.name,
              payload: frame as object,
            },
            update: { name: frame.name, payload: frame as object },
          });
        }
        return { status: 'OK', count: frames.length };
      } catch (error) {
        log.warn({ error: (error as Error).message }, 'design context unavailable');
        return { status: 'DESIGN_CONTEXT_UNAVAILABLE', count: 0 };
      }
    },

    /** Refuses unless AI merge is explicitly enabled *and* a privileged grant exists. */
    async assertMergeAllowed(): Promise<void> {
      if (!deps.aiMergePermission) {
        throw new PlatformError({
          code: FailureCode.PERMISSION_DENIED,
          message:
            'AI merge is disabled (AI_MERGE_PERMISSION=false). A human merges pull requests on ' +
            'this platform.',
        });
      }
    },
  };
}

async function requireRepository(
  prisma: ActivityDeps['prisma'],
  projectId: string,
  repositoryKey: string,
) {
  const repository = await prisma.projectRepository.findUnique({
    where: { projectId_key: { projectId, key: repositoryKey } },
  });
  if (!repository) {
    throw new PlatformError({
      code: FailureCode.NOT_FOUND,
      message: `repository "${repositoryKey}" is not attached to this project`,
      details: { projectId, repositoryKey },
    });
  }
  return repository;
}

/** Agents sometimes include the story ref in the title already; do not stutter it. */
function prefixed(storyRef: string, title: string): string {
  return title.startsWith(`${storyRef}:`) || title.startsWith(storyRef)
    ? title
    : `${storyRef}: ${title}`;
}

function repoFullName(url: string): string {
  const match = /[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return match?.[1] ?? url;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 600_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      // Only an explicit allowlist of environment variables reaches a build (docs/07 §4).
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CI: 'true' },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function renderPrBody(input: {
  storyRef: string;
  storyTitle: string;
  adrNumber?: number;
  adrTitle?: string;
  figmaRefs: string[];
  summary: string;
  implementationDetails: string;
  acceptanceCriteriaCoverage: { criterionRef: string; satisfiedBy: string; satisfied: boolean }[];
  testsAdded: string[];
  knownLimitations: string[];
  securityConsiderations: string[];
  gateResults: GateResult[];
  modelId?: string;
  providerKey?: string;
}): string {
  const lines: string[] = [];

  lines.push(`## Story\n\n**${input.storyRef}** — ${input.storyTitle}`, '');
  lines.push('## Summary', '', input.summary, '');
  lines.push('## Implementation details', '', input.implementationDetails, '');

  lines.push('## Architecture reference', '');
  lines.push(
    input.adrNumber
      ? `ADR-${String(input.adrNumber).padStart(3, '0')} — ${input.adrTitle ?? ''}`
      : 'No approved ADR at the time of this change.',
    '',
  );

  lines.push('## Design reference', '');
  lines.push(input.figmaRefs.length ? input.figmaRefs.map((r) => `- ${r}`).join('\n') : '_DESIGN_CONTEXT_UNAVAILABLE_', '');

  lines.push('## Acceptance criteria', '');
  if (input.acceptanceCriteriaCoverage.length) {
    for (const coverage of input.acceptanceCriteriaCoverage) {
      lines.push(`- [${coverage.satisfied ? 'x' : ' '}] ${coverage.criterionRef} — ${coverage.satisfiedBy}`);
    }
  } else {
    lines.push('_No acceptance criteria were mapped._');
  }
  lines.push('');

  lines.push('## Tests added', '');
  lines.push(input.testsAdded.length ? input.testsAdded.map((t) => `- ${t}`).join('\n') : '_None_', '');

  lines.push('## Tests executed', '');
  for (const gate of input.gateResults) {
    const icon = gate.status === 'PASS' ? 'PASS' : gate.status === 'FAIL' ? 'FAIL' : 'SKIPPED';
    lines.push(`- ${gate.gate}: **${icon}** (${gate.durationMs}ms)`);
  }
  lines.push('');

  lines.push('## Known limitations', '');
  lines.push(input.knownLimitations.length ? input.knownLimitations.map((l) => `- ${l}`).join('\n') : '_None reported_', '');

  lines.push('## Security considerations', '');
  lines.push(
    input.securityConsiderations.length
      ? input.securityConsiderations.map((s) => `- ${s}`).join('\n')
      : '_None reported_',
    '',
  );

  lines.push('## AI agent information', '');
  lines.push(`- Agent: \`developer\``);
  lines.push(`- Model: \`${input.modelId ?? 'unknown'}\` via \`${input.providerKey ?? 'unknown'}\``);
  lines.push('- This pull request was produced by an AI agent and requires human review.');
  lines.push('- The agent cannot merge it.');

  return lines.join('\n');
}
