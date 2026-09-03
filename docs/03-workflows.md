# 03 — Temporal Workflow Design

## 1. Workflow hierarchy

`ProjectWorkflow` is the long-lived parent. It is the only workflow a human starts directly; it owns
the project lifecycle and spawns phase children.

```
ProjectWorkflow  (long-running, one per project, id = project-{projectKey})
│
├── DiscoveryWorkflow          ingest docs → PO Agent → requirements-v1
├── BacklogWorkflow            BA Agent → backlog-v1 → [GATE backlog] ⇄ revision loop
├── ArchitectureWorkflow       Architect (3 options, parallel) → Critic → recommendation
│                              → [GATE architecture] → ADR
├── EstimationWorkflow         Estimator ∥ IndependentEstimator → variance → [GATE estimation]
├── ResourcePlanningWorkflow   Resource Planner → plan
├── DeliveryPlanningWorkflow   Delivery Planner → milestones/tasks → [GATE dev-readiness]
│
├── DevelopmentWorkflow        fan-out over the dependency DAG
│   ├── StoryWorkflow (US-101)
│   ├── StoryWorkflow (US-102)   ← run in parallel when dependencies allow
│   └── StoryWorkflow (US-103)
│         ├── CodeReviewWorkflow   CI → AI review → security review → [GATE pr]
│         ├── QAWorkflow           test gen → Playwright → report → [GATE qa]
│         └── BugFixWorkflow       (child of QA on failure, bounded iterations)
│
└── ReleaseWorkflow            release notes → [GATE release]
```

Child workflows use `ParentClosePolicy.REQUEST_CANCEL` so cancelling a project stops the tree, and
`workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY'` so a retriable phase can be relaunched by key.

Deterministic workflow IDs — this is how the API finds a running workflow without a lookup table:

| Workflow | ID |
|---|---|
| Project | `project-{projectKey}` |
| Phase | `project-{projectKey}-{phase}` |
| Story | `project-{projectKey}-story-{storyRef}` |
| Code review | `project-{projectKey}-story-{storyRef}-review-{n}` |
| QA | `project-{projectKey}-story-{storyRef}-qa-{n}` |

## 2. Determinism rules (invariant I1)

Workflow files may import **only**:

- `@temporalio/workflow`
- activity *type* imports (`import type { Activities }`)
- pure helpers from `packages/workflows/lib` (no I/O, no clock, no randomness)

Everything else is an activity. Concretely, these all live in activities and never in workflow code:

| Forbidden in workflows | Use instead |
|---|---|
| LLM calls | `runAgent` activity |
| Prisma / SQL | `db.*` activities |
| GitHub, Figma, Playwright, MCP | tool activities on `sdlc-tools` / `sdlc-heavy` |
| `fetch`, `fs`, `child_process` | activities |
| `Date.now()`, `new Date()` | `workflow.now()` |
| `Math.random()`, `uuid()` | `workflow.uuid4()` |
| `setTimeout` | `workflow.sleep()` |
| Reading env vars | passed in as workflow args |

Enforcement: an ESLint config scoped to `packages/workflows/**` bans those imports and globals, and
every workflow ships a replay test against recorded histories (doc 14).

## 3. Approval as a workflow primitive

No polling anywhere. The pattern, used identically at all seven gates:

```ts
// packages/workflows/lib/approval.ts  (pure workflow helper)
export async function waitForApproval(
  gate: GateKey,
  ctx: { projectId: string; artifactRef: ArtifactRef; timeoutHours: number },
): Promise<ApprovalOutcome> {
  let decision: ApprovalOutcome | undefined;

  // Signal handler is registered before the request is created — no race.
  setHandler(approvalSignal, (d) => { if (d.gate === gate) decision = d; });

  const requestId = await acts.createApprovalRequest({ gate, ...ctx });

  const settled = await condition(
    () => decision !== undefined,
    `${ctx.timeoutHours}h`,
  );

  if (!settled) {
    // Belt and braces: the API may have committed a decision but died before signalling.
    const reconciled = await acts.reconcileApproval(requestId);
    if (reconciled) return reconciled;
    await acts.expireApprovalRequest(requestId);
    return { decision: 'EXPIRED' };
  }
  return decision!;
}
```

`setHandler` is registered **before** `createApprovalRequest`, so a human approving within
milliseconds cannot lose the signal. Signals sent while the worker is down are buffered by Temporal
and delivered on resume.

