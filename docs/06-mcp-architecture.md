# 06 — MCP Architecture

MCP-first: every capability an agent has outside its own reasoning is an MCP tool call, mediated by
one manager, permission-checked, audited, and replaceable. An agent never knows whether its backlog
lives in PostgreSQL, Jira, or Linear.

## 1. MCP Manager

`packages/mcp/manager` owns server lifecycle and is the **only** path from an agent to a tool.

```
                        ┌──────────────────────────────────────┐
   AgentRuntime ───────▶│            McpManager                │
                        │                                      │
                        │  registry   ← mcp_servers (DB)       │
                        │  lifecycle  spawn / connect / stop    │
                        │  discovery  tools/list → mcp_tools    │
                        │  health     ping + backoff + status   │
                        │  policy     PermissionEngine (§3)     │
                        │  audit      tool_calls rows           │
                        │  redaction  args & results scrubbed   │
                        └───────┬──────────────┬───────────────┘
                                │              │
                    stdio ──────┘              └────── http / sse
                       │                                  │
        ┌──────────────┼──────────────┐        ┌──────────┴─────────┐
     github         playwright     filesystem   product(jira)    ba(linear)
     figma          product(local) ba(local)    custom REST       …
```

API surface:

```ts
interface McpManager {
  register(cfg: McpServerConfig): Promise<McpServerId>;
  unregister(id: McpServerId): Promise<void>;
  enable(id: McpServerId): Promise<void>;
  disable(id: McpServerId): Promise<void>;
  configure(id: McpServerId, patch: Partial<McpServerConfig>): Promise<void>;

  health(id?: McpServerId): Promise<HealthReport[]>;
  discoverTools(id: McpServerId): Promise<McpToolSchema[]>;
  inspectSchema(id: McpServerId, tool: string): Promise<JsonSchema>;

  grant(agentKey: AgentKey, grant: McpGrant): Promise<void>;
  revoke(agentKey: AgentKey, grantId: string): Promise<void>;

  bindTools(agent: AgentDefinition, projectId: string): Promise<ToolSet>;
  callTool(ctx: InvocationContext, server: string, tool: string, args: unknown): Promise<ToolResult>;
}
```

`bindTools` returns **only** the tools the agent is granted, already namespaced
`mcp__{server}__{tool}` and already filtered — an agent cannot see, let alone call, a tool it lacks.
`callTool` re-checks permission at call time (defence in depth, since tool sets are cached).

Servers are versioned: changing a server config writes a new `mcp_servers` revision, and
`tool_calls` records the revision used, so an audit can answer "which GitHub server config was in
force when this branch was created".

## 2. Transports and lifecycle

| Transport | Use | Lifecycle |
|---|---|---|
| `stdio` | Local servers (`npx @modelcontextprotocol/server-github`, Playwright, filesystem) | Pooled child processes, lazily spawned, idle-reaped after `MCP_IDLE_TTL`, hard-killed on timeout |
| `http` / `sse` | Remote/hosted servers, custom company MCPs | Connection pool + keep-alive, bearer token from `SecretProvider` |

Health checks run on a timer and on demand: `initialize` + `tools/list` round trip, three strikes to
`UNHEALTHY`, exponential re-probe. Unhealthy servers are removed from binding, and agents whose
required servers are unhealthy fail fast with `MCP_UNAVAILABLE` instead of hallucinating results.

Because MCP servers are child processes doing real I/O, **every** MCP call happens inside a Temporal
activity — never in workflow code (I1).

## 3. Permission system

Deny by default. A grant is a tuple; a call is authorised only if some grant matches on all four axes.

```ts
interface McpGrant {
  agentKey: AgentKey;
  serverKey: string;
  toolPattern: string;          // 'get_*' | 'create_pull_request' | '*'
  scopes: Scope[];              // 'repository.read', 'branch.create', …
  argumentPolicy?: ArgumentPolicy;
  projectId?: string;           // omitted = all projects
}

interface ArgumentPolicy {
  repositories?: string[];      // allowlist, exact or glob
  branchPattern?: string;       // '^(feat|fix|chore)/US-\\d+-'
  pathJail?: string[];          // paths writable, relative to the repo workspace
  deniedPaths?: string[];       // '.env*', '**/secrets/**', '.git/**'
  commandAllowlist?: string[];  // for any exec-capable tool
  maxCallsPerRun?: number;
}
```

Argument-level policy is what makes this real. `create_branch` being granted is not enough: the branch
name must match the pattern, and the repository must be one attached to the project.

### The matrix (doc 32)

| Agent | github | figma | playwright | product | ba | filesystem |
|---|---|---|---|---|---|---|
| `product-owner` | — | — | — | **RW** (product requirements) | R | — |
| `business-analyst` | — | — | — | R | **RW** | — |
| `architect` | R | — | — | R | R | R (read-only, jailed) |
| `architecture-critic` | R | — | — | R | R | R |
| `estimator` | R | — | — | R | R | — |
| `resource-planner` | — | — | — | R | R | — |
| `delivery-planner` | — | — | — | R | **RW** (tasks) | — |
| `developer` | R + `branch.create`, `commit.create`, `push`, `pull_request.create` | R | — | R | R | **RW jailed** |
| `code-reviewer` | R + `pull_request.comment` | — | — | R | R | R |
| `security-reviewer` | R + `pull_request.comment` | — | — | — | — | R |
| `qa` | R | R | **FULL** | — | R | RW (tests dir only) |
| `bug-analyzer` | R | — | R (read evidence) | — | R | R |

