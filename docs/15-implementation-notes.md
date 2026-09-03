# 15 — Implementation Notes

What the build actually taught us. Every entry here is a place where the design document was
either wrong, incomplete, or right for a reason that only became visible under a running system.

## 1. Deviations from the design docs

| Design said | Built as | Why |
|---|---|---|
| One package per agent (`packages/agents/product-owner/`, …) | One `packages/agents/catalog` with one file per phase | Twelve packages of ~150 lines with identical dependency lists is boilerplate for its own sake. The *contracts* are still one-per-agent; only the packaging is shared. |
| One package per MCP server | `packages/mcp/servers` with `src/{product,ba,filesystem,mocks}` | Product, BA and filesystem servers all need the same database client. They still ship as separate `bin` entry points, so they are separate processes at runtime — which is the part that matters. |
| `@sdlc/shared` is the only import workflows need | Split into `@sdlc/shared` (types) and `@sdlc/shared/node` (config loader) | The config loader imports `node:fs`. The Temporal workflow bundler rejected it outright. See §2. |
| Activity task queues are constants | `activityOptions(prefix)`, with `queuePrefix` a workflow input | A test worker and the dev worker both polled `sdlc-main` and silently stole each other's activities. See §2. |
| Native `@google/genai` adapter | Gemini via its own OpenAI-compatible endpoint | Google publishes and supports that surface. One fewer SDK, same provider independence; swapping in a native adapter touches one file. |

## 2. Bugs the build found

These are worth recording because each one was invisible in design and obvious in operation.

### The determinism firewall was real, and `@sdlc/shared` violated it

Workflow code imported `@sdlc/shared`, whose index re-exported a config loader that reads files.
Webpack refused to bundle `node:fs` for the workflow sandbox and the worker would not start.

The fix was the right one rather than a workaround: `@sdlc/shared` now exports types only, and
everything with I/O moved to `@sdlc/shared/node`. The ESLint config in `eslint.config.js` now bans
that import from workflow code, and a deliberate violation is a build error.

### `nonRetryableErrorTypes` matched nothing

Temporal decides retryability by matching `ApplicationFailure.type` against the activity's
`nonRetryableErrorTypes`. A plain `Error` never matches. Our `PlatformError` was a plain `Error`,
so **the entire non-retryable classification in docs/03 §5 was inert**: a `PERMISSION_DENIED` was
retried three times, and an `INVALID_OUTPUT` burned budget re-running a deterministic failure.

`packages/activities/src/failure.ts` now converts every thrown `PlatformError` into a typed
`ApplicationFailure`, and `createActivities` wraps every activity so no one has to remember.

### Four stale workers, one task queue

`pkill -f` does not reach Windows processes from Git Bash. Four workers from earlier runs kept
polling, and identical agents produced a bewildering mix of passes and failures depending on which
worker happened to pick up the activity. `pnpm stop` is now cross-platform, and the workflow tests
isolate themselves with a queue prefix so they can never contend with a dev worker.

### `upsert` is not atomic

Three architects run in parallel and raced to insert the same `prompt_versions` row. `upsert` lost.
The runtime now reads, creates optimistically, and treats a unique-constraint loss as a win — which
is what "idempotent under concurrency" actually requires.

### Tool errors were being swallowed

`callTool` returned `{ isError: true }` and the platform-initiated call sites ignored it, so a
failed `create_branch` produced a `create_pull_request` with `number: undefined` and a Prisma
validation error three steps later. Platform calls now pass `throwOnToolError: true` and fail at the
point of failure. Agent tool loops deliberately still receive errors as values — there, an error is
feedback the model should adapt to.

### The append-only trigger blocked project deletion

`domain_events` was append-only for `UPDATE` *and* `DELETE`, so deleting a project failed on the
cascade. The trigger now blocks edits always, and blocks deletes only while the parent project
still exists — an admin deleting a project is lifecycle; erasing an audit trail under a live project
is tampering. Both cases have a test.

### Test-case refs collided across stories

The demo QA handler derived refs from the criterion index alone, so three stories all produced
`TC-10`…`TC-12` and upsert moved ownership to whoever ran last. Refs now incorporate the story
number. The lesson generalises: any ref that is unique *per project* must be derived from something
project-unique.

## 3. Things that worked as designed

- **Blinded architecture critique.** Options reach the critic author-blind with shuffled labels.
  When the demo critic scored by label position the winner was effectively random — visible
  immediately, because the recommended option kept changing. Once it scored *content*, the modular
  monolith won 8.0 to 5.6 against event-driven microservices, which is the right answer for a
  seven-story backlog.
- **Database-enforced invariants.** Approved artifacts, ADR immutability, critic independence and
  estimate ranges are all enforced by triggers and check constraints. Every one of them rejected a
  deliberate violation on the first try.
- **Reference-passing.** No document body ever crossed a workflow boundary. When the reviewers
  needed the developer's change set, the fix was to pass the artifact ref and have the Context
  Engine read it — not to widen the payload.

## 4. Verified end to end

A single command (`pnpm demo`) takes the seeded project from two meeting documents to a completed
pipeline, with no credentials:

```
requirements 7   stories 3   arch options 3   ADRs 1
estimates 6      pull requests 3
test cases 21    results 21   bugs 0
31 agent runs, 0 failures, 171,890 tokens
```

Four human approval gates were requested and answered through the same write-then-signal path the
dashboard uses. The full trace resolves:

```
Discovery call — 12 March → REQ-001 → US-101 → TC-10100
```

## 5. Known gaps

Honest list of what is not done:

- **Real provider adapters are untested against live APIs.** The Anthropic, OpenAI-compatible and
  Claude-subscription adapters are written against current documented surfaces and typecheck, but
  every end-to-end run so far has used the mock provider. First real-credential run may need
  adjustment.
- **Playwright is mocked.** The QA workflow drives the MCP contract correctly, but no real browser
  has run. Swapping `backend: mock` for the real Playwright MCP is a config change; whether the
  generated specs are good is unproven.
- **GitHub is mocked.** Same shape: the contract and the permission policy are exercised, real API
  semantics are not.
- **No replay tests yet.** The behaviour tests cover gates and bounded loops. Recorded-history
  replay tests (docs/14 §3) are not written, so a determinism regression would be caught by the
  lint rule but not by a replay.
- **Auth is nominal.** The API checks roles against the database but has no session layer; it is
  local-first as designed, and is not ready to be exposed.
- **Jira/Linear/Azure DevOps backends** are contract-defined and unimplemented.
- **The evaluation framework** (docs/56) is not built.
