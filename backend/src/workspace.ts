/**
 * The workspace — where code actually lands.
 *
 * Each project gets a directory the backend owns, initialised as a git repository. The developer
 * agent's file changes are applied here, committed on a branch per story, and diffed for the
 * reviewers and for the pull-request gate. Everything works with no GitHub credentials at all; a
 * token in Settings adds a real push and a real PR on top, and nothing below changes.
 *
 * Two guards are not negotiable, because the input is a language model's idea of a file path:
 * every write is resolved and checked to be inside the project directory, and a small set of paths
 * is refused outright however the change is spelled.
 */

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const ROOT = process.env.WORKSPACE_ROOT ?? '/workspace';

/** Refused however they are spelled — secrets, git internals and key material. */
const PROTECTED = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env($|\.)/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_rsa/,
  /(^|\/)\.ssh(\/|$)/,
];

export interface FileChange {
  path: string;
  action: 'CREATE' | 'MODIFY' | 'DELETE';
  content?: string;
}

export interface ApplyResult {
  written: string[];
  deleted: string[];
  /** Changes refused by the path guards, with the reason, so the run can report them honestly. */
  refused: { path: string; reason: string }[];
}

export function projectDir(projectKey: string): string {
  return join(ROOT, projectKey.toLowerCase());
}

/** Create the project's repository if it does not exist yet. Idempotent. */
export async function ensureRepo(projectKey: string): Promise<string> {
  const dir = projectDir(projectKey);
  await mkdir(dir, { recursive: true });

  try {
    await git(dir, ['rev-parse', '--git-dir']);
  } catch {
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.email', 'platform@ai-sdlc.local']);
    await git(dir, ['config', 'user.name', 'AI SDLC Platform']);
    await writeFile(join(dir, 'README.md'), `# ${projectKey}\n\nCreated by the AI SDLC platform.\n`);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', 'Initial commit']);
  }
  return dir;
}

/** Resolve a model-supplied path inside the project, or say why it will not be written. */
function safePath(dir: string, candidate: string): { ok: true; full: string } | { ok: false; reason: string } {
  const cleaned = candidate.replace(/^\.?[/\\]+/, '').trim();
  if (!cleaned) return { ok: false, reason: 'empty path' };
  if (PROTECTED.some((pattern) => pattern.test(cleaned))) {
    return { ok: false, reason: 'protected path (git internals, secrets or key material)' };
  }

  const full = resolve(dir, cleaned);
  const rel = relative(dir, full);
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    return { ok: false, reason: 'path escapes the project workspace' };
  }
  return { ok: true, full };
}

export async function applyChanges(projectKey: string, changes: FileChange[]): Promise<ApplyResult> {
  const dir = await ensureRepo(projectKey);
  const result: ApplyResult = { written: [], deleted: [], refused: [] };

  for (const change of changes) {
    const target = safePath(dir, change.path);
    if (!target.ok) {
      result.refused.push({ path: change.path, reason: target.reason });
      continue;
    }

    if (change.action === 'DELETE') {
      await rm(target.full, { force: true });
      result.deleted.push(change.path);
      continue;
    }

    await mkdir(dirname(target.full), { recursive: true });
    await writeFile(target.full, change.content ?? '');
    result.written.push(change.path);
  }
  return result;
}

/** Branch, commit everything, and return the diff against the branch point. */
export async function commitOnBranch(
  projectKey: string,
  branch: string,
  message: string,
): Promise<{ branch: string; diff: string; files: string[] }> {
  const dir = await ensureRepo(projectKey);
  const safe = branch.replace(/[^A-Za-z0-9._\/-]/g, '-').slice(0, 100) || 'work';

  // Start from the default branch so two stories do not stack on each other's changes.
  await git(dir, ['checkout', 'main']).catch(() => undefined);
  await git(dir, ['checkout', '-B', safe]);
  await git(dir, ['add', '-A']);

  const status = await git(dir, ['status', '--porcelain']);
  if (!status.trim()) return { branch: safe, diff: '', files: [] };

  await git(dir, ['commit', '-m', message || `Work on ${safe}`]);

  const diff = await git(dir, ['diff', 'main', safe, '--unified=3']);
  const names = await git(dir, ['diff', '--name-only', 'main', safe]);
  return { branch: safe, diff: diff.slice(0, 200_000), files: names.split('\n').filter(Boolean) };
}

/** Read a file back for a reviewer. Returns null rather than throwing on anything unreadable. */
export async function readWorkspaceFile(projectKey: string, path: string): Promise<string | null> {
  const dir = projectDir(projectKey);
  const target = safePath(dir, path);
  if (!target.ok) return null;
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(target.full, 'utf8');
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// ── GitHub ─────────────────────────────────────────────────────────────────

export interface GitHubConfig {
  token: string;
  repository: string;
  defaultBranch: string;
}

/**
 * Push the branch and open a pull request.
 *
 * Deliberately done by the platform rather than by an agent with a GitHub tool: the thing that
 * opens a PR should be the thing that cannot merge it, and keeping the token out of the tool layer
 * means no prompt can talk its way into using it.
 */
export async function pushAndOpenPr(
  projectKey: string,
  branch: string,
  title: string,
  body: string,
  config: GitHubConfig,
): Promise<{ number: number; url: string }> {
  const dir = projectDir(projectKey);
  const remote = `https://x-access-token:${config.token}@github.com/${config.repository}.git`;

  await git(dir, ['remote', 'remove', 'origin']).catch(() => undefined);
  await git(dir, ['remote', 'add', 'origin', remote]);
  await git(dir, ['push', '--force-with-lease', 'origin', branch]);

  const response = await fetch(`https://api.github.com/repos/${config.repository}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, body, head: branch, base: config.defaultBranch }),
  });

  if (!response.ok) {
    throw new Error(`GitHub refused the pull request (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }

  const created = (await response.json()) as { number: number; html_url: string };
  return { number: created.number, url: created.html_url };
}
