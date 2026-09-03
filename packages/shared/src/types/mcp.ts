/**
 * MCP types — docs/06-mcp-architecture.md.
 *
 * Deny by default. A tool call is authorised only when a grant matches on server, tool pattern,
 * scope, and argument policy. `bindTools` returns only granted tools, and `callTool` re-checks at
 * call time because tool sets are cached.
 */

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpServerKey = string;

export interface McpServerConfig {
  key: McpServerKey;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Values are secret *references* (`secret:github_token`), never plaintext. */
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  enabled: boolean;
  revision: number;
}

export interface McpToolSchema {
  serverKey: McpServerKey;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Namespaced tool name as exposed to the model: `mcp__github__create_branch`. */
export type QualifiedToolName = `mcp__${string}__${string}`;

export function qualifyToolName(server: McpServerKey, tool: string): QualifiedToolName {
  return `mcp__${server}__${tool}` as QualifiedToolName;
}

export function parseQualifiedToolName(
  name: string,
): { server: McpServerKey; tool: string } | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { server: match[1], tool: match[2] };
}

/**
 * Argument-level policy. This is what makes a grant meaningful: `create_branch` being permitted
 * is not enough — the repository must be attached to the project and the branch name must carry
 * the story ref.
 */
export interface ArgumentPolicy {
  repositories?: string[];
  branchPattern?: string;
  pathJail?: string[];
  deniedPaths?: string[];
  commandAllowlist?: string[];
  maxCallsPerRun?: number;
}

export interface McpGrant {
  agentKey: string;
  serverKey: McpServerKey;
  toolPattern: string;
  scopes: string[];
  argumentPolicy?: ArgumentPolicy;
  projectId?: string;
}

export interface McpPermission {
  serverKey: McpServerKey;
  toolPatterns: string[];
  scopes: string[];
  required: boolean;
  argumentPolicy?: ArgumentPolicy;
}

export interface ToolResult {
  content: unknown;
  isError: boolean;
  durationMs: number;
}

export interface InvocationContext {
  projectId: string;
  agentKey: string;
  agentRunId: string;
  workflowId?: string;
  grants: McpGrant[];
  callCounts: Record<string, number>;
}

export interface HealthReport {
  serverKey: McpServerKey;
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  toolCount?: number;
  latencyMs?: number;
  checkedAt: string;
  message?: string;
}

export interface BoundTool {
  qualifiedName: QualifiedToolName;
  serverKey: McpServerKey;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolSet = BoundTool[];
