# AI-Native Software Delivery Organization — Overview

> **Codename:** `ai-sdlc-platform` · package scope `@sdlc/*`
> **Status:** Design baseline v1 (pre-implementation)

## 1. What this is

A locally-runnable platform that simulates a complete software delivery organization. Specialized AI
agents (Product Owner, Business Analyst, Architect, Architecture Critic, Estimator, Resource Planner,
Delivery Planner, Developer, Code Reviewer, QA, Bug Analyzer) collaborate through a **durable workflow
engine**, operating on **shared versioned project state**, using **pluggable models**, **pluggable MCP
tools**, **versioned prompts**, and **mandatory human approval gates**.

## 2. The one architectural rule everything else follows

Agents do **not** hand prompts to each other.

```
WRONG                                  RIGHT
                                       
PO ──prompt──> BA ──prompt──> ARCH      ORCHESTRATOR (Temporal)
                                              │ schedules
Fragile. Unresumable. Untraceable.            ▼
Context grows without bound.            AGENT RUNTIME (activity)
Every agent depends on the                    │ reads/writes
previous agent's exact output.                ▼
                                        PROJECT STATE (PostgreSQL)
                                        immutable versioned artifacts
```

Every agent execution is a pure-ish function:

```
(project state slice, retrieved context, versioned prompt, model)
        → validated structured artifact + audit record + domain event
```

An agent never reads another agent's *prompt output*. It reads **committed artifacts** from the
database, selected by the Context Engine. This is what makes the system resumable (Temporal can
replay), auditable (every input version is recorded), and testable (agents are contract-tested against
fixture state).

## 3. Three-plane separation

| Plane | Technology | Owns | Never owns |
|---|---|---|---|
| **State plane** | PostgreSQL + pgvector | Source of truth: projects, requirements, backlog, architecture, ADRs, estimates, PRs, tests, artifacts, audit | Orchestration control flow |
| **Control plane** | Temporal | Sequencing, retries, timers, human-approval waits, parallelism, recovery, versioning | Business data. Holds **IDs and small state only** |
| **Capability plane** | MCP Manager + Model Router | Access to the outside world (GitHub, Figma, Playwright, Jira/Linear) and to LLMs | Decisions about *what* to do |

**Temporal is the backbone, not the database.** Workflow history carries `{projectId, artifactRef,
version, hash}` — never document bodies. This keeps workflow histories small, replays fast, and makes
the system inspectable with plain SQL.

## 4. Non-negotiable invariants

These are enforced in code and asserted in tests. Violating one is a build failure, not a style issue.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Workflow code performs no I/O, no `Date.now()`, no `Math.random()`, no LLM calls | `@typescript-eslint` + `eslint-plugin-temporal` ruleset on `packages/workflows/**`; deterministic replay tests |
| I2 | Every agent output is validated against a Zod schema before persistence | `AgentRuntime.execute()` — no persistence path bypasses `validateOutput()` |
| I3 | Approved artifact versions are immutable | DB trigger `artifact_versions_no_update_when_approved` + no `UPDATE` in repository layer |
| I4 | Activities carry artifact **references**, not bodies (>16 KB payloads rejected) | Temporal payload-size interceptor |
| I5 | No agent may call an MCP tool it has not been granted | `McpManager.callTool()` checks the invocation's `PermissionSet`; deny-by-default |
| I6 | Every autonomous loop has attempt, cost, token and wall-clock ceilings | `BudgetGuard` wraps every agent invocation; workflows carry `iteration` counters |
| I7 | AI never merges a PR unless `AI_MERGE_PERMISSION=true` **and** a privileged grant exists | GitHub MCP permission scope `pull_request.merge`, off by default |
| I8 | A high-risk task never silently falls back to a weaker model | `ModelRouter` enforces `minimumCapability`; exhausting the chain raises `NoEligibleModelError` |
| I9 | Private chain-of-thought is never surfaced in the UI or stored as rationale | Agents emit a structured `DecisionSummary`; raw reasoning is not requested or persisted |
| I10 | Every artifact traces to its sources | `artifact_lineage` edges written by the runtime, not by agents |

## 5. Lifecycle

```
Meetings / notes / docs
   └─> Product Owner ─> Business Analyst ─> [BACKLOG APPROVAL] ──┐
                                                                  │
   ┌──────────────────────────────────────────────────────────────┘
   └─> Architect (2–3 options) ─> Architecture Critic ─> [ARCHITECTURE APPROVAL] ─> ADR
                                                                  │
   ┌──────────────────────────────────────────────────────────────┘
   └─> Estimator + Estimation Critic ─> Resource Planner ─> [PLAN APPROVAL]
                                                                  │
   ┌──────────────────────────────────────────────────────────────┘
   └─> Delivery Planner ─> Developer (per story, parallel)
             └─> Figma MCP · GitHub MCP ─> PR ─> AI review ─> [PR APPROVAL]
                       └─> QA ─> Playwright MCP ─> pass/fail
                                 └─fail─> Bug Analyzer ─> Developer (max N) ─> [QA APPROVAL]
```

Seven approval gates, each independently configurable, each pausing a durable workflow via a Temporal
signal — never a polling loop.

## 6. What "done" means for the MVP

One command (`docker compose up` or `pnpm dev`) brings up Postgres, Redis, Temporal, API, worker and
dashboard. With **zero external credentials** the seeded demo project ("Customer Management SaaS")
runs the entire pipeline end-to-end against mock providers, producing a real backlog, three real
architecture options, an ADR, estimates, a resource plan, a PR (mock GitHub), test cases and a QA
report — with all six human gates surfaced in the dashboard.

Swapping mocks for real credentials is a configuration change, not a code change.

## 7. Document map

| Doc | Contents |
|---|---|
| [01 — System Architecture](./01-system-architecture.md) | Components, runtime topology, execution paths |
| [02 — Data Model](./02-data-model.md) | Entities, ERD, table reference, immutability rules |
| [03 — Workflows](./03-workflows.md) | Temporal catalog, signals, queries, retry policies, determinism |
| [04 — Agent Architecture](./04-agent-architecture.md) | `AgentDefinition`, runtime loop, quality gates, agent catalog |
| [05 — Models](./05-model-architecture.md) | Provider abstraction, API vs subscription billing, router, fallback |
| [06 — MCP](./06-mcp-architecture.md) | Manager, transports, permissions, server catalog |
| [07 — Security & Permissions](./07-permissions-and-security.md) | RBAC/ABAC, secrets, sandboxing, allowlists |
| [08 — Approvals](./08-approvals.md) | Gate model, signal protocol, timeouts, UI contract |
| [09 — Context & Artifacts](./09-context-and-artifacts.md) | Context Engine, retrieval, versioning, lineage |
| [10 — API](./10-api-spec.md) | REST surface, SSE, OpenAPI |
| [11 — Configuration](./11-configuration.md) | Layers, precedence, env, YAML, DB, UI |
| [12 — Repository Structure](./12-repository-structure.md) | Monorepo layout and dependency rules |
| [13 — Roadmap](./13-roadmap.md) | Phases, MVP plan, exit criteria per phase |
| [14 — Testing](./14-testing-strategy.md) | Unit, workflow replay, contract, E2E, mock providers |
| [15 — Implementation Notes](./15-implementation-notes.md) | Deviations from this design, bugs the build found, known gaps |
