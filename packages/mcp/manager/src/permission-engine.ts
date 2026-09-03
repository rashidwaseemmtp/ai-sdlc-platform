/**
 * MCP permission engine — docs/06 §3, docs/07 §1.
 *
 * Deny by default. A call is authorised only when some grant matches on all four axes: server,
 * tool pattern, scope, and arguments. The fourth axis is what makes this real — `create_branch`
 * being granted is not enough if the branch name or repository is wrong.
 *
 * This is the layer that contains a successful prompt injection: an agent that "decides" to push
 * to main still gets a PERMISSION_DENIED tool result and an audit row.
 */

import { resolve, relative, isAbsolute, sep } from 'node:path';
import { minimatch } from 'minimatch';
import {
  parseQualifiedToolName,
  type ArgumentPolicy,
  type McpGrant,
  type McpServerKey,
} from '@sdlc/shared';

export interface PermissionRequest {
  agentKey: string;
  projectId: string;
  serverKey: McpServerKey;
  toolName: string;
  args: Record<string, unknown>;
  /** Per-run call counts, used for `maxCallsPerRun`. */
  callCounts: Record<string, number>;
  /** Repositories attached to this project — an allowlist beyond the grant's own. */
  projectRepositories?: string[];
  /** Absolute path the agent is jailed to for filesystem-style tools. */
  workspaceRoot?: string;
}

export type PermissionResult =
  | { allowed: true; grant: McpGrant }
  | { allowed: false; reason: string; detail?: Record<string, unknown> };

/** Tool-name keys whose values are treated as filesystem paths. */
const PATH_ARG_KEYS = ['path', 'file', 'filePath', 'file_path', 'directory', 'dir', 'target'];
const REPO_ARG_KEYS = ['repo', 'repository', 'repoFullName', 'repo_full_name', 'owner_repo'];
const BRANCH_ARG_KEYS = ['branch', 'branchName', 'branch_name', 'head', 'ref'];
const COMMAND_ARG_KEYS = ['command', 'cmd', 'script'];

export class PermissionEngine {
  constructor(private readonly defaultDeniedPaths: string[] = []) {}

  /** Filter a server's advertised tools down to what this agent may actually see. */
  visibleTools(grants: McpGrant[], serverKey: McpServerKey, toolNames: string[]): string[] {
    const applicable = grants.filter((g) => g.serverKey === serverKey);
    return toolNames.filter((name) =>
      applicable.some((grant) => matchesPattern(name, grant.toolPattern)),
    );
  }

  check(request: PermissionRequest, grants: McpGrant[]): PermissionResult {
    const applicable = grants.filter(
      (grant) =>
        grant.agentKey === request.agentKey &&
        grant.serverKey === request.serverKey &&
        (!grant.projectId || grant.projectId === request.projectId) &&
        matchesPattern(request.toolName, grant.toolPattern),
    );

    if (applicable.length === 0) {
      return {
        allowed: false,
        reason: 'no grant matches this agent, server and tool',
        detail: {
          agentKey: request.agentKey,
          serverKey: request.serverKey,
          toolName: request.toolName,
        },
      };
    }

    // A single satisfying grant is enough; report the last failure when none satisfy.
    let lastFailure: PermissionResult = {
      allowed: false,
      reason: 'argument policy rejected the call',
    };

    for (const grant of applicable) {
      const verdict = this.checkArguments(request, grant);
      if (verdict.allowed) return { allowed: true, grant };
      lastFailure = verdict;
    }
    return lastFailure;
  }

  private checkArguments(request: PermissionRequest, grant: McpGrant): PermissionResult {
    const policy: ArgumentPolicy = grant.argumentPolicy ?? {};

    if (policy.maxCallsPerRun !== undefined) {
      const key = `${request.serverKey}:${request.toolName}`;
      const used = request.callCounts[key] ?? 0;
      if (used >= policy.maxCallsPerRun) {
        return {
          allowed: false,
          reason: `tool call budget exhausted (${policy.maxCallsPerRun} per run)`,
          detail: { toolName: request.toolName, used },
        };
      }
    }

    const repo = firstString(request.args, REPO_ARG_KEYS);
    if (repo !== undefined) {
      const allowed = policy.repositories ?? request.projectRepositories;
      if (allowed && !allowed.some((pattern) => matchesPattern(repo, pattern))) {
        return {
          allowed: false,
          reason: 'repository is not attached to this project',
          detail: { repo, allowed },
        };
      }
    }

    const branch = firstString(request.args, BRANCH_ARG_KEYS);
    if (branch !== undefined && policy.branchPattern) {
      if (!new RegExp(policy.branchPattern).test(branch)) {
        return {
          allowed: false,
          reason: `branch name does not match the required pattern ${policy.branchPattern}`,
          detail: { branch },
        };
      }
    }

    const command = firstString(request.args, COMMAND_ARG_KEYS);
    if (command !== undefined) {
      if (!policy.commandAllowlist || policy.commandAllowlist.length === 0) {
        return {
          allowed: false,
          reason: 'this grant permits no commands',
          detail: { command },
        };
      }
      if (!policy.commandAllowlist.some((allowed) => command.trim().startsWith(allowed))) {
        return {
          allowed: false,
          reason: 'command is not on the allowlist',
          detail: { command, allowlist: policy.commandAllowlist },
        };
      }
    }

    for (const key of PATH_ARG_KEYS) {
      const value = request.args[key];
      if (typeof value !== 'string') continue;
      const verdict = this.checkPath(value, policy, request.workspaceRoot);
      if (!verdict.allowed) return verdict;
    }

    return { allowed: true, grant };
  }

  /**
   * Path jail. Resolves before comparing so `../` and absolute paths cannot escape, and rejects
   * the denylist (`.env*`, key material, `.git/config`) regardless of where the jail sits.
   */
  private checkPath(
    candidate: string,
    policy: ArgumentPolicy,
    workspaceRoot?: string,
  ): PermissionResult {
    const denied = [...this.defaultDeniedPaths, ...(policy.deniedPaths ?? [])];
    const normalised = candidate.split('\\').join('/');

    for (const pattern of denied) {
      if (minimatch(normalised, pattern, { dot: true, matchBase: !pattern.includes('/') })) {
        return {
          allowed: false,
          reason: 'path is on the denylist',
          detail: { path: candidate, pattern },
        };
      }
    }

    if (workspaceRoot) {
      const root = resolve(workspaceRoot);
      const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
      const rel = relative(root, target);
      if (rel.startsWith('..') || (isAbsolute(rel) && rel !== '')) {
        return {
          allowed: false,
          reason: 'path escapes the workspace jail',
          detail: { path: candidate, workspaceRoot },
        };
      }

      if (policy.pathJail?.length) {
        const relPosix = rel.split(sep).join('/');
        const inside = policy.pathJail.some(
          (jail) =>
            relPosix === jail ||
            relPosix.startsWith(`${jail.replace(/\/$/, '')}/`) ||
            minimatch(relPosix, jail, { dot: true }),
        );
        if (!inside) {
          return {
            allowed: false,
            reason: 'path is outside the paths this agent may touch',
            detail: { path: relPosix, pathJail: policy.pathJail },
          };
        }
      }
    }

    return { allowed: true } as PermissionResult;
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  return minimatch(value, pattern, { nocase: false });
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export { parseQualifiedToolName };
