# 14 — Testing Strategy

Hard rule (doc 64): **the test suite never depends on paid APIs.** `pnpm test` runs offline, in CI,
with no credentials, and covers the whole pipeline.

## 1. Tiers

| Tier | Runner | Scope | Speed |
|---|---|---|---|
| Unit | Vitest | `domain`, `shared`, router selection, permission engine, budget guard, context packing | ms |
| Schema/contract | Vitest | Every agent input/output schema against golden fixtures | ms |
| Workflow replay | `@temporalio/testing` | Determinism of every workflow against recorded histories | fast |
| Workflow behaviour | `TestWorkflowEnvironment` | Time-skipped runs: approvals, timeouts, retries, iteration caps | seconds |
| Integration | Vitest + testcontainers | API ↔ Postgres ↔ Redis ↔ Temporal with mock providers | tens of seconds |
| MCP contract | Vitest | Each MCP server against the shared capability contract | seconds |
| E2E | Playwright | Dashboard drives the full demo pipeline, gates included | minutes |

## 2. Mock providers (doc 65)

| Mock | Behaviour |
|---|---|
| `MockModelProvider` | Replays recorded responses keyed by `sha256(prompt+context+tools)`. Unknown key → loud failure, never a silent invention. Can inject malformed output, refusals, rate limits, timeouts |
| `MockMCPServer` | Serves any capability contract from fixtures; can simulate unhealthy, slow, and permission-denied |
| `MockGitHub` | In-memory repos, branches, commits, PRs, checks, reviews |
| `MockFigma` | Fixture design tree; also the "not configured" path |
| `MockPlaywright` | Scripted pass/fail results with synthetic evidence files |

Mocks are selected by configuration, so tests exercise the **real** code path — the same runtime,
router, manager and workflows that production uses.

## 3. Workflow testing

Two distinct things, both required:

**Replay tests** guard determinism. Recorded histories live in `tests/fixtures/histories/`; any code
change that would break replay fails CI. This is the only reliable defence against a `Date.now()` or a
stray import creeping into workflow code.

```ts
it('ArchitectureWorkflow replays', async () => {
  const history = await loadHistory('architecture-happy-path.json');
  await Worker.runReplayHistory({ workflowsPath: WORKFLOWS }, history);   // throws on non-determinism
});
```

**Behaviour tests** use the time-skipping environment, so a 72-hour approval timeout tests in
milliseconds:

```ts
it('parks the project when the backlog gate expires', async () => {
  const handle = await env.client.workflow.start(BacklogWorkflow, { ... });
  await env.sleep('73 hours');                       // skipped, not waited
  expect(await handle.query(getState)).toMatchObject({ status: 'APPROVAL_TIMEOUT' });
});

it('caps PR fix iterations at 3', async () => {
  // reviewer always requests changes
  await expect(handle.result()).resolves.toMatchObject({ outcome: 'HUMAN_INTERVENTION_REQUIRED',
                                                         iterations: 3 });
});
```

Every bounded loop in the system has a test that proves the bound.

## 4. Agent contract tests

Per agent:

1. **Schema round-trip** — recorded good outputs parse; each known-bad output is rejected with a
   useful error.
2. **Golden fixture** — fixed project state + recorded model responses ⇒ stable artifact. Diffs are
   reviewed like code, which is how prompt changes stay honest.
3. **Quality checks** — each check tested against passing and failing inputs.
4. **Permission negative tests** — the agent attempting an ungranted tool gets `PERMISSION_DENIED`
   and an audit row. Notably: *no agent can merge a PR* is a test, not a policy statement.

## 5. Invariant tests

The doc-00 invariants are executable:

| Invariant | Test |
|---|---|
| I1 determinism | Replay suite + lint rule test |
| I2 validation | Fuzz the persistence path with invalid payloads; all rejected |
| I3 immutability | `UPDATE` on an approved artifact version raises at the DB level |
| I4 payload size | Oversized activity payload rejected by the interceptor |
| I5 tool permissions | Ungranted call denied for every agent × server pair |
| I6 budget caps | Runaway tool loop halts at `maxIterations` and `maxCostUsd` |
| I7 no AI merge | Merge attempt is 403 with `AI_MERGE_PERMISSION=false` |
| I8 capability floor | Router raises `NoEligibleModelError` rather than downgrading below the floor |
| I9 no CoT | Persisted artifacts and API responses contain no reasoning field |
| I10 lineage | Every artifact version has lineage edges matching the run's `inputRefs` |

## 6. E2E

One Playwright spec walks the demo project through every gate:

```
create project → import notes → run discovery → assert requirements traceable
  → run backlog → assert GWT criteria + quality flags
  → request changes on a story → assert only that story is revised
  → approve backlog
  → run architecture → assert 3 options + critic scorecard + recommendation
  → approve → assert ADR-001 is immutable (attempt an edit, expect refusal)
  → run estimation → assert confidence + range present, variance flagged
  → approve plan
  → develop a story → assert PR created with full body, merge button disabled
  → approve PR
  → run QA → assert evidence attached, one bug created, fix loop bounded, re-run passes
  → approve QA → assert full trace from test case back to the meeting sentence
```

That last assertion is the real acceptance test for the whole platform.

## 7. Coverage and CI

- Coverage gates: `domain` and `shared` ≥ 90%; runtime, router, manager, workflows ≥ 80%; UI
  untargeted (E2E covers it).
- CI: lint → typecheck → unit → schema → replay → workflow → integration (testcontainers) → build →
  E2E. Every job runs with `DEMO_MODE=true` and no secrets available.
- A nightly optional job runs a small **live smoke test** against one real provider when a key is
  present, and is allowed to fail without blocking — real-provider drift should be visible, not
  load-bearing.
