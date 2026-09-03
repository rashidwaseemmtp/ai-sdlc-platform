# Resume here

Working state as of the last session. Everything below was verified running, not just written.

---

## Where we stopped

**Building the platform: done and verified end to end.**
**Repo created and committed locally** — `rashidwaseemmtp/ai-sdlc-platform`, initial commit on
`main` with `origin` wired. **Next task: `git push -u origin main`** — left to you
deliberately (see [Next step](#next-step)).

---

## Current state: verified working

| Check | Result |
|---|---|
| Full pipeline (`pnpm demo`) | **COMPLETED** — 31 agent runs, 0 failures, 171,890 tokens |
| Tests | **125 passing** across 6 suites |
| Typecheck | 18/18 packages and apps clean |
| Lint (determinism firewall) | clean; proven to catch violations |
| DB invariants vs real Postgres | 5/5 rejected deliberate violations |
| Services | API healthy, worker running, all 7 dashboard pages rendering real data |

A clean `pnpm demo` run produces:

```
Customer Management SaaS (CMS) — phase COMPLETED
  requirements 7   stories 3   arch options 3   ADRs 1
  estimates 6      pull requests 3
  test cases 21    results 21   bugs 0
```

Full trace resolves: `Discovery call — 12 March → REQ-001 → US-101 → TC-10100`

---

## Next step

**Push the initial commit.** The repo exists at
<https://github.com/rashidwaseemmtp/ai-sdlc-platform> (created by you, 3 Sep 2026). Local git is
initialized on `main`, `origin` points at it, and the initial commit holds all 201 files. Nothing
has been pushed yet — that is yours to run:

```bash
git push -u origin main
```

Credentials: `gh` 2.98.0 is installed but not logged in. Either `gh auth login`, or let Git
Credential Manager prompt on first push.

Pre-push audit (done): `.gitignore` covers `node_modules/`, `dist/`, `.env`, `.workspace/`,
`.artifacts/`, `.secrets/`; every sensitive value in `.env` is empty, so no secret is in the tree;
`.gitattributes` added so the repo stores LF regardless of Windows checkouts.

### Decisions still open

1. **Repo visibility** — set when you created it; nothing here depends on it.
2. **Demo repos** — `cms-api` and `cms-web` are *not* created. Deferred deliberately; scope for this
   round was the platform only.
3. **Wire the demo to real GitHub?** Still open. The seed points at `MOCK` provider repos
   (`https://mock.github/acme/cms-api`, `.../cms-web`). Creating the demo repos for real would let
   us switch `provider: MOCK` → `GITHUB` in `packages/database/src/seed.ts` and set
   `mcp.servers.github.enabled: true` in `config/mcp.yaml` — closing the known gap that **the
   GitHub MCP path has only ever run against the mock**.

---

## Restarting the environment

```bash
pnpm infra:up      # Postgres (:5433), Redis, Temporal (:7233), Temporal UI (:8233)
pnpm doctor        # verify everything is reachable
pnpm dev           # worker + API + dashboard together
pnpm demo          # run the pipeline
pnpm stop          # stop worker/API processes (cross-platform; pkill does not work here)
```

If the pipeline behaves strangely, **check for stale workers first** — that cost real debugging time
last session:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/main.ts*' } | Select-Object ProcessId
```

Multiple workers on the same task queue silently steal each other's activities and produce a
baffling mix of passes and failures. `pnpm stop` handles it.

### Left running last session

Docker containers, plus worker / API / dashboard dev processes. Run `pnpm stop` and
`pnpm infra:down` if you want the machine quiet.

---

## Repository map

```
apps/         api (NestJS) · worker (Temporal) · dashboard (Next.js)
packages/     shared (+ shared/node) · database · observability
              ai/{core,providers,router}   provider-agnostic model layer
              mcp/{core,manager,servers}   MCP layer, permissions, mocks
              context · domain             retrieval; pure business rules
              agents/{runtime,catalog}     12-step loop; 13 agent contracts
              workflows                    DETERMINISTIC ONLY
              activities                   ALL side effects
prompts/      13 versioned agent prompts, pinned per run
config/       models · mcp · agents · workflows · security
docs/         16 documents — start at docs/00-overview.md
```

**Read `docs/15-implementation-notes.md` before extending anything.** It records the six real bugs
the build surfaced (inert retry classification, the `node:fs` firewall break, stale workers,
non-atomic upsert, swallowed tool errors, over-broad append-only trigger) and the three documented
deviations from the design.

---

## Known gaps (unchanged)

- **Real provider adapters have never run against live APIs.** Every end-to-end run used the mock
  provider. First contact with real credentials may need adjustment.
- **GitHub and Playwright are mocked.** Contracts and permission policy are exercised; real API
  semantics are not. (Creating the demo repos would start closing the GitHub half.)
- **No recorded-history replay tests.** A determinism regression would be caught by lint, not replay.
- **Auth is nominal** — role checks against the DB, no session layer. Not ready to expose.
- **Jira / Linear / Azure DevOps backends** are contract-defined and unimplemented.
- **The evaluation framework** (docs/56 in the original brief) is not built.
