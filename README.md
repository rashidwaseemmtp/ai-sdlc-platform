# AI SDLC Platform

Twelve specialised AI agents take a project from raw client material — meeting transcripts, emails,
specifications — through requirements, a backlog, a chosen architecture, estimates and a plan, to
written code, reviewed and tested. A human approves every consequential decision.

Two pieces of software: a **backend** and a **frontend**. Nothing else.

```
docker compose up --build     # then open http://localhost:3000
```

That is the whole setup. The database schema is applied and a demo project seeded on first boot.
Open **Settings**, pick a provider, paste an API key (or sign in to a subscription CLI), then open
the demo project and press **Start**.

---

## What it does

```
Source documents
  └─ Product Owner ────── requirements, traced to what the client actually said
     └─ Business Analyst ─ backlog with testable criteria ───────── [BACKLOG]
        └─ Architect ×3 ── three committed options
           └─ Critic ───── blind scoring ────────────────────────── [ARCHITECTURE] → ADR
              └─ Estimator ×2 ─ two independent estimates ───────── [ESTIMATION]
                 └─ Resource + Delivery planners ─ waves ────────── [READINESS]
                    └─ Developer ─ code ─ Reviewer + Security ──── [PULL REQUEST]
                       └─ QA ─ tests ─ Bug Analyzer ─ fix loop ─── [QA]
```

Twelve agents, seven stages, six gates. A gate stops the project until a person approves it, rejects
it, or writes down what to change — and "request changes" sends the agent back round with that
feedback, up to a bound you set.

## Architecture

```
frontend/   React + Vite, served by nginx, which proxies /api to the backend
backend/    Express + Prisma. The API, the agents and the runner in one process.
            src/agents/        the twelve agents — prompt, schema, checks, persistence
            src/pipeline.ts    discovery, backlog, architecture, estimation, planning
            src/stages-delivery.ts  development and QA, with their bounded loops
            src/stage-kit.ts   what a stage is: gates, re-entrancy, the settle branch
            src/runner.ts      claims a project, advances it one stage, releases it
            src/domain.ts      the arithmetic: scoring, variance, dependency waves
            src/llm.ts         one function, three adapters, five providers
            src/mcp.ts         tool servers, deny-by-default grants, the audit trail
            src/workspace.ts   where the code lands; git, path guards, GitHub push
db          Postgres — the only state anywhere
```

Four ideas carry the design:

**Agents read project state, not each other's prose.** Every agent is handed rows from Postgres,
rendered as labelled sections, and writes rows back. Nothing is passed agent-to-agent, so the
pipeline resumes from the database alone.

**The pipeline has no memory.** A stage is a re-entrant function: it opens a gate and returns, and
an approval decision makes the project claimable again. Nothing lives between two stage calls except
rows, which is why a restart mid-project loses nothing and there is no workflow engine. Development
and QA go one story per tick, so a crash costs one story rather than the backlog.

**The platform does its own checking.** A model proposes; `domain.ts` decides. Which architecture
option wins, whether two estimates disagree enough to need a human, what order the work can be built
in, and whether a story is actually testable are all computed in pure functions with no model in the
loop. The Business Analyst reports its own doubts about the backlog, *and* the platform re-derives
them independently — anything the agent missed is shown to the approver.

**Capability is configuration; judgement is code.** Which model answers, which tool servers exist and
which tools each agent may call are all edited in the dashboard. The agents' prompts, output schemas
and quality checks are files in the repository, because an operator quietly changing an agent's
schema between runs makes its audit trail meaningless.

## Providers

Every provider × entitlement pair can be configured and left configured. **Exactly one is active at
a time** — switching from metered billing to a subscription is one dropdown.

| Provider | API key | Subscription | Tools |
|---|---|---|---|
| Anthropic — Claude | ✓ | Claude Code CLI · Pro / Max | API only |
| OpenAI — ChatGPT | ✓ | Codex CLI · Plus / Pro / Business | API only |
| Google — Gemini | ✓ | Gemini CLI · AI Pro / Ultra | API only |
| OpenRouter | ✓ | — | ✓ |
| Ollama (local) | — | local server | ✓ |

A subscription holds **no credential here** — the vendor's CLI owns its own login, and the platform
strips that vendor's API-key variables from the CLI's environment so a stray key cannot silently
divert the run onto metered billing. Sign in once, inside the container:

```bash
docker compose exec backend claude      # then /login
docker compose exec backend codex login --device-auth
docker compose exec backend gemini      # choose "Login with Google"
```

**A subscription cannot run agents that use MCP tools.** Not because the CLIs lack tools — because a
tool executed inside a vendor's CLI bypasses this platform's permission engine and audit trail. So
the developer, the reviewers and QA are sent to a second entitlement you name on the Settings page
("send agents with MCP tools to a different entitlement"), and the rest of the pipeline stays on the
seat. Both halves are explicit; nothing is inferred.

## MCP and tools

The **MCP & tools** page configures tool servers (stdio or streamable HTTP) and a per-agent grant
matrix. Four servers are seeded ready to use and **switched off**: filesystem, git, GitHub and
Playwright. Enable one, press *Test connection* to discover what it advertises, then grant patterns
per agent — `get_*`, `read_file`, `*`.

Three rules hold the safety together:

- **Deny by default.** An agent with no grant cannot see a server's tools, let alone call them.
- **A denial is a tool result, not a crash.** The model is told "permission denied" and adapts; the
  attempt is recorded. This is the layer that contains a successful prompt injection.
- **Some things are never grantable.** Merging, force-pushing and deleting are on a permanent deny
  list that no grant overrides, because they are exactly what a compromised agent would ask for.

Every call an agent made or was refused is on its run page.

## Code, and GitHub

The developer returns a change set; the platform applies it. Each project gets a git repository the
backend owns, each story gets a branch, and the diff is what the reviewers read and what the pull
request gate shows. Paths that escape the workspace or touch git internals, env files or key
material are refused before they reach disk.

With a GitHub token in Settings, the platform also pushes the branch and opens a real pull request —
the platform, never an agent, because the thing that opens a PR should be the thing that cannot
merge it, and keeping the token out of the tool layer means no prompt can talk its way into using it.

## Configuration

Everything is on **Settings**, stored in the database, applied on the runner's next tick. No YAML,
no environment variables beyond `DATABASE_URL`, `PORT` and `WORKSPACE_ROOT`:

- every provider × entitlement pair: key, model, base URL, CLI binary, token prices
- which pair is active, and which pair tool-using agents are sent to
- token ceiling and reasoning effort
- spend ceilings per project and per agent; tool calls per run
- revision rounds for the backlog, architecture, code review and QA fix loops
- the estimation variance threshold
- which of the six gates require a human, and how long each waits
- GitHub token, repository and whether to push at all
- runner poll interval and how many projects advance at once

## Running it locally, without Docker

```bash
docker compose up -d db          # or point DATABASE_URL at any Postgres

cd backend
npm install
npx prisma db push
npm run seed
npm run dev                      # http://localhost:3001/api

cd ../frontend
npm install
npm run dev                      # http://localhost:3000, proxying /api to :3001
```

## API

| Method | Path | |
|---|---|---|
| GET/PUT | `/api/settings` | everything the Settings page edits |
| GET | `/api/providers/probe` | which subscription CLIs are actually installed |
| GET | `/api/agents` | the catalogue and each agent's grants, read-only |
| GET/POST/PUT/DELETE | `/api/mcp/servers` | tool servers |
| POST | `/api/mcp/servers/:key/test` | connect and discover tools |
| GET/PUT/DELETE | `/api/mcp/grants` | the grant matrix |
| GET | `/api/mcp/calls` | the tool-call audit trail |
| GET/POST | `/api/projects` | list, create |
| GET | `/api/projects/:key` | overview, counts, spend, gates |
| POST | `/api/projects/:key/documents` | add source material |
| POST | `/api/projects/:key/start` | start the pipeline (also `pause`, `resume`, `cancel`) |
| GET | `/api/projects/:key/{requirements,stories,architecture,code,qa,events}` | what the agents produced |
| GET | `/api/approvals` | gates waiting on a person |
| POST | `/api/approvals/:id/decide` | approve, reject, or request changes |
| GET | `/api/runs` | every agent execution, with cost, tools and provenance |

## What it does not do

It does not merge, deploy or release. It does not retry a failed model call on a different provider
— one entitlement is active, and a failure is reported rather than quietly re-billed elsewhere. It
does not retrieve context by embedding similarity; the whole project state goes in the prompt.

QA runs the tests it can actually run. With no browser or shell server granted it reports cases as
**not run** rather than passing them, and says so on the gate.


Claude Login
docker compose exec backend claude auth login