No agent anywhere is granted `pull_request.merge`. That scope exists but is only assignable when
`AI_MERGE_PERMISSION=true` **and** an operator explicitly creates the grant — two independent
switches (I7).

Every denial writes a `tool_calls` row with `permissionDecision: 'DENIED'` and raises
`PERMISSION_DENIED`, which is non-retryable — a permission failure is a configuration bug or an
attempted overreach, and retrying it is never right.

## 4. Server catalogue

### 4.1 Product MCP (doc 7) — pluggable backend

Capability contract, identical across backends:

```
get_project · update_project · get_product_vision · update_product_vision
get_business_goals · create_business_goal · get_stakeholders · create_stakeholder
get_requirements · create_requirement · update_requirement · get_priorities
create_product_decision · get_product_decisions · get_open_questions · create_open_question
```

Backends: `local` (PostgreSQL, ships in-repo), `jira`, `linear`, `custom` (any URL implementing the
contract). Selected per project via `project_integrations`. The BA and PO agents are byte-identical
regardless of backend; only the server binary/URL changes.

### 4.2 BA MCP (doc 9) — pluggable backend

```
get_requirements · create_requirement · update_requirement
get_stories · create_story · update_story · split_story · merge_stories
get_acceptance_criteria · create_acceptance_criteria
get_dependencies · create_dependency
get_business_rules · create_business_rule
get_open_questions · create_open_question · search_backlog
```

Backends: `local` (PostgreSQL), `jira`, `linear`, `azure-devops`, `github-issues`, `custom`.

`search_backlog` is deliberately part of the contract: it is how the BA agent detects duplicates
without loading the entire backlog into context.

### 4.3 GitHub MCP (doc 20)

```
get_repository · get_file · search_code · create_branch · commit · push
create_pull_request · get_pull_request · update_pull_request
get_comments · get_reviews · get_checks · get_workflows
get_issues · create_issue · update_issue
[ merge_pull_request ]  ← exists, ungranted by default
```

Provider-pluggable behind the same contract: `github`, `gitlab`, `bitbucket`. Write operations
validate against `ArgumentPolicy` (repo allowlist, branch pattern, protected-branch denylist) before
reaching the network.

### 4.4 Figma MCP (doc 19)

```
get_file · get_frames · get_components · get_styles · get_colors
get_typography · get_spacing · export_assets · get_node
```

**Optional by design.** If Figma is not configured, `buildDevelopmentContextPackage` sets
`DESIGN_CONTEXT_UNAVAILABLE` and the story proceeds only when it carries no `design-required` label;
otherwise the workflow parks for human input. The agent is never told to imagine a design.

### 4.5 Playwright MCP (doc 25)

```
open_browser · navigate · click · fill · select · upload · hover · press
inspect · get_text · screenshot · console_logs · network_log
accessibility_snapshot · assert · close
```

Runs on the `sdlc-heavy` queue with a hard wall-clock cap. Evidence (screenshots, video, traces,
console and network logs) is written to artifact storage and linked from `test_evidence`. Replaceable
by any other testing MCP implementing the same contract.

### 4.6 Filesystem MCP

Not a stock server — ours, because the jail is the point.

```
read_file · list_dir · search · write_file · apply_patch · delete_file
```

Every path is resolved against the project workspace root and rejected if it escapes, matches
`deniedPaths` (`.env*`, `**/secrets/**`, `.git/**`, key material), or falls outside the agent's
`pathJail`. Symlinks are resolved before the check. There is **no** generic shell tool: builds, tests
and linters are fixed activities with allowlisted commands (doc 07).

## 5. Configuration

```yaml
mcp:
  servers:
    github:
      enabled: true
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env: { GITHUB_TOKEN: 'secret:github_token' }
      permissions: [repository.read, branch.create, commit.create, push, pull_request.create]

    figma:
      enabled: false
      transport: http
      url: http://localhost:3845/mcp
      env: { FIGMA_TOKEN: 'secret:figma_token' }

    playwright:
      enabled: true
      transport: stdio
      command: npx
      args: ['-y', '@playwright/mcp@latest']

    product:
      enabled: true
      transport: stdio
      command: node
      args: ['./packages/mcp/product/dist/server.js']
      config: { backend: local }          # local | jira | linear | custom

    ba:
      enabled: true
      transport: stdio
      command: node
      args: ['./packages/mcp/ba/dist/server.js']
      config: { backend: local }
```

Everything here is also editable in the dashboard (Settings → MCP Servers), which writes to
`mcp_servers` and triggers rediscovery. Enabling a server never auto-grants it: grants are a separate,
deliberate action.

## 6. Mock servers

`MockMCPServer` implements any contract from a fixture file, which is how the demo project runs GitHub,
Figma and Playwright flows with no credentials (doc 65/66). Mocks are selected by config
(`backend: mock`), so the code path under test is the real one.
