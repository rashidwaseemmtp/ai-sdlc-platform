/**
 * Default MCP servers and grants.
 *
 * Seeded **disabled**. Every entry here is a real, published server with the command that runs it,
 * so enabling one is a switch on the MCP page rather than a research exercise — but nothing is
 * reachable until somebody decides it should be. Deny by default has to mean deny by default on a
 * fresh install too.
 *
 * The grants are seeded alongside them so the matrix shows a sensible shape: the developer gets
 * write access to the workspace, the reviewers get read-only, QA gets a browser. They stay inert
 * while their server is disabled.
 */

import { db } from './db.js';

const WORKSPACE = process.env.WORKSPACE_ROOT ?? '/workspace';

interface SeedServer {
  key: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env?: Record<string, string>;
  note: string;
}

const SERVERS: SeedServer[] = [
  {
    key: 'filesystem',
    name: 'Filesystem (workspace)',
    transport: 'stdio',
    command: 'npx',
    // Rooted at the workspace, so the server itself cannot reach outside it even if a grant is
    // wider than it should be. Defence in depth: the platform's own path guards are the other half.
    args: ['-y', '@modelcontextprotocol/server-filesystem', WORKSPACE],
    note: 'Reads and writes files inside the project workspace.',
  },
  {
    key: 'git',
    name: 'Git (workspace)',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', WORKSPACE],
    note: 'Log, diff and blame over the project repository. Needs uv installed.',
  },
  {
    key: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    note: 'Issues, pull requests and code search. Set the token in this server\'s environment.',
  },
  {
    key: 'playwright',
    name: 'Playwright (browser)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--headless'],
    note: 'Drives a real browser, so QA can actually run its end-to-end cases.',
  },
];

/** Sensible starting shape for the grant matrix. Inert while the server is disabled. */
const GRANTS: { agentKey: string; serverKey: string; toolPatterns: string[]; maxCallsPerRun: number }[] = [
  // The developer is the only agent that writes.
  { agentKey: 'developer', serverKey: 'filesystem', toolPatterns: ['*'], maxCallsPerRun: 80 },
  { agentKey: 'developer', serverKey: 'git', toolPatterns: ['git_log', 'git_diff*', 'git_show'], maxCallsPerRun: 20 },
  { agentKey: 'developer', serverKey: 'github', toolPatterns: ['get_*', 'search_*'], maxCallsPerRun: 20 },

  // Reviewers read. A reviewer that can edit the code it is reviewing is not a reviewer.
  { agentKey: 'code-reviewer', serverKey: 'filesystem', toolPatterns: ['read_*', 'list_*', 'search_*'], maxCallsPerRun: 40 },
  { agentKey: 'code-reviewer', serverKey: 'git', toolPatterns: ['git_log', 'git_diff*', 'git_show'], maxCallsPerRun: 20 },
  { agentKey: 'security-reviewer', serverKey: 'filesystem', toolPatterns: ['read_*', 'list_*', 'search_*'], maxCallsPerRun: 40 },

  // QA needs a browser to run anything, and the workspace to write its specs.
  { agentKey: 'qa', serverKey: 'playwright', toolPatterns: ['*'], maxCallsPerRun: 120 },
  { agentKey: 'qa', serverKey: 'filesystem', toolPatterns: ['*'], maxCallsPerRun: 40 },
  { agentKey: 'bug-analyzer', serverKey: 'filesystem', toolPatterns: ['read_*', 'search_*'], maxCallsPerRun: 30 },
];

export async function seedMcp(): Promise<void> {
  for (const server of SERVERS) {
    await db.mcpServer.upsert({
      where: { key: server.key },
      create: {
        key: server.key,
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env ?? {},
        enabled: false,
        status: 'UNKNOWN',
      },
      // Never re-disable or overwrite a server somebody has already configured.
      update: {},
    });
  }

  for (const grant of GRANTS) {
    await db.mcpGrant.upsert({
      where: { agentKey_serverKey: { agentKey: grant.agentKey, serverKey: grant.serverKey } },
      create: { ...grant, enabled: true },
      update: {},
    });
  }
}
