/**
 * The default grant matrix — docs/06 §3.4.
 *
 * This is the security posture of the platform expressed as data. Two things are deliberately
 * absent and must stay absent:
 *
 *   - `pull_request.merge` on any agent. The scope exists so an operator can *see* that nobody
 *     holds it; granting it requires AI_MERGE_PERMISSION=true plus a deliberate admin action
 *     (invariant I7).
 *   - Any `approve_*` capability. Approval is a human act.
 */

import type { McpGrant } from '@sdlc/shared';

/** Filesystem paths no agent may ever read or write, regardless of jail. */
export const DEFAULT_DENIED_PATHS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '**/secrets/**',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/.ssh/**',
  '.git/config',
  '**/.git/config',
  '**/node_modules/**',
];

const READ_ONLY_GITHUB = ['get_*', 'search_*', 'list_*'];

/**
 * Branch names must embed the story ref, which is how every agent commit stays traceable back to
 * a backlog item (docs/07 §4).
 */
export const STORY_BRANCH_PATTERN = '^(feat|fix|chore)/[A-Z]+-\\d+';

export function defaultGrants(): McpGrant[] {
  const grants: McpGrant[] = [];

  const add = (
    agentKey: string,
    serverKey: string,
    toolPattern: string,
    scopes: string[],
    argumentPolicy?: McpGrant['argumentPolicy'],
  ): void => {
    grants.push({
      agentKey,
      serverKey,
      toolPattern,
      scopes,
      ...(argumentPolicy ? { argumentPolicy } : {}),
    });
  };

  // ── Product Owner: owns product state, sees nothing else ──────────────────
  add('product-owner', 'product', '*', ['product.read', 'product.write']);
  add('product-owner', 'ba', 'get_*', ['backlog.read']);
  add('product-owner', 'ba', 'search_backlog', ['backlog.read']);

  // ── Business Analyst: owns the backlog, reads product ─────────────────────
  for (const pattern of ['get_*', 'search_backlog']) {
    add('business-analyst', 'product', pattern, ['product.read']);
  }
  add('business-analyst', 'ba', '*', ['backlog.read', 'backlog.write']);

  // ── Architect & Critic: read everything, write nothing outside artifacts ──
  for (const agent of ['architect', 'architecture-critic']) {
    add(agent, 'product', 'get_*', ['product.read']);
    add(agent, 'ba', 'get_*', ['backlog.read']);
    add(agent, 'ba', 'search_backlog', ['backlog.read']);
    for (const pattern of READ_ONLY_GITHUB) {
      add(agent, 'github', pattern, ['repository.read']);
    }
    add(agent, 'filesystem', 'read_file', ['fs.read']);
    add(agent, 'filesystem', 'list_dir', ['fs.read']);
    add(agent, 'filesystem', 'search', ['fs.read']);
  }

  // ── Estimator / planners ─────────────────────────────────────────────────
  for (const agent of ['estimator', 'resource-planner']) {
    add(agent, 'product', 'get_*', ['product.read']);
    add(agent, 'ba', 'get_*', ['backlog.read']);
  }
  add('delivery-planner', 'ba', '*', ['backlog.read', 'backlog.write']);
  add('delivery-planner', 'product', 'get_*', ['product.read']);

  // ── Developer: the only agent that may write code, and only inside a jail ─
  for (const pattern of READ_ONLY_GITHUB) {
    add('developer', 'github', pattern, ['repository.read']);
  }
  add('developer', 'github', 'create_branch', ['branch.create'], {
    branchPattern: STORY_BRANCH_PATTERN,
  });
  add('developer', 'github', 'commit', ['commit.create'], { branchPattern: STORY_BRANCH_PATTERN });
  add('developer', 'github', 'push', ['push'], { branchPattern: STORY_BRANCH_PATTERN });
  add('developer', 'github', 'create_pull_request', ['pull_request.create']);
  add('developer', 'github', 'update_pull_request', ['pull_request.create']);
  // NOTE: merge_pull_request is intentionally never granted here.

  add('developer', 'figma', 'get_*', ['design.read']);
  add('developer', 'figma', 'export_assets', ['design.read']);
  add('developer', 'product', 'get_*', ['product.read']);
  add('developer', 'ba', 'get_*', ['backlog.read']);
  add('developer', 'filesystem', '*', ['fs.read', 'fs.write'], {
    deniedPaths: DEFAULT_DENIED_PATHS,
    maxCallsPerRun: 400,
  });

  // ── Reviewers: read the diff, comment, nothing else ──────────────────────
  for (const agent of ['code-reviewer', 'security-reviewer']) {
    for (const pattern of READ_ONLY_GITHUB) {
      add(agent, 'github', pattern, ['repository.read']);
    }
    add(agent, 'filesystem', 'read_file', ['fs.read']);
    add(agent, 'filesystem', 'search', ['fs.read']);
  }
  add('code-reviewer', 'ba', 'get_*', ['backlog.read']);

  // ── QA: full browser control, read-only everywhere else ──────────────────
  add('qa', 'playwright', '*', ['browser.full']);
  for (const pattern of READ_ONLY_GITHUB) {
    add('qa', 'github', pattern, ['repository.read']);
  }
  add('qa', 'figma', 'get_*', ['design.read']);
  add('qa', 'ba', 'get_*', ['backlog.read']);
  add('qa', 'filesystem', '*', ['fs.read', 'fs.write'], {
    // QA may only write test specs; source code is the developer's to change.
    pathJail: ['tests/**', 'e2e/**', 'playwright/**', '**/*.spec.ts', '**/*.test.ts'],
    deniedPaths: DEFAULT_DENIED_PATHS,
  });

  // ── Bug analyzer: read evidence, propose causes, change nothing ──────────
  for (const pattern of READ_ONLY_GITHUB) {
    add('bug-analyzer', 'github', pattern, ['repository.read']);
  }
  add('bug-analyzer', 'playwright', 'get_*', ['browser.read']);
  add('bug-analyzer', 'ba', 'get_*', ['backlog.read']);
  add('bug-analyzer', 'filesystem', 'read_file', ['fs.read']);
  add('bug-analyzer', 'filesystem', 'search', ['fs.read']);

  return grants;
}

/**
 * The privileged grant that lets an agent merge. Never called by the seed — it exists so the
 * capability is expressible, auditable, and obviously deliberate when an operator adds it.
 */
export function aiMergeGrant(agentKey: string, repositories: string[]): McpGrant {
  return {
    agentKey,
    serverKey: 'github',
    toolPattern: 'merge_pull_request',
    scopes: ['pull_request.merge'],
    argumentPolicy: { repositories, maxCallsPerRun: 1 },
  };
}
