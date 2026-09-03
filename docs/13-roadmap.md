# 13 — Roadmap & MVP Plan

Governing rule from doc 60/70: **design → implement → test → run locally → validate → proceed.** No
phase starts before the previous one runs end to end on a real machine.

Every phase below has an **exit criterion** that is a runnable demonstration, not a checklist of files.

## Phase 1 — Foundation

*Goal: an empty but real platform. No agents yet, but everything an agent will need.*

| Deliverable | Detail |
|---|---|
| Monorepo | pnpm workspaces, Turborepo, tsconfig references, ESLint boundaries incl. the workflow firewall |
| Infrastructure | `docker-compose.yml`: Postgres 16 + pgvector, Redis 7, Temporal + UI; one-command startup |
| Database | Full Prisma schema (doc 02), migrations, immutability trigger, seed |
| Shared | Types, Zod schemas, domain events, config loader with layer precedence |
| Temporal | Worker bootstrap, four task queues, `ProjectWorkflow` skeleton, replay test harness |
| Model layer | `ModelProvider` interface, router with capability floor + fallback, `MockModelProvider`, Anthropic adapter |
| MCP layer | Manager, stdio/http transports, permission engine, `MockMCPServer`, filesystem server |
| Agent runtime | The 12-step loop with budget guard, validation, repair, audit — exercised by a trivial `echo` agent |
| Approvals | Gate model, request/decision tables, signal protocol, reconcile path |
| API | NestJS bootstrap, projects/settings/approvals/agents/workflows modules, OpenAPI, SSE |
| Dashboard | Next.js shell, projects list/detail, pipeline view, approvals inbox, agent runs, settings |

**Exit criterion:** `docker compose up` → create a project in the UI → a trivial workflow runs an
`echo` agent through the runtime on the mock provider → writes a versioned artifact → raises an
approval gate → a human approves it in the dashboard → the workflow resumes and completes. Kill the
worker mid-run and it recovers. This proves every seam before any agent intelligence exists.

## Phase 2 — Discovery & Backlog

| Deliverable | Detail |
|---|---|
| Document ingestion | Upload/import, chunking, embeddings (mock + real), traceable source spans |
| Product Owner agent | Definition, prompt v1, output schema, quality checks |
| Product MCP | Local backend, full capability contract |
| Business Analyst agent | Definition, prompt v1, story/AC schemas, duplicate + ambiguity + size detection |
| BA MCP | Local backend incl. `search_backlog`, `split_story`, `merge_stories` |
| `DiscoveryWorkflow`, `BacklogWorkflow` | Including the bounded revision loop |
| Backlog review UI | Per-story edit/approve/reject/split/regenerate/comment, batch approval |

**Exit criterion:** import the demo meeting notes → PO produces traceable requirements → BA produces a
backlog with GWT acceptance criteria and quality flags → a human requests changes on two stories → BA
revises only those → backlog approved. Every story traces to a requirement, and every requirement to a
sentence in a document.

## Phase 3 — Architecture, Estimation, Planning

| Deliverable | Detail |
|---|---|
| Architect agent | Three parallel option briefs, 21-section schema, Mermaid diagram |
| Architecture Critic | Independent, author-blind, ten weighted criteria, recommendation |
| ADR | Immutable creation on approval, supersession chain |
| Estimator ×2 | Primary + independent on a different model, confidence and ranges mandatory |
| Variance review | Threshold breach forces human review |
| Resource Planner | Roles, fractional FTE, skills, duration, bottlenecks |
| Delivery Planner | Dependency ordering, waves, milestones, tasks, critical path |
| UI | Option comparison, scorecard, ADR view, estimate ranges, plan Gantt/waves |

**Exit criterion:** approved backlog → three genuinely different architectures → critic scorecard →
human approves Option B → ADR-001 written immutably → estimates with confidence and a flagged variance
→ resource plan → dev-readiness approval.

## Phase 4 — Development

| Deliverable | Detail |
|---|---|
| Git/workspace | Clone, branch, commit, push under `WORKSPACE_ROOT`, protected-branch guards |
| GitHub MCP | Full read + branch/commit/push/PR; merge scope defined but ungranted |
| Figma MCP | Optional, with the `DESIGN_CONTEXT_UNAVAILABLE` path |
| Development context package | Assembled by activity, budgeted, recorded |
| Developer agent | plan → implement → test → lint → typecheck → build → self-review → PR |
| Quality gates | Bounded build-fix loop, gitleaks, path jail, command allowlist |
| Code Reviewer + Security Reviewer | Structured findings with file/line/severity |
| `DevelopmentWorkflow` / `StoryWorkflow` / `CodeReviewWorkflow` | Parallel waves, bounded PR-fix loop |
| UI | PR list, diff, findings, review actions |

**Exit criterion:** a story goes from approved backlog to a real PR on a real repository, with the
full doc-21 PR body (story, ADR, Figma, tests, limitations, agent info), AI review, security review,
human approval — and the AI cannot merge it.

## Phase 5 — QA

| Deliverable | Detail |
|---|---|
| QA agent | Test design across all nine types, automation generation |
| Playwright MCP | Full driving surface, `sdlc-heavy` queue, hard caps |
| Evidence | Screenshots, video, traces, console and network logs, stored and linked |
| Bug Analyzer | Root cause, structured bugs, evidence-linked |
| `QAWorkflow` / `BugFixWorkflow` | Bounded fix iterations, re-test, QA gate |
| UI | Test cases, runs, evidence viewer, bug board |

**Exit criterion:** the story from Phase 4 gets generated test cases covering every acceptance
criterion, an executed Playwright run with evidence, one deliberate failure that produces a bug, a
bounded developer fix, a passing re-run, and a human QA approval.

## Phase 6 — Optimisation & scale

Cost optimisation (caching strategy, complexity-aware routing, batch where applicable), the evaluation
framework (doc 56: estimate accuracy vs. actuals, BA/architecture/code/QA quality scoring), impact
analysis for change requests on an existing codebase, multi-repo coordination for a single story,
richer memory (cross-project learning), and progressive autonomy — raising per-gate `autoApprove` only
where measured quality justifies it.

## MVP definition (doc 61)

The MVP is Phases 1–5 restricted to the single happy path, running on the demo project:

```
Create Project → Import Meeting Notes → PO → BA → Backlog → [APPROVE]
  → Architect (3 options) → Critic → Recommendation → [APPROVE] → ADR
  → Estimation → Resource Plan → [APPROVE]
  → Developer → GitHub PR → [ENGINEERING APPROVE]
  → QA → Playwright → QA Result → [APPROVE]
```

Explicitly **not** in the MVP: Jira/Linear backends (contract defined, local backend only),
GitLab/Bitbucket, multi-repo stories, the evaluation framework, cross-project memory, autonomy
tuning, auth beyond local users, and cloud deployment manifests. Each is an addition, not a rewrite —
which is the point of the abstraction boundaries.

## Sequencing risks, and how they are handled

| Risk | Handling |
|---|---|
| Temporal determinism bugs found late | Replay tests from Phase 1, before any agent exists |
| Agent output drift breaking parsing | Golden fixtures + `MockModelProvider` from Phase 1 |
| Runaway spend during development | Budget guard and `DEMO_MODE` default-on from Phase 1 |
| Prompt/schema coupling churn | Prompts versioned and pinned per run from Phase 1 |
| Provider API drift | Single adapter boundary; catalog and capability flags are data |
| Scope creep into autonomy | Gates are mandatory by default; `autoApprove` is a Phase 6 concern |
