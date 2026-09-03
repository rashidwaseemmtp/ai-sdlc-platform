/**
 * Workspace-backed context sections — docs/09 §4.
 *
 * "Relevant code" is computed, not guessed: seed from the story, expand by imports, add the diff,
 * then fall back to search. Repository conventions are always priority 1, because that is how an
 * agent writes code that matches the surrounding style instead of its own.
 *
 * These live behind the same `SectionResolver` interface as the SQL sections, so the engine does
 * not care where a section comes from — and a project with no checkout degrades to "no code
 * context" rather than failing.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { SectionResolver } from './context-engine.js';

export interface WorkspaceResolverOptions {
  workspaceRoot: string;
  /** Resolves a projectId to its directory name (the project key). */
  projectDir(projectId: string): Promise<string>;
  /** Repositories attached to a project, most relevant first. */
  repositories(projectId: string): Promise<{ key: string; role: string }[]>;
  /**
   * Reads an artifact version's content. The diff section uses this to recover the developer's
   * change set from the pinned input ref, so the change set never has to travel through workflow
   * history as a payload (invariant I4).
   */
  readArtifact?(versionId: string): Promise<unknown>;
  maxFileBytes?: number;
}

const CONVENTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.editorconfig',
  'eslint.config.js',
  '.eslintrc.json',
  'tsconfig.json',
  'package.json',
];

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rb|java|kt|cs|php|rs|sql|prisma)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|spec)(\/|$)|\.(test|spec)\.[a-z]+$/i;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);

