import { describe, it, expect } from 'vitest';
import { PermissionEngine } from './permission-engine.js';
import { defaultGrants, DEFAULT_DENIED_PATHS, aiMergeGrant } from './grants.js';
import type { McpGrant } from '@sdlc/shared';

const engine = new PermissionEngine(DEFAULT_DENIED_PATHS);
const grants = defaultGrants();

function check(
  agentKey: string,
  serverKey: string,
  toolName: string,
  args: Record<string, unknown> = {},
  extra: { workspaceRoot?: string; projectRepositories?: string[] } = {},
) {
  return engine.check(
    {
      agentKey,
      projectId: 'p1',
      serverKey,
      toolName,
      args,
      callCounts: {},
      ...extra,
    },
    grants,
  );
}

describe('deny by default (invariant I5)', () => {
  it('denies a tool on a server the agent has no grant for', () => {
    const result = check('product-owner', 'github', 'get_repository');
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('no grant') });
  });

  it('denies a tool outside the granted pattern', () => {
    // The architect may read GitHub but never write to it.
    expect(check('architect', 'github', 'get_file').allowed).toBe(true);
    expect(check('architect', 'github', 'create_branch').allowed).toBe(false);
    expect(check('architect', 'github', 'push').allowed).toBe(false);
  });

  it('denies an unknown agent entirely', () => {
    expect(check('rogue-agent', 'github', 'get_file').allowed).toBe(false);
  });
});

describe('no agent can merge a pull request (invariant I7)', () => {
  const agents = [
    'product-owner',
    'business-analyst',
    'architect',
    'architecture-critic',
    'estimator',
    'resource-planner',
    'delivery-planner',
    'developer',
    'code-reviewer',
    'security-reviewer',
    'qa',
    'bug-analyzer',
  ];

  it.each(agents)('%s cannot merge', (agent) => {
    expect(check(agent, 'github', 'merge_pull_request', { repo: 'acme/api' }).allowed).toBe(false);
  });

  it('the default grant matrix contains no merge scope at all', () => {
    expect(grants.some((g) => g.scopes.includes('pull_request.merge'))).toBe(false);
  });

  it('merging becomes possible only through an explicit privileged grant', () => {
    const privileged: McpGrant[] = [...grants, aiMergeGrant('developer', ['acme/api'])];
    const result = engine.check(
      {
        agentKey: 'developer',
        projectId: 'p1',
        serverKey: 'github',
        toolName: 'merge_pull_request',
        args: { repo: 'acme/api' },
        callCounts: {},
      },
      privileged,
    );
    expect(result.allowed).toBe(true);
  });
});

describe('argument policy', () => {
  it('allows a branch that carries the story ref', () => {
    expect(check('developer', 'github', 'create_branch', { branch: 'feat/US-142-deactivate' }).allowed).toBe(
      true,
    );
  });

  it('rejects a branch that does not', () => {
    const result = check('developer', 'github', 'create_branch', { branch: 'main' });
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('branch name') });
  });

  it('rejects a push straight to a protected branch', () => {
    expect(check('developer', 'github', 'push', { branch: 'main' }).allowed).toBe(false);
    expect(check('developer', 'github', 'push', { branch: 'develop' }).allowed).toBe(false);
  });

  it('rejects a repository not attached to the project', () => {
    const result = check(
      'developer',
      'github',
      'get_file',
      { repo: 'someone-else/private' },
      { projectRepositories: ['acme/api', 'acme/web'] },
    );
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('not attached') });
  });

  it('accepts a repository that is attached', () => {
    expect(
      check('developer', 'github', 'get_file', { repo: 'acme/api' }, { projectRepositories: ['acme/api'] })
        .allowed,
    ).toBe(true);
  });

  it('enforces a per-run call budget', () => {
    const result = engine.check(
      {
        agentKey: 'developer',
        projectId: 'p1',
        serverKey: 'filesystem',
        toolName: 'read_file',
        args: { path: 'src/app.ts' },
        callCounts: { 'filesystem:read_file': 400 },
        workspaceRoot: '/ws',
      },
      grants,
    );
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('budget exhausted') });
  });
});

describe('filesystem jail', () => {
  const root = process.platform === 'win32' ? 'D:\\ws\\project' : '/ws/project';

  it('allows a path inside the workspace', () => {
    expect(
      check('developer', 'filesystem', 'write_file', { path: 'src/app.ts' }, { workspaceRoot: root })
        .allowed,
    ).toBe(true);
  });

  it('rejects traversal out of the workspace', () => {
    const result = check(
      'developer',
      'filesystem',
      'read_file',
      { path: '../../../etc/passwd' },
      { workspaceRoot: root },
    );
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('escapes the workspace') });
  });

  it.each([
    '.env',
    '.env.local',
    'config/secrets/keys.json',
    'certs/server.pem',
    'deploy/id_rsa',
    '.git/config',
  ])('rejects denylisted path %s', (path) => {
    const result = check('developer', 'filesystem', 'read_file', { path }, { workspaceRoot: root });
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('denylist') });
  });

  it('confines QA to test directories', () => {
    expect(
      check('qa', 'filesystem', 'write_file', { path: 'tests/login.spec.ts' }, { workspaceRoot: root })
        .allowed,
    ).toBe(true);

    const result = check(
      'qa',
      'filesystem',
      'write_file',
      { path: 'src/billing/service.ts' },
      { workspaceRoot: root },
    );
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('outside the paths') });
  });
});

describe('command execution', () => {
  it('denies commands when the grant carries no allowlist', () => {
    const result = check('developer', 'filesystem', 'write_file', { command: 'rm -rf /' });
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('permits no commands') });
  });

  it('permits only allowlisted commands', () => {
    const withCommands: McpGrant[] = [
      {
        agentKey: 'developer',
        serverKey: 'build',
        toolPattern: 'run',
        scopes: ['build.run'],
        argumentPolicy: { commandAllowlist: ['pnpm run build', 'pnpm run test'] },
      },
    ];
    const run = (command: string) =>
      engine.check(
        {
          agentKey: 'developer',
          projectId: 'p1',
          serverKey: 'build',
          toolName: 'run',
          args: { command },
          callCounts: {},
        },
        withCommands,
      );

    expect(run('pnpm run build').allowed).toBe(true);
    expect(run('curl http://evil.example').allowed).toBe(false);
    expect(run('rm -rf /').allowed).toBe(false);
  });
});

describe('tool visibility', () => {
  it('shows an agent only the tools it holds', () => {
    const visible = engine.visibleTools(grants, 'github', [
      'get_file',
      'create_branch',
      'push',
      'merge_pull_request',
    ]);
    // Called without an agent filter this returns the union of all github grants; merge is absent
    // from every one of them.
    expect(visible).not.toContain('merge_pull_request');
  });

  it('hides write tools from a read-only agent', () => {
    const architectGrants = grants.filter((g) => g.agentKey === 'architect');
    const visible = engine.visibleTools(architectGrants, 'github', [
      'get_file',
      'create_branch',
      'push',
    ]);
    expect(visible).toEqual(['get_file']);
  });
});
