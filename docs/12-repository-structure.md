# 12 — Repository Structure

pnpm workspaces + Turborepo. TypeScript project references, `strict: true`, ESM.

```
ai-sdlc-platform/
├── apps/
│   ├── api/                    NestJS REST + SSE + OpenAPI
│   ├── worker/                 Temporal worker(s) — workflows + activities registration
│   └── dashboard/              Next.js 15 App Router
│
├── packages/
│   ├── shared/                 @sdlc/shared      types, zod schemas, events, errors
│   │                           @sdlc/shared/node  config loader — SEPARATE ENTRY POINT, see below
│   ├── database/               @sdlc/database    prisma schema, client, repositories, seed
│   ├── observability/          @sdlc/observability  logger, tracing, metrics, redaction
│   │
│   ├── ai/
│   │   ├── core/               @sdlc/ai-core     ModelProvider interface, types, token counting
│   │   ├── providers/          @sdlc/ai-providers  anthropic, openai, google, openrouter,
│   │   │                                           ollama, claude-subscription, mock
│   │   ├── router/             @sdlc/ai-router   catalog, selection, fallback, circuit breaker
│   │   └── schemas/            @sdlc/ai-schemas  structured-output helpers, repair
│   │
│   ├── mcp/
│   │   ├── core/               @sdlc/mcp-core    client, transports, types
│   │   ├── manager/            @sdlc/mcp-manager registry, health, permissions, audit
│   │   └── servers/            @sdlc/mcp-servers — three real stdio servers plus mocks:
│   │                             product/ (local | jira | linear | custom)
│   │                             ba/      (local | jira | linear | azure | github-issues)
│   │                             filesystem/ (ours — the jail is the point)
│   │                             mocks/   (github · figma · playwright)
│   │
│   ├── context/                @sdlc/context     recipes, retrieval, embeddings, packing
│   │
│   ├── agents/
│   │   ├── runtime/            @sdlc/agent-runtime   the 12-step loop, budget guard
│   │   └── catalog/            @sdlc/agents          all agent contracts, one file per phase:
│   │                             discovery · backlog · architecture · planning ·
│   │                             development · quality · echo
│   │
│   ├── workflows/              @sdlc/workflows   DETERMINISTIC ONLY
│   │   ├── project/  discovery/  backlog/  architecture/  estimation/
│   │   ├── planning/  development/  code-review/  qa/  bugfix/  release/
│   │   └── lib/                approval helper, retry policies, semaphore, guards
│   │
│   ├── activities/             @sdlc/activities  ALL side effects
│   │   ├── agent/  db/  github/  figma/  playwright/  git/  build/  events/  approval/
│   │
│   └── domain/                 @sdlc/domain      business logic, no I/O
│       ├── projects/  requirements/  backlog/  architecture/  estimation/
│       ├── development/  testing/  approvals/  artifacts/  cost/
│
├── prompts/                    versioned, one dir per agent, vN.md — never edited in place
│   ├── product-owner/v1.md
│   ├── business-analyst/v1.md
│   ├── architect/v1.md
│   ├── architecture-critic/v1.md
│   ├── estimator/v1.md
│   ├── resource-planner/v1.md
│   ├── delivery-planner/v1.md
│   ├── developer/v1.md
│   ├── code-reviewer/v1.md
│   ├── security-reviewer/v1.md
│   ├── qa/v1.md
│   └── bug-analyzer/v1.md
│
├── config/                     models.yaml, mcp.yaml, agents.yaml, workflows.yaml,
│                               security.yaml, demo.yaml
├── infra/
│   ├── docker/                 Dockerfiles, docker-compose.yml, compose.override examples
│   ├── temporal/               dynamic config, namespace bootstrap
│   └── scripts/                setup, migrate, seed, doctor
│
├── tests/
│   ├── integration/  workflow/  e2e/  fixtures/  mocks/
│
├── docs/                       this design package
├── turbo.json  pnpm-workspace.yaml  tsconfig.base.json  .env.example  README.md
```

## Dependency rules

Enforced by `eslint-plugin-boundaries` and by the fact that a violation breaks the TypeScript build.

```
apps/*            → packages/*                      (may depend on anything)
workflows         → shared ONLY  (+ activity *types*)    ← the determinism firewall
activities        → domain, database, agents/runtime, mcp, ai, context, shared
agents/*          → ai, mcp, context, domain, shared
domain/*          → shared, database(types only)    ← no I/O, no HTTP, no LLM
mcp/*             → mcp/core, shared
ai/*              → ai/core, shared
database          → shared
shared            → nothing internal
```

**`@sdlc/shared` has two entry points, and the split is load-bearing.** The root export is types
only. The config loader imports `node:fs`, and the Temporal workflow bundler refuses to bundle it —
so it lives at `@sdlc/shared/node`, which workflow code may never import. This was not a
precaution: the worker would not start until the split was made (docs/15 §2).

Two rules do the heavy lifting:

1. **`workflows` may not import `activities`, `database`, `ai`, `mcp`, or `context`** — only their
   *types*. This is what keeps workflow code deterministic (I1), and it is a compile error, not a
   review comment.
2. **`domain` performs no I/O.** Business rules stay unit-testable without a database, a network, or
   a model.

## Naming and layout conventions

- One agent = one package, containing its `AgentDefinition`, Zod input/output schemas, quality checks,
  and its golden fixtures. Its prompt lives in `prompts/<agent>/vN.md`, loaded and hashed at runtime.
- One workflow = one file exporting one workflow function plus its signals/queries.
- Activities are grouped by side-effect domain and exported as a single typed `Activities` object per
  task queue, which is what workflows `proxyActivities<...>` against.
- Every package ships `src/index.ts` as its only public surface; deep imports are lint errors.