export function workspaceResolvers(options: WorkspaceResolverOptions): Record<string, SectionResolver> {
  const maxBytes = options.maxFileBytes ?? 120_000;

  async function rootsFor(projectId: string): Promise<{ key: string; path: string }[]> {
    const projectDir = await options.projectDir(projectId);
    const repositories = await options.repositories(projectId);
    return repositories
      .map((repository) => ({
        key: repository.key,
        path: resolve(options.workspaceRoot, projectDir, repository.key),
      }))
      .filter((entry) => existsSync(entry.path));
  }

  async function walk(root: string, predicate: (rel: string) => boolean, limit: number): Promise<string[]> {
    const found: string[] = [];

    const visit = async (dir: string): Promise<void> => {
      if (found.length >= limit) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= limit) return;
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          continue;
        }
        const rel = relative(root, full).split(sep).join('/');
        if (predicate(rel)) found.push(rel);
      }
    };

    await visit(root);
    return found;
  }

  async function readCapped(path: string): Promise<string | null> {
    try {
      const info = await stat(path);
      if (info.size > maxBytes) return null;
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  function fence(rel: string, content: string): string {
    const language = rel.split('.').pop() ?? '';
    return `### ${rel}\n\`\`\`${language}\n${content}\n\`\`\``;
  }

  return {
    /** Repository conventions. Priority 1 in every code recipe. */
    'coding-standards': async ({ projectId }) => {
      const roots = await rootsFor(projectId);
      const parts: string[] = [];

      for (const root of roots) {
        for (const file of CONVENTION_FILES) {
          const content = await readCapped(join(root.path, file));
          if (!content) continue;
          // package.json is included for its scripts, not its dependency list.
          parts.push(fence(`${root.key}/${file}`, file === 'package.json' ? summarisePackage(content) : content));
        }
      }
      return parts.length ? { content: parts.join('\n\n'), itemCount: parts.length } : null;
    },

    /**
     * Code relevant to the story. Ranked by how strongly the path matches terms drawn from the
     * story, then truncated — whole files, never arbitrary line windows.
     */
    'relevant-code': async ({ projectId, section, variables }) => {
      const roots = await rootsFor(projectId);
      if (!roots.length) return null;

      const terms = extractTerms(variables?.retrievalQuery, variables?.storyTitle);
      const parts: string[] = [];
      let budget = section.maxTokens * 3.4;

      for (const root of roots) {
        const files = await walk(root.path, (rel) => CODE_EXTENSIONS.test(rel) && !TEST_PATH.test(rel), 400);
        const ranked = rankByTerms(files, terms).slice(0, 25);

        for (const rel of ranked) {
          if (budget <= 0) break;
          const content = await readCapped(join(root.path, rel));
          if (!content) continue;
          const block = fence(`${root.key}/${rel}`, content);
          budget -= block.length;
          parts.push(block);
        }
      }
      return parts.length ? { content: parts.join('\n\n'), itemCount: parts.length } : null;
    },

    /** A shallow survey for the architect: structure and entry points, not every file. */
    'existing-code-survey': async ({ projectId }) => {
      const roots = await rootsFor(projectId);
      if (!roots.length) return null;

      const parts: string[] = [];
      for (const root of roots) {
        const files = await walk(root.path, (rel) => CODE_EXTENSIONS.test(rel), 300);
        const tree = files.slice(0, 200).sort();
        parts.push(`### ${root.key} (${files.length} source files)\n${tree.map((f) => `- ${f}`).join('\n')}`);
      }
      return { content: parts.join('\n\n'), itemCount: roots.length };
    },

    'existing-tests': async ({ projectId, section }) => {
      const roots = await rootsFor(projectId);
      if (!roots.length) return null;

      const parts: string[] = [];
      let budget = section.maxTokens * 3.4;

      for (const root of roots) {
        const files = await walk(root.path, (rel) => TEST_PATH.test(rel), 60);
        for (const rel of files) {
          if (budget <= 0) break;
          const content = await readCapped(join(root.path, rel));
          if (!content) continue;
          const block = fence(`${root.key}/${rel}`, content);
          budget -= block.length;
          parts.push(block);
        }
      }
      return parts.length ? { content: parts.join('\n\n'), itemCount: parts.length } : null;
    },

    'dependency-manifest': async ({ projectId }) => {
      const roots = await rootsFor(projectId);
      const parts: string[] = [];

      for (const root of roots) {
        for (const file of ['package.json', 'requirements.txt', 'go.mod', 'Gemfile', 'pom.xml']) {
          const content = await readCapped(join(root.path, file));
          if (content) parts.push(fence(`${root.key}/${file}`, content));
        }
      }
      return parts.length ? { content: parts.join('\n\n'), itemCount: parts.length } : null;
    },

    /**
     * The change under review. The workflow passes the change set through `variables`, because the
     * reviewer must see exactly what the developer produced — reconstructing a diff from the
     * workspace would show whatever is there now, which is not the same thing.
     */
    'pull-request-diff': async ({ projectId, variables, section, inputRefs }) => {
      let changes = variables?.changes as
        | { path: string; action: string; content?: string }[]
        | undefined;

      // Recover the change set from the pinned implementation artifact when the caller passed a
      // ref rather than the payload — which is the normal path.
      if (!changes?.length && options.readArtifact && inputRefs?.length) {
        for (const ref of inputRefs) {
          const content = (await options.readArtifact(ref.versionId).catch(() => null)) as
            | {
                changes?: { path: string; action: string; content?: string }[];
                tests?: { path: string; content?: string }[];
              }
            | null;
          if (content?.changes?.length) {
            changes = [
              ...content.changes,
              ...(content.tests ?? []).map((test) => ({
                path: test.path,
                action: 'CREATE',
                ...(test.content ? { content: test.content } : {}),
              })),
            ];
            break;
          }
        }
      }

      if (changes?.length) {
        let budget = section.maxTokens * 3.4;
        const parts: string[] = [];
        for (const change of changes) {
          if (budget <= 0) break;
          const block =
            change.action === 'DELETE'
              ? `### ${change.path} (deleted)`
              : fence(`${change.path} (${change.action.toLowerCase()})`, change.content ?? '');
          budget -= block.length;
          parts.push(block);
        }
        return { content: parts.join('\n\n'), itemCount: changes.length };
      }

      // No change set supplied: fall back to the newest files in the workspace so a reviewer is
      // not left with nothing, and say so plainly rather than pretending it is a diff.
      const roots = await rootsFor(projectId);
      if (!roots.length) {
        return { content: 'No change set was supplied and no workspace checkout exists.', itemCount: 0 };
      }
      const parts: string[] = ['_No structured change set was supplied; showing workspace contents._'];
      for (const root of roots) {
        const files = await walk(root.path, (rel) => CODE_EXTENSIONS.test(rel), 25);
        for (const rel of files) {
          const content = await readCapped(join(root.path, rel));
          if (content) parts.push(fence(`${root.key}/${rel}`, content));
        }
      }
      return { content: parts.join('\n\n'), itemCount: parts.length - 1 };
    },
  };
}

function summarisePackage(content: string): string {
  try {
    const manifest = JSON.parse(content) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    return JSON.stringify(
      {
        name: manifest.name,
        scripts: manifest.scripts ?? {},
        dependencies: Object.keys(manifest.dependencies ?? {}),
      },
      null,
      2,
    );
  } catch {
    return content;
  }
}

function extractTerms(...sources: unknown[]): string[] {
  const words = sources
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3);
  return [...new Set(words)];
}

function rankByTerms(files: string[], terms: string[]): string[] {
  if (terms.length === 0) return files;
  return [...files]
    .map((file) => {
      const haystack = file.toLowerCase();
      const score = terms.reduce((sum, term) => (haystack.includes(term) ? sum + 1 : sum), 0);
      return { file, score };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .map((entry) => entry.file);
}