`ApprovalOutcome.decision ∈ { APPROVED, REJECTED, CHANGES_REQUESTED, EXPIRED }`. `CHANGES_REQUESTED`
carries `changeRequests` that feed the revision loop.

## 4. Workflow catalogue

### 4.1 `ProjectWorkflow`

Long-running, uses `continueAsNew` when history exceeds ~10k events (a year-long project will).

Signals: `advancePhase`, `pauseProject`, `resumeProject`, `cancelProject`, `approval`,
`humanIntervention`, `reconfigure`.
Queries: `getState` → `{ phase, activeChildren, pendingApprovals, spend, lastError }`.

### 4.2 `DiscoveryWorkflow`

```
for each unprocessed source_document:  acts.ingestDocument (chunk + embed)  [parallel, limit 4]
  → acts.runAgent('product-owner')
  → acts.persistRequirements
  → emit REQUIREMENTS_CREATED
```

### 4.3 `BacklogWorkflow` — the revision loop

```
runAgent('business-analyst') → backlog-v1 → status BACKLOG_DRAFT
        ↓
waitForApproval('backlog')
        ↓
   APPROVED ──────────────────────────────► BACKLOG_APPROVED, return
   REJECTED ──────────────────────────────► park, HUMAN_INTERVENTION_REQUIRED
   CHANGES_REQUESTED ─► iteration++ ─► if iteration > MAX_BACKLOG_REVISIONS → park
                                        else runAgent('business-analyst', {mode:'revise',
                                             changeRequests, previousVersion}) → loop
```

The revision run receives the reviewer comments **and** the previous backlog version as artifact
refs — not as a re-pasted prompt.

### 4.4 `ArchitectureWorkflow`

```
Promise.all([
  runAgent('architect', {variant:'A', bias:'pragmatic'}),
  runAgent('architect', {variant:'B', bias:'scalable'}),
  runAgent('architect', {variant:'C', bias:'cost-optimised'}),
])                                    ← three genuinely different briefs, run in parallel
  → runAgent('architecture-critic', {optionRefs})     ← different agent, enforced
  → acts.computeRecommendation(weights)
  → waitForApproval('architecture')
  → acts.createAdr(approvedOptionRef)                 ← immutable
```

If the critic scores every option below `ARCHITECTURE_MIN_SCORE`, the workflow requests a regeneration
round (bounded by `MAX_ARCHITECTURE_ROUNDS`) instead of presenting weak options for approval.

### 4.5 `EstimationWorkflow`

```
Promise.all([ runAgent('estimator',{kind:'PRIMARY'}),
              runAgent('estimator',{kind:'INDEPENDENT', model:'different-provider'}) ])
  → acts.computeVariance()
  → variance > ESTIMATION_VARIANCE_THRESHOLD (default 30%)
        ? status = ESTIMATION_REVIEW_REQUIRED  (mandatory human review)
        : proceed
  → waitForApproval('estimation')
```

The independent estimator is routed to a **different provider** where the fallback chain allows, so
the two estimates are not correlated by model.

### 4.6 `DevelopmentWorkflow` — dependency-aware fan-out

```
plan = acts.topologicalOrder(storyDag)      // deterministic, pure activity result
waves = plan.waves                          // stories with no unmet deps
for wave of waves:
   await Promise.all(wave.map(story =>
       executeChild(StoryWorkflow, {
         workflowId: `project-${key}-story-${story.ref}`,
         args: [{ storyId: story.id }],
       })))
```

Concurrency is capped by `MAX_PARALLEL_STORIES` using a semaphore built from `condition()` — not by
sleeping.

### 4.7 `StoryWorkflow`

```
acts.buildDevelopmentContextPackage(storyId)     // story, AC, ADR, code, Figma, standards
  → acts.runAgent('developer', {phase:'plan'})   // implementation plan artifact
  → acts.runAgent('developer', {phase:'implement'})
        ↳ tools: filesystem(jailed), github MCP, figma MCP
  → acts.runQualityGates()                        // typecheck, lint, unit, build
        ↳ fail → developer fix, bounded by MAX_BUILD_FIX_ITERATIONS
  → acts.createPullRequest()                      // never merges
  → executeChild(CodeReviewWorkflow)
  → executeChild(QAWorkflow)
  → story.status = DONE
```

### 4.8 `CodeReviewWorkflow`

