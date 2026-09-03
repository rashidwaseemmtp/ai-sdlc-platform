# 08 — Human Approval Engine

Approval is a workflow primitive, not a UI feature bolted on afterwards. The workflow *suspends* —
durably, indefinitely, across restarts — until a human decides.

## 1. The protocol

```
WORKFLOW (worker)                API (nest)                 HUMAN (dashboard)
─────────────────                ──────────                 ─────────────────
setHandler(approvalSignal)
        │
createApprovalRequest ──────────▶ INSERT approval_requests
        │                         status=PENDING            ┌── GET /approvals (inbox)
        │                         emit APPROVAL_REQUESTED ───┤    artifact + diff + summary
        │                                                    │    + risks + warnings
   condition(decided, timeout)                               │
        │  … hours or days … process restarts are fine …     │
        │                                                    ▼
        │                        POST /approvals/:id/decide ◀── Approve / Reject /
        │                         ├─ 1. authorize role           Request changes + comment
        │                         ├─ 2. INSERT approval_decision
        │                         ├─ 3. UPDATE request status
        │                         └─ 4. handle.signal(approval, payload)
        │                                     │
        ◀────────────────────────────────────┘  Temporal delivers (buffered if worker is down)
   resume with decision
```

Steps 2–3 are one transaction; step 4 is after commit. If the API dies between them, the decision is
still durably recorded and the workflow's timeout-path `reconcileApproval` activity picks it up — the
signal is the fast path, the DB is the truth.

`setHandler` is registered **before** the request row exists, so an instant approval cannot race ahead
of the handler.

## 2. States

```
                 ┌──────────► APPROVED ──────► workflow continues
                 │
 PENDING ────────┼──────────► REJECTED ──────► project parks, HUMAN_INTERVENTION_REQUIRED
     │           │
     │           └──────────► CHANGES_REQUESTED ──► bounded revision loop ──► new PENDING
     │
     └── timeout ──────────► EXPIRED ──────────► project parks, notification sent
```

`CHANGES_REQUESTED` carries structured feedback, not just a comment:

```ts
interface ChangeRequest {
  target: { kind: 'story' | 'criterion' | 'option' | 'estimate' | 'section'; ref: string };
  instruction: string;
  severity: 'MUST' | 'SHOULD' | 'CONSIDER';
}
```

The revising agent receives these as typed input alongside the previous artifact version — it does not
re-read a chat thread.

## 3. The seven gates (doc 35)

| Key | After | Required role | Default timeout | Artifact shown |
|---|---|---|---|---|
| `backlog` | BA produces backlog draft | `PRODUCT` | 72 h | `backlog-vN` + per-story diff |
| `architecture` | Critic scores options | `ARCHITECT` | 72 h | 3 options + scorecard + recommendation |
| `estimation` | Estimator + independent estimator | `PRODUCT` | 48 h | estimates + variance report |
| `dev-readiness` | Resource + delivery plan | `PRODUCT` | 48 h | plan, milestones, critical path |
| `pr` | CI + AI review + security review | `ENGINEER` | 72 h | PR diff + review findings |
| `qa` | Playwright run + QA report | `QA` | 48 h | results, evidence, open bugs |
| `release` | All stories done | `ADMIN` | 168 h | release notes + full trace |

Every gate row in `approval_gates` is per project and carries `enabled`, `requiredRole`,
`timeoutHours`, `autoApprove`. Disabling a gate is allowed and audited; `autoApprove` is off
everywhere by default and is itself an admin-only change.

Story-level granularity: the backlog gate supports approving, rejecting, editing and regenerating
**individual stories** as well as the batch (doc 10). The gate resolves only when every non-rejected
story is `APPROVED`.

## 4. What the approver sees (doc 54)

Never raw chain-of-thought (I9). The approval payload is assembled by the API:

```ts
interface ApprovalPresentation {
  artifact: { kind; version; content };
  diff?: StructuredDiff;                 // vs the previously approved version
  decisionSummary: {                     // the agent's auditable rationale
    summary; evidence: ArtifactRef[]; assumptions; risks; tradeoffs;
    openQuestions; confidence;
  };
  qualityWarnings: QualityWarning[];     // soft check failures
  provenance: { agent; agentVersion; promptVersion; model; provider; cost; durationMs };
  lineage: ArtifactRef[];                // what this was derived from — clickable
  actions: ('APPROVE'|'REJECT'|'REQUEST_CHANGES'|'COMMENT')[];
}
```

`provenance` matters as much as content: an approver should be able to see that an architecture was
produced by `architect v3` on `claude-opus-5` with prompt `architect/v2.md@sha`, costing $0.81, and
that its critic ran on a *different* model.

## 5. Timeouts, escalation, delegation

- Timeout is per gate; on expiry the request becomes `EXPIRED`, the project parks, and a notification
  fires. Nothing auto-approves on timeout, ever.
- `REMIND_AFTER_HOURS` sends a reminder without changing state.
- A pending request can be reassigned to another user holding the required role.
- `EXPIRED` is recoverable: an admin reopens the gate, which creates a fresh request and re-signals.

## 6. Human intervention requests

Distinct from approvals but sharing the mechanism. When a workflow parks (budget exceeded, iteration
cap hit, invalid output, permission denied, MCP unavailable), it creates an intervention request
carrying the failure context and waits on a signal with actions: `RETRY`, `RETRY_WITH_CHANGES`,
`SKIP_STORY`, `ABORT_PHASE`, `RAISE_BUDGET`. This is what keeps a bounded-autonomy system usable: it
stops, explains, and waits, rather than either looping forever or dying.

## 7. Anti-patterns explicitly rejected

| Rejected | Why | Instead |
|---|---|---|
| Polling `approval_requests` on a timer | Doesn't survive restarts cleanly, wastes DB, unbounded latency | Temporal signal + `condition()` |
| Auto-approve on timeout | Silently removes the control the whole design exists to provide | Expire and park |
| Approving with no artifact version pinned | The human approves text that may have since changed | `approval_requests.artifactVersionId` is required and immutable |
| Free-text-only change requests | Unusable as agent input; loses traceability | Structured `ChangeRequest[]` plus optional prose |
| Unbounded revision loops | Burns budget, never converges | `MAX_*_REVISIONS` then park |
