# 10 — API Specification

NestJS, REST, OpenAPI 3.1 at `/api/docs` (generated from Zod schemas via `nestjs-zod`, so the spec
cannot drift from validation). Base path `/api/v1`. SSE for live updates.

## 1. Conventions

- Auth: session cookie (dashboard) or `Authorization: Bearer <token>` (programmatic).
- Every body validated by Zod; failures return `422` with a field-level error array.
- List endpoints: `?page&pageSize&sort&filter[...]`, responses `{ data, page, pageSize, total }`.
- Mutations that start or affect a workflow return `{ workflowId, runId }` alongside the resource.
- Errors: RFC 9457 problem+json with a stable `type` matching the doc-58 failure taxonomy.
- Idempotency: `Idempotency-Key` honoured on all POSTs that start workflows.

## 2. Endpoints

### Projects
```
GET    /projects                          list
POST   /projects                          create (starts ProjectWorkflow)
GET    /projects/:id                      detail + phase + pipeline state
PATCH  /projects/:id                      rename, settings
DELETE /projects/:id                      archive (cancels workflow tree)
GET    /projects/:id/pipeline             the doc-52 visual pipeline state
GET    /projects/:id/trace                full lineage graph (doc 09 §6)
GET    /projects/:id/cost                 cost + quota rollup (doc 45)
POST   /projects/:id/advance              signal advancePhase (admin)
POST   /projects/:id/pause | /resume | /cancel
GET    /projects/:id/repositories         multi-repo (doc 51)
POST   /projects/:id/repositories
```

### Discovery
```
GET    /projects/:id/documents
POST   /projects/:id/documents            upload/import meeting notes, transcripts, specs
POST   /projects/:id/documents/:docId/reingest
DELETE /projects/:id/documents/:docId
POST   /projects/:id/discovery/run        start DiscoveryWorkflow
```

### Requirements
```
GET    /projects/:id/requirements         ?type&priority&status
POST   /projects/:id/requirements         human-authored
PATCH  /projects/:id/requirements/:reqId
GET    /projects/:id/requirements/:reqId/sources     traceability to document spans
GET    /projects/:id/product-vision | /business-goals | /stakeholders
GET    /projects/:id/business-rules | /constraints | /assumptions
GET    /projects/:id/open-questions       POST to answer
GET    /projects/:id/product-decisions
```

### Backlog
```
GET    /projects/:id/epics
GET    /projects/:id/stories              ?status&epicId&priority&label&flag
POST   /projects/:id/stories
GET    /projects/:id/stories/:storyId
PATCH  /projects/:id/stories/:storyId     human edits (creates a new artifact version)
POST   /projects/:id/stories/:storyId/approve | /reject | /request-changes
POST   /projects/:id/stories/:storyId/split
POST   /projects/:id/stories/merge
POST   /projects/:id/stories/:storyId/regenerate    ask the BA agent to revise this story
GET    /projects/:id/stories/:storyId/acceptance-criteria
PUT    /projects/:id/stories/:storyId/acceptance-criteria
GET    /projects/:id/backlog/quality      duplicates, ambiguity, oversized, missing AC
POST   /projects/:id/backlog/run          start BacklogWorkflow
```

### Architecture
```
GET    /projects/:id/architecture/options
GET    /projects/:id/architecture/options/:optionId
GET    /projects/:id/architecture/evaluations       critic scorecard
GET    /projects/:id/architecture/recommendation
POST   /projects/:id/architecture/run               start ArchitectureWorkflow
POST   /projects/:id/architecture/regenerate        bounded by MAX_ARCHITECTURE_ROUNDS
GET    /projects/:id/adrs  ·  GET /projects/:id/adrs/:number
```

### Estimation, resources, delivery
```
GET    /projects/:id/estimates            ?storyId — includes both estimator runs + variance
GET    /projects/:id/estimates/variance   the doc-15 review queue
POST   /projects/:id/estimation/run
GET    /projects/:id/resource-plan   ·  POST /projects/:id/resource-plan/run
GET    /projects/:id/delivery-plan   ·  POST /projects/:id/delivery-plan/run
GET    /projects/:id/milestones  ·  GET /projects/:id/tasks
```

### Development & PRs
```
POST   /projects/:id/development/run                start DevelopmentWorkflow
POST   /projects/:id/stories/:storyId/develop       single StoryWorkflow
GET    /projects/:id/pull-requests   ·  GET /pull-requests/:prId
GET    /pull-requests/:prId/diff  ·  /reviews  ·  /comments  ·  /checks
POST   /pull-requests/:prId/reviews                 human review verdict
POST   /pull-requests/:prId/merge                   403 unless AI_MERGE_PERMISSION + role
GET    /projects/:id/design-references               Figma links per story
```

