# AI-Native Software Delivery Organization

A locally-runnable platform where specialized AI agents collaborate through a durable workflow
engine to carry work from client conversations to tested, reviewed code — with mandatory human
approval at every consequential decision.

**Status: running end to end.** `pnpm demo` takes the seeded project from two meeting documents to
a completed pipeline — requirements, backlog, three architecture options, an ADR, estimates, a
delivery plan, pull requests, test cases and QA results — across 31 agent runs and four human
approval gates, with no credentials configured.

## The one idea

Agents do not pass prompts to each other. They read and write **versioned project state** in
PostgreSQL, orchestrated by **Temporal**, using **pluggable models** and **pluggable MCP tools**.

```
                        ORCHESTRATOR (Temporal — control plane)
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
   PO · BA · Architect        Developer · Reviewer            QA · Bug Analyst
        └────────────────────────────┼────────────────────────────┘
                                     ▼
                      PROJECT STATE (PostgreSQL — source of truth)
                    immutable versioned artifacts + full lineage
```

That separation is what makes the system resumable (Temporal replays), auditable (every input
version is recorded), and testable (agents are contract-tested against fixture state).

## Pipeline

```
Meetings / notes / docs
  └─ Product Owner ─ Business Analyst ─ [BACKLOG APPROVAL]
     └─ Architect ×3 ─ Architecture Critic ─ [ARCHITECTURE APPROVAL] ─ ADR
        └─ Estimator ×2 ─ Resource Planner ─ [PLAN APPROVAL]
           └─ Developer ─ Figma MCP · GitHub MCP ─ PR ─ AI + security review ─ [PR APPROVAL]
              └─ QA ─ Playwright MCP ─ report ─ (bounded fix loop) ─ [QA APPROVAL]
```

Seven gates, each configurable, each pausing a durable workflow on a Temporal signal — never a
polling loop, and never auto-approving on timeout.

## Quick start

```bash
pnpm install
pnpm dev            # infra + schema + seed + worker + API + dashboard
```

Then in a second terminal:

```bash
pnpm demo           # runs the whole pipeline, approving each gate
pnpm demo --changes 1   # request changes once at the backlog gate to exercise the revision loop
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| API health | http://localhost:3001/api/v1/health |
| Temporal UI | http://localhost:8233 |
| Postgres | `localhost:5433` |

Demo mode (`DEMO_MODE=true`, the default) uses mock model, GitHub, Figma and Playwright providers,
so the entire pipeline runs with zero external credentials. Adding a real provider is a
configuration change, not a code change.

Useful commands:

```bash
pnpm doctor       # check the local environment
pnpm stop         # stop worker / API processes (cross-platform)
pnpm infra:up     # just the containers
pnpm db:push      # apply schema + invariant triggers
pnpm db:seed      # reseed the demo project
pnpm test         # unit, domain, permission, budget and workflow tests
pnpm lint         # includes the workflow determinism firewall
```

## What actually runs

From a clean `pnpm demo`:

```
Customer Management SaaS (CMS) — phase COMPLETED
  requirements 7   stories 3   arch options 3   ADRs 1
  estimates 6      pull requests 3
  test cases 21    results 21   bugs 0
  31 agent runs, 0 failures, 171,890 tokens
```

And the trace resolves all the way back:

```
Discovery call — 12 March  →  REQ-001  →  US-101  →  TC-10100
```

## Repository layout

```
apps/         api (NestJS) · worker (Temporal) · dashboard (Next.js)
packages/     shared · database · observability
              ai/{core,providers,router}   provider-agnostic model layer
              mcp/{core,manager,servers}   MCP layer, permissions, mocks
              context · domain             retrieval; pure business rules
              agents/{runtime,catalog}     the 12-step loop; 13 agent contracts
              workflows                    DETERMINISTIC ONLY
              activities                   ALL side effects
prompts/      versioned agent prompts, pinned per run
config/       models · mcp · agents · workflows · security
infra/        docker compose, temporal config, scripts
docs/         the design package (start at docs/00-overview.md)
```

Two dependency rules carry most of the weight, and both are enforced rather than documented:
**workflow code may import only `@sdlc/shared` and activity types** (checked by `eslint.config.js`),
and **`domain` performs no I/O**.

## Non-negotiable invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Workflow code does no I/O, no clock, no randomness | ESLint rules + the workflow bundler |
| I2 | Every agent output is Zod-validated before persistence | The runtime's only persistence path |
| I3 | Approved artifact versions are immutable | Database trigger |
| I4 | Activities carry artifact references, never bodies | Reference-passing throughout |
| I5 | No agent may call an MCP tool it was not granted | Permission engine, deny-by-default |
| I6 | Every autonomous loop has attempt, cost, token and wall-clock ceilings | `BudgetGuard` + workflow bounds |
| I7 | AI never merges a PR unless explicitly and doubly enabled | No merge scope in the grant matrix |
| I8 | A high-risk task never silently falls back to a weaker model | Router raises rather than downgrades |
| I9 | Private chain-of-thought is never surfaced or stored | Agents emit a structured decision summary |
| I10 | Every artifact traces to its sources | Lineage written by the platform, not the agent |

These are tested, not asserted. `pnpm test` covers the budget ceilings, the permission matrix (all
twelve agents provably unable to merge), the capability floor, the bounded revision and PR-fix
loops, and the approval-gate expiry path. The database invariants are verified against real
Postgres.

## Documentation

| Doc | Contents |
|---|---|
| [00 Overview](docs/00-overview.md) | Vision, principles, invariants |
| [01 System Architecture](docs/01-system-architecture.md) | Components, topology, execution paths |
| [02 Data Model](docs/02-data-model.md) | 70 tables, ERD, immutability rules |
| [03 Workflows](docs/03-workflows.md) | Temporal catalog, signals, retries, determinism |
| [04 Agents](docs/04-agent-architecture.md) | Contracts, runtime loop, quality gates |
| [05 Models](docs/05-model-architecture.md) | Providers, API vs subscription billing, router |
| [06 MCP](docs/06-mcp-architecture.md) | Manager, transports, permissions, servers |
| [07 Security](docs/07-permissions-and-security.md) | RBAC, sandbox, secrets, prompt injection |
| [08 Approvals](docs/08-approvals.md) | Gates, signal protocol, timeouts |
| [09 Context & Artifacts](docs/09-context-and-artifacts.md) | Retrieval, versioning, lineage |
| [10 API](docs/10-api-spec.md) | REST surface, SSE |
| [11 Configuration](docs/11-configuration.md) | Layers, precedence, env, YAML |
| [12 Repository](docs/12-repository-structure.md) | Monorepo layout, dependency rules |
| [13 Roadmap](docs/13-roadmap.md) | Phases, MVP, exit criteria |
| [14 Testing](docs/14-testing-strategy.md) | Tiers, mocks, replay, invariant tests |
| [15 Implementation Notes](docs/15-implementation-notes.md) | **Deviations, bugs the build found, known gaps** |

Read doc 15 before extending anything: it records where the design was wrong and why.

## Design goal

Not the most autonomous system possible — the most **reliable, inspectable, configurable and
progressively autonomous** one. AI handles analysis, generation, implementation, testing and
review. Humans keep business decisions, architecture approval, resource commitments, merging and
release.