```
acts.waitForCi(prId)  ← polls via activity retry, not a workflow loop
  → runAgent('code-reviewer')
  → runAgent('security-reviewer')
  → waitForApproval('pr')
       CHANGES_REQUESTED → iteration++ (cap MAX_PR_FIX_ITERATIONS = 3)
            → runAgent('developer',{phase:'address-review'}) → push → loop
       exceeded → HUMAN_INTERVENTION_REQUIRED
```

CI waiting is an activity with a retry policy and heartbeats, so the workflow history stays small.

### 4.9 `QAWorkflow`

```
runAgent('qa', {phase:'design-tests'})    → test_cases
  → runAgent('qa', {phase:'automate'})    → Playwright specs committed to the repo
  → acts.runPlaywright()                  → sdlc-heavy queue, evidence to storage
  → runAgent('qa', {phase:'analyse'})     → QA report
  → pass  → waitForApproval('qa')
  → fail  → executeChild(BugFixWorkflow) (cap MAX_QA_FIX_ITERATIONS = 3) → re-run
```

### 4.10 `BugFixWorkflow`

```
runAgent('bug-analyzer')  → bug records + root-cause hypothesis
  → runAgent('developer', {phase:'fix', bugRefs})
  → acts.runQualityGates() → acts.updatePullRequest()
  → return control to QAWorkflow for re-test
```

## 5. Retry policies

Defined once in `packages/workflows/lib/retry.ts` and applied per activity group.

| Activity group | maxAttempts | initial | backoff | max interval | Non-retryable |
|---|---|---|---|---|---|
| LLM / agent | 3 | 5 s | 2.0 | 60 s | `INVALID_OUTPUT`, `BUDGET_EXCEEDED`, `NoEligibleModelError`, `PERMISSION_DENIED` |
| Database | 5 | 200 ms | 2.0 | 5 s | `ValidationError`, `UniqueConstraint` |
| GitHub API | 5 | 2 s | 2.0 | 60 s | `NotFound`, `Forbidden`, `PERMISSION_DENIED` |
| Figma API | 3 | 2 s | 2.0 | 30 s | `NotFound`, `Forbidden` |
| MCP generic | 3 | 1 s | 2.0 | 20 s | `MCP_DISABLED`, `PERMISSION_DENIED` |
| Playwright | 2 | 10 s | 2.0 | 60 s | `BUILD_FAILED` |
| Build / test / typecheck | 1 | — | — | — | all (failures are *results*, not errors) |
| Approval activities | 3 | 1 s | 2.0 | 10 s | `GateDisabled` |
| Human approval wait | **none** | — | — | — | never auto-retried |

Timeouts: `startToCloseTimeout` per group (LLM 20 min with 30 s heartbeat; Playwright 30 min;
DB 30 s), `scheduleToCloseTimeout` bounding total retry span.

## 6. Failure taxonomy

Every failure maps to exactly one of these, and the mapping decides retry behaviour:

| Code | Retryable | Result |
|---|---|---|
| `AGENT_FAILED` | yes | activity retry |
| `INVALID_OUTPUT` | no | one repair attempt inside the runtime, then park |
| `MODEL_UNAVAILABLE` | yes | router fallback first; park if chain exhausted |
| `TOOL_FAILED` | yes | activity retry |
| `MCP_UNAVAILABLE` | conditional | transient → retry; disabled → park or degrade |
| `PERMISSION_DENIED` | no | park — never retried, always audited |
| `BUILD_FAILED` / `TEST_FAILED` | no | a *result*, drives the bounded fix loop |
| `PR_FAILED` | yes | retry then park |
| `APPROVAL_TIMEOUT` | no | gate expires, project parks |
| `BUDGET_EXCEEDED` | no | park with spend report |
| `HUMAN_INTERVENTION_REQUIRED` | n/a | terminal-until-human; workflow stays alive awaiting a signal |

Parking never kills the workflow. It sets project state, emits an event, creates an approval-style
intervention request, and waits on a signal — so a human can unblock and resume hours later.

## 7. Versioning

Workflow code changes use `patched()` / `deprecatePatch()`; task-queue-wide breaking changes use
Temporal Worker Versioning with build IDs. Every workflow declares
`export const WORKFLOW_VERSION = n` recorded in `workflow_runs` for forensics.

## 8. Budget enforcement in workflows

`ProjectWorkflow` maintains a running spend total updated by every `runAgent` return value. Before
scheduling any agent activity it checks `spend + estimatedCost <= MAX_WORKFLOW_COST`; exceeding it
parks the project rather than truncating work silently. Per-story and per-agent ceilings are enforced
inside the runtime by `BudgetGuard` (doc 04).
