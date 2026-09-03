# 01 — System Architecture

## 1. Runtime topology

Six processes. Three are infrastructure, three are ours.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                                   │
│  apps/dashboard — Next.js 15 (App Router), React Server Components         │
│  REST for commands · SSE (/events/stream) for live agent + workflow state  │
└───────────────────────────────────┬────────────────────────────────────────┘
                                    │ HTTP
┌───────────────────────────────────▼────────────────────────────────────────┐
│  apps/api — NestJS                                    :3001                │
│  ┌──────────────┬──────────────┬───────────────┬────────────────────────┐  │
│  │ REST modules │ Approval svc │ Config/Secret │ SSE event gateway      │  │
│  │ (doc 10)     │ (signals)    │ registry      │ (Redis Streams tail)   │  │
│  └──────────────┴──────────────┴───────────────┴────────────────────────┘  │
│  Writes DB · starts/signals/queries Temporal · NEVER runs agents           │
└──────┬───────────────────────────┬─────────────────────────┬───────────────┘
       │                           │                         │
       │ SQL                       │ gRPC                    │ Streams
┌──────▼──────────┐   ┌────────────▼────────────┐   ┌────────▼─────────┐
│  PostgreSQL 16  │   │  Temporal 1.25          │   │  Redis 7         │
│  + pgvector     │   │  server + UI :8233      │   │  events, cache,  │
│  SOURCE OF      │   │  CONTROL PLANE          │   │  rate limits,    │
│  TRUTH          │   │  (IDs + small state)    │   │  circuit breaker │
└──────▲──────────┘   └────────────▲────────────┘   └────────▲─────────┘
       │                           │ poll task queues        │
       │ SQL                       │                         │
┌──────┴───────────────────────────┴─────────────────────────┴───────────────┐
│  apps/worker — Temporal Worker(s)                                          │
│                                                                            │
│   WORKFLOWS (deterministic, sandboxed — no I/O)                            │
│   Project · Discovery · Backlog · Architecture · Estimation ·              │
│   ResourcePlanning · DeliveryPlanning · Development · Story ·              │
│   CodeReview · QA · BugFix · Release                                       │
│                                     │ proxyActivities                      │
│   ACTIVITIES (all side effects)     ▼                                      │
│   ┌──────────────────────────────────────────────────────────────────┐     │
│   │  AGENT RUNTIME                                                   │     │
│   │  resolve prompt → build context → route model → bind tools →     │     │
│   │  tool loop (budget-guarded) → validate (Zod) → persist → emit    │     │
│   └───────┬───────────────────┬──────────────────────┬───────────────┘     │
│           ▼                   ▼                      ▼                     │
│    MODEL ROUTER        CONTEXT ENGINE          MCP MANAGER                 │
│    Anthropic/OpenAI/   pgvector + git +        github · figma ·            │
│    Google/OpenRouter/  artifact recipes        playwright · product ·      │
│    Ollama/ClaudeCode                           ba · filesystem             │
└────────────────────────────────────────────────────────────────────────────┘
```

Task queues split by resource profile so a slow Playwright run cannot starve cheap LLM work:

| Queue | Worker | Activities |
|---|---|---|
| `sdlc-main` | worker (default) | orchestration, DB, events, artifacts |
| `sdlc-agents` | worker (concurrency-capped) | LLM / agent execution |
| `sdlc-tools` | worker | GitHub, Figma, product/BA MCP |
| `sdlc-heavy` | worker (1–2 slots) | Playwright, builds, test runs, git clone |

## 2. Why the API never runs agents

The API process is request/response and must stay responsive. Agent execution is long
(30 s – 20 min), retryable, and must survive process restarts. Every agent execution is therefore a
Temporal **Activity** running in the worker, with heartbeating and a server-side timeout. The API's
entire role in agent execution is `client.workflow.start(...)`, `handle.signal(...)`,
`handle.query(...)`.

Consequence: killing the API mid-pipeline loses nothing. Killing the worker mid-agent loses at most
one activity attempt, which Temporal retries.

## 3. The five core subsystems

### 3.1 Agent Runtime — `packages/agents/runtime`

Executes one `AgentInvocation`. Deterministic in structure, non-deterministic in content, which is
exactly why it lives in an activity. Detailed in [04](./04-agent-architecture.md).

### 3.2 Model Router — `packages/ai/router`

Agents declare **capability requirements**, never vendors. The router selects a concrete model from
the catalog using capability floor → project/agent policy → provider health → cost/latency, then walks
a configurable fallback chain. Supports API-metered, subscription-metered and local-free billing
modes. Detailed in [05](./05-model-architecture.md).

### 3.3 MCP Manager — `packages/mcp/manager`

Owns the lifecycle of MCP servers (stdio / HTTP / SSE), discovers and caches tool schemas,
health-checks, and — critically — mediates **every** tool call against the invoking agent permission
set, including argument-level policy (repo allowlists, branch patterns, path jails, command
allowlists). Detailed in [06](./06-mcp-architecture.md).

### 3.4 Context Engine — `packages/context`

Turns "agent X is about to do task Y on project P" into a token-budgeted context package.
Recipe-driven per task type, retrieval-backed (pgvector + git + artifact graph), never "send the whole
project". Detailed in [09](./09-context-and-artifacts.md).

### 3.5 Approval Engine — `packages/domain/approvals` + API

Approval is a first-class workflow primitive: a DB row for the UI plus a Temporal signal for the
workflow. No polling. Detailed in [08](./08-approvals.md).

## 4. Execution path — one agent run, end to end

```
Workflow                   Activity (worker)                     Stores
────────                   ─────────────────                     ──────
runAgent('business-        1. load AgentDefinition               PG: agent_definitions
  analyst', {projectId,    2. resolve prompt version             FS+PG: prompts/, prompt_versions
  inputRefs:[req-v3]})     3. ContextEngine.build(recipe)        PG+pgvector, git
        │                  4. ModelRouter.select(capability)     PG: model_catalog, Redis: health
        │                  5. McpManager.bindTools(permissions)  PG: mcp_grants
        │                  6. BudgetGuard.open(limits)           Redis: cost counters
        │                  7. provider.generate() + tool loop    → LLM, → MCP servers
        │                     (heartbeat each turn)
        │                  8. Zod validate (+1 repair attempt)
        │                  9. persist artifact vN (immutable)    PG: artifacts, artifact_versions
        │                 10. write lineage edges                PG: artifact_lineage
        │                 11. write audit record                 PG: agent_runs, llm_calls, tool_calls
        │                 12. emit domain event (outbox)         PG: outbox → Redis Streams
        ▼
   ArtifactRef {id, version, sha256}   ← only this crosses the workflow boundary
