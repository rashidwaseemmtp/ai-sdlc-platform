#!/usr/bin/env node
/**
 * Filesystem MCP — ours, because the jail is the point.
 *
 * There is no stock server here for a reason: every stock filesystem MCP trusts the path it is
 * given. This one resolves symlinks, rejects traversal, enforces a denylist and refuses to read
 * or write anything outside `WORKSPACE_ROOT`. The manager's permission engine checks arguments
 * too; this is the second, independent enforcement point (defence in depth, docs/07 §1).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, readdir, stat, mkdir, unlink, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, join, isAbsolute, sep } from 'node:path';
import { minimatch } from 'minimatch';

const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT ?? './.workspace');
const MAX_FILE_BYTES = Number(process.env.MCP_FS_MAX_BYTES ?? 2_000_000);

const DENIED = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '**/secrets/**',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/.ssh/**',
  '**/.git/config',
  '**/node_modules/**',
];

const server = new McpServer({ name: 'sdlc-filesystem', version: '0.1.0' });

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

/**
 * Resolve a caller-supplied path to a real absolute path inside the jail, or throw.
 * Symlinks are resolved *before* the containment check — otherwise a symlink inside the workspace
 * pointing at /etc/passwd would pass a naive prefix test.
 */
async function safeResolve(input: string, mustExist: boolean): Promise<string> {
  const normalised = input.split('\\').join('/');

  for (const pattern of DENIED) {
    if (minimatch(normalised, pattern, { dot: true, matchBase: !pattern.includes('/') })) {
      throw new Error(`path is on the denylist: ${input}`);
    }
  }

  const candidate = isAbsolute(input) ? resolve(input) : resolve(WORKSPACE_ROOT, input);

  let real = candidate;
  try {
    real = await realpath(candidate);
  } catch {
    if (mustExist) throw new Error(`no such file: ${input}`);
    // For a new file, resolve the closest existing ancestor so a symlinked parent cannot escape.
    let parent = dirname(candidate);
    for (;;) {
      try {
        const realParent = await realpath(parent);
        real = join(realParent, relative(parent, candidate));
        break;
      } catch {
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }
  }

  const rel = relative(WORKSPACE_ROOT, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace jail: ${input}`);
  }
  return real;
}

server.registerTool(
  'read_file',
  {
    description: 'Read a UTF-8 file from the project workspace.',
    inputSchema: {
      path: z.string().describe('Path relative to the workspace root'),
      maxBytes: z.number().int().positive().optional(),
    },
  },
  async ({ path, maxBytes }) => {
    try {
      const target = await safeResolve(path, true);
      const info = await stat(target);
      const limit = maxBytes ?? MAX_FILE_BYTES;
      if (info.size > limit) {
        return fail(`file is ${info.size} bytes, over the ${limit} byte limit`);
      }
      return ok(await readFile(target, 'utf8'));
    } catch (error) {
      return fail((error as Error).message);
    }
  },
);

server.registerTool(
  'list_dir',
  {
    description: 'List the entries of a directory in the workspace.',
    inputSchema: { path: z.string().default('.') },
  },
  async ({ path }) => {
    try {
      const target = await safeResolve(path, true);
      const entries = await readdir(target, { withFileTypes: true });
      return ok(
        entries
          .filter((entry) => !entry.name.startsWith('.git') && entry.name !== 'node_modules')
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
          })),
      );
    } catch (error) {
      return fail((error as Error).message);
    }
  },
);

server.registerTool(
  'search',
  {
    description: 'Search file contents under a directory with a regular expression.',
    inputSchema: {
      pattern: z.string(),
      path: z.string().default('.'),
      glob: z.string().default('**/*'),
      maxResults: z.number().int().positive().max(200).default(50),
    },
  },
  async ({ pattern, path, glob, maxResults }) => {
    try {
      const root = await safeResolve(path, true);
      const regex = new RegExp(pattern, 'i');
      const results: { file: string; line: number; text: string }[] = [];

      const walk = async (dir: string): Promise<void> => {
        if (results.length >= maxResults) return;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (results.length >= maxResults) return;
          if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          const rel = relative(WORKSPACE_ROOT, full).split(sep).join('/');
          if (!minimatch(rel, glob, { dot: false })) continue;
          const info = await stat(full);
          if (info.size > MAX_FILE_BYTES) continue;

          const lines = (await readFile(full, 'utf8')).split('\n');
          for (const [index, text] of lines.entries()) {
            if (regex.test(text)) {
              results.push({ file: rel, line: index + 1, text: text.trim().slice(0, 300) });
              if (results.length >= maxResults) return;
            }
          }
        }
      };

      await walk(root);
      return ok(results);
    } catch (error) {
      return fail((error as Error).message);
    }
  },
);

server.registerTool(
  'write_file',
  {
    description: 'Write a UTF-8 file inside the workspace, creating parent directories.',
    inputSchema: { path: z.string(), content: z.string() },
  },
  async ({ path, content }) => {
    try {
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        return fail(`content exceeds the ${MAX_FILE_BYTES} byte limit`);
      }
      const target = await safeResolve(path, false);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      return ok({ written: relative(WORKSPACE_ROOT, target), bytes: Buffer.byteLength(content) });
    } catch (error) {
      return fail((error as Error).message);
    }
  },
);

server.registerTool(
  'apply_patch',
  {
    description:
      'Replace an exact string in a file. Fails when the search text is absent or ambiguous, so ' +
      'a stale assumption produces an error rather than a silent wrong edit.',
    inputSchema: {
      path: z.string(),
      search: z.string(),
      replace: z.string(),
      expectedOccurrences: z.number().int().positive().default(1),
    },
  },
  async ({ path, search, replace, expectedOccurrences }) => {
    try {
      const target = await safeResolve(path, true);
      const original = await readFile(target, 'utf8');
      const occurrences = original.split(search).length - 1;

      if (occurrences === 0) return fail(`search text not found in ${path}`);
      if (occurrences !== expectedOccurrences) {
        return fail(
          `search text appears ${occurrences} time(s), expected ${expectedOccurrences}; ` +
            'widen the search string to make the edit unambiguous',
        );
      }

      await writeFile(target, original.split(search).join(replace), 'utf8');
      return ok({ patched: relative(WORKSPACE_ROOT, target), occurrences });
    } catch (error) {
      return fail((error as Error).message);
    }
  },
);

server.registerTool(
  'delete_file',
  { description: 'Delete a file inside the workspace.', inputSchema: { path: z.string() } },
  async ({ path }) => {
    try {
      const target = await safeResolve(path, true);
      await unlink(target);
      return ok({ deleted: relative(WORKSPACE_ROOT, target) });
    } catch (error) {
      return fail((error as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());