### QA
```
GET    /projects/:id/test-cases           ?storyId&type&automationStatus
POST   /projects/:id/test-cases           human-authored
GET    /projects/:id/test-runs  ·  GET /test-runs/:runId
GET    /test-runs/:runId/results  ·  GET /test-results/:resultId/evidence
POST   /projects/:id/stories/:storyId/qa/run
GET    /projects/:id/bugs  ·  PATCH /bugs/:bugId
GET    /projects/:id/qa/report
```

### Approvals — the human-in-the-loop surface
```
GET    /approvals                         inbox: ?status&gate&projectId&assignedToMe
GET    /approvals/:id                     ApprovalPresentation (doc 08 §4)
POST   /approvals/:id/decide              { decision, comment?, changeRequests? }
POST   /approvals/:id/reassign
POST   /approvals/:id/reopen              admin, for EXPIRED
GET    /projects/:id/interventions        parked workflows awaiting a human
POST   /interventions/:id/resolve         { action: RETRY | RETRY_WITH_CHANGES | SKIP_STORY | ABORT_PHASE | RAISE_BUDGET }
GET    /projects/:id/approval-gates  ·  PATCH /projects/:id/approval-gates/:key
```

### Agents, runs, workflows, artifacts
```
GET    /agents                            definitions + current model binding
GET    /agents/:key  ·  PATCH /agents/:key         model policy, budget, permissions
GET    /agents/:key/prompts               prompt versions
POST   /agents/:key/prompts               new version (never overwrite)
GET    /agent-runs                        ?projectId&agentKey&status — the doc-53 activity view
GET    /agent-runs/:runId                 timeline, llm calls, tool calls, cost, output
POST   /agent-runs/:runId/cancel
GET    /workflows  ·  GET /workflows/:workflowId   status, history summary, pending signals
POST   /workflows/:workflowId/signal | /cancel | /terminate
GET    /projects/:id/artifacts   ·  GET /artifacts/:artifactId/versions
GET    /artifacts/:artifactId/versions/:version  ·  /diff?from&to
GET    /projects/:id/events               audit timeline
```

### Configuration
```
GET/PUT /settings                         global
GET/PUT /projects/:id/settings            project overrides
GET    /models/providers  ·  PUT /models/providers/:key      enable, secretRef, baseUrl
GET    /models/catalog    ·  PATCH /models/catalog/:id       enable, pricing, capabilities
POST   /models/catalog/sync               refresh from provider
GET/PUT /models/routing                   per-agent routing policies
POST   /models/test                       one-shot probe of a provider/model
GET    /mcp/servers  ·  POST /mcp/servers  ·  PATCH/DELETE /mcp/servers/:id
POST   /mcp/servers/:id/health  ·  POST /mcp/servers/:id/discover
GET    /mcp/servers/:id/tools             discovered schemas
GET/POST/DELETE /mcp/grants               agent ↔ tool permissions
GET    /secrets  ·  PUT /secrets/:ref     names only on read; write-only values
```

### Live updates
```
GET    /events/stream?projectId=…         SSE
```
Event frames mirror `domain_events` plus ephemeral progress:
`agent.started`, `agent.progress` (heartbeat: current step, tokens so far, elapsed),
`agent.completed`, `agent.failed`, `workflow.*`, `approval.requested`, `approval.decided`,
`pr.*`, `qa.*`, `cost.updated`.

SSE is chosen over WebSockets deliberately: the traffic is server→client only, it survives proxies,
and it reconnects with `Last-Event-ID` for free.

## 3. Example — the approvals inbox

```http
GET /api/v1/approvals?status=PENDING&assignedToMe=true
```
```json
{ "data": [ {
  "id": "apr_01J...", "gate": "architecture", "status": "PENDING",
  "project": { "id": "prj_01J...", "key": "CMS", "name": "Customer Management SaaS" },
  "requestedAt": "2026-09-02T10:14:22Z", "expiresAt": "2026-09-05T10:14:22Z",
  "artifact": { "kind": "architecture-recommendation", "version": 1 },
  "summary": "3 options evaluated; Option B (modular monolith) recommended, score 8.1/10",
  "warnings": [ { "severity": "MEDIUM", "message": "Option C scored below threshold on SECURITY (4/10)" } ],
  "requiredRole": "ARCHITECT",
  "provenance": { "agent": "architecture-critic", "model": "claude-opus-5", "costUsd": 0.31 }
} ], "page": 1, "pageSize": 20, "total": 1 }
```

```http
POST /api/v1/approvals/apr_01J.../decide
{
  "decision": "CHANGES_REQUESTED",
  "comment": "Option B is right, but justify the caching layer.",
  "changeRequests": [
    { "target": { "kind": "option", "ref": "B" },
      "instruction": "Add a caching strategy section covering invalidation for customer records",
      "severity": "MUST" }
  ]
}
```
→ `202 Accepted`, `{ "workflowId": "project-CMS-architecture", "signalled": true }`