```

Steps 9–12 are one database transaction plus an outbox row. The event bus is fed by an outbox relay,
so an event is never published for an artifact whose transaction failed to commit.

## 5. Failure and recovery

| Failure | Behaviour |
|---|---|
| Worker crashes mid-agent | Temporal reschedules the activity after heartbeat timeout; partial LLM spend is already recorded, so the budget guard accounts for it |
| API crashes after DB approval write, before signal | The workflow `condition(..., timeout)` fires a `reconcileApproval` activity that re-reads the DB |
| Model provider down | Router circuit-breaks the provider, walks the fallback chain, refuses to drop below `minimumCapability` |
| MCP server dead | `MCP_UNAVAILABLE` — retryable when transient, non-retryable when the server is disabled. Agents with optional dependencies (Figma) degrade to `DESIGN_CONTEXT_UNAVAILABLE` |
| Invalid agent output after repair | `INVALID_OUTPUT` → non-retryable → workflow parks at `HUMAN_INTERVENTION_REQUIRED` |
| Budget ceiling hit | Loop halts, workflow parks at `HUMAN_INTERVENTION_REQUIRED` with a spend report |
| Postgres down | Activities fail and retry; Temporal preserves the workflow; no data loss |

## 6. Deployment posture

Local-first, server-ready. Nothing in the design assumes a single machine:

- All state lives in Postgres / Redis / Temporal — the three app processes are stateless.
- Workers scale horizontally per task queue.
- Secrets come from a `SecretProvider` interface: env file locally, Vault / KMS / Doppler in cloud.
- Repository working copies live under a configurable `WORKSPACE_ROOT` (a volume in cloud).
- The dashboard talks only to the API. No direct DB or Temporal access from the browser.
