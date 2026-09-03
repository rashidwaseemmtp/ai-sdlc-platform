# 04 — Agent Architecture

## 1. An agent is a contract, not a prompt

```ts
// packages/shared/types/agent.ts
export interface AgentDefinition<I = unknown, O = unknown> {
  key: AgentKey;                  // 'business-analyst'
  version: number;                // bumped on any behavioural change
  name: string;
  role: string;                   // one-line charter, shown in the UI

  promptRef: PromptRef;           // { path: 'business-analyst/v2.md', sha256 }

  modelPolicy: ModelPolicy;       // capability requirements, NOT a vendor (doc 05)

  context: ContextRecipe;         // what this agent is allowed and required to see (doc 09)

  tools: ToolPermission[];        // native tools (structured output, code exec…)
  mcpServers: McpPermission[];    // per-server, per-tool, argument-scoped (doc 06)

  inputSchema: ZodSchema<I>;
  outputSchema: ZodSchema<O>;
  qualityChecks: QualityCheck<O>[];   // semantic validation beyond the schema

  maxRetries: number;
  timeoutSeconds: number;
  budget: AgentBudget;            // { maxCostUsd, maxTokens, maxToolCalls, maxIterations }

  permissions: AgentPermissions;  // domain-level RBAC (doc 07)
  writes: ArtifactKind[];         // artifact kinds this agent may create — enforced
}
```

`writes` is the teeth behind "agents never silently mutate unrelated project state": the persistence
layer rejects any artifact whose kind is not declared by the running agent.

## 2. The runtime loop

`AgentRuntime.execute(invocation)` — one Temporal activity, twelve steps, no branches that skip
validation or audit.

```
 1  LOAD        agent definition + prompt version (pinned, never "latest at read time")
 2  AUTHORIZE   invocation.permissions ⊆ definition.permissions, else PERMISSION_DENIED
 3  CONTEXT     ContextEngine.build(recipe, projectId, inputRefs) → ContextPackage
 4  ROUTE       ModelRouter.select(modelPolicy, taskComplexity) → ModelBinding
 5  BIND        McpManager.bindTools(definition, projectId) → ToolSet (deny-by-default)
 6  GUARD       BudgetGuard.open(budget, workflowCeilings)
 7  RENDER      messages = promptTemplate(contextPackage, input)   ← deterministic, hashed
 8  LOOP        while not final and guard.ok():
                  response = provider.generate(messages, tools)
                  record llm_call
                  for each tool_call: McpManager.callTool(...)  → record tool_call
                  heartbeat()
 9  PARSE       structured output → Zod parse
                  on failure → ONE repair turn with the validation errors → re-parse
                  still failing → INVALID_OUTPUT (non-retryable)
10  QUALITY     run qualityChecks → warnings attach to the artifact; hard failures park
11  PERSIST     transaction: artifact_version (immutable) + lineage + agent_run
                  + llm_calls + tool_calls + outbox event
12  RETURN      ArtifactRef  ← the only thing the workflow sees
```

Step 7 is deterministic given (prompt version, context package, input): the runtime records
`requestSha256` so a historical run can be reproduced exactly.

### Structured output

Preferred order per provider: native structured output / JSON schema mode → tool-call-shaped output →
fenced JSON with a parser. The provider adapter reports which mode it used; `llm_calls.finishReason`
records truncation so a cut-off JSON is retried with a larger `maxOutput` rather than "repaired" into
something plausible but wrong.

### Budget guard

```ts
interface AgentBudget {
  maxCostUsd: number;      // hard stop
  maxTokens: number;
  maxToolCalls: number;
  maxIterations: number;   // tool-loop turns — the anti-infinite-loop control (doc 59)
  maxWallClockSeconds: number;
}
```

The guard is checked before every provider call and every tool call. Breaching it raises
`BUDGET_EXCEEDED` (non-retryable) and the workflow parks at `HUMAN_INTERVENTION_REQUIRED` with a
spend breakdown. Local/subscription models still consume `maxIterations` and `maxWallClockSeconds`
even though their dollar cost is zero.

### Decision summary, not chain-of-thought

Every agent output schema includes:

```ts
decisionSummary: {
  summary: string;                    // what was decided, plainly
  evidence: ArtifactRef[];            // what it was based on
  assumptions: string[];
  risks: { description: string; severity: Severity }[];
  tradeoffs: string[];
  openQuestions: string[];
  confidence: number;                 // 0–1
}
```

This is what the approval UI renders (doc 54). The runtime never requests, logs, or persists private
reasoning traces (I9).

## 3. Quality gates per agent

Schema validation is necessary, not sufficient. Each agent declares semantic checks:

| Agent | Quality checks |
|---|---|
| Product Owner | every requirement cites a `sourceRef`; no requirement duplicates another by embedding similarity > 0.93; confidence present |
| Business Analyst | every story has ≥ 1 acceptance criterion; GWT well-formed; no story exceeds `MAX_STORY_SIZE_SIGNAL` without a split flag; duplicates detected across the whole backlog, not just the new batch; every story links to ≥ 1 requirement |
| Architect | all 21 option sections non-empty; components referenced in `dataFlow` exist in `components`; diagram parses as Mermaid |
| Architecture Critic | scored every option on every criterion; `agentKey ≠ 'architect'` (enforced in DB and runtime); reasoning per score |
| Estimator | confidence and a low/high range present; hour components sum within tolerance of the total; no zero-risk claims on `RiskLevel.HIGH` stories |
| Resource Planner | allocations cover every role implied by the estimate breakdown; FTE totals reconcile with duration |
| Developer | diff touches only declared repositories and paths; typecheck/lint/build/test all executed; no secrets in the diff (gitleaks) |
| Code Reviewer | every finding has file + line + severity + category |
| QA | every acceptance criterion maps to ≥ 1 test case; negative and edge cases present; test case refs unique |
| Bug Analyzer | every bug references a failing test result and evidence |

A failed hard check is `INVALID_OUTPUT`. A failed soft check attaches a warning to the artifact and is
shown to the human approver.

## 4. Agent catalogue

| Key | Capability floor | Reads | Writes | MCP |
|---|---|---|---|---|
| `product-owner` | `HIGH_REASONING` | source docs, existing product state | `requirements`, `product-vision`, `open-questions`, `risks` | product (RW) |
| `business-analyst` | `HIGH_REASONING` | requirements, business rules, existing backlog, product decisions | `backlog`, `stories`, `acceptance-criteria` | product (R), ba (RW) |
| `architect` | `HIGH_REASONING` | approved backlog, NFRs, constraints, existing codebase, infra | `architecture-option` | product (R), ba (R), github (R) |
| `architecture-critic` | `HIGH_REASONING` | architecture options only (blind to author identity) | `architecture-evaluation`, `architecture-recommendation` | github (R) |
| `estimator` | `STRUCTURED_REASONING` | stories, ADR, architecture, historical estimates | `estimate` | ba (R) |
| `resource-planner` | `STRUCTURED_REASONING` | estimates, delivery constraints | `resource-plan` | ba (R) |
| `delivery-planner` | `STRUCTURED_REASONING` | stories, dependencies, estimates, resources | `delivery-plan`, `tasks` | ba (RW) |
| `developer` | `CODING` | dev context package (doc 18) | `implementation-plan`, `code`, `pull-request` | github (branch/commit/push/PR), figma (R), filesystem (jailed), product (R), ba (R) |
| `code-reviewer` | `CODING` | PR diff, story, AC, ADR, standards | `code-review` | github (R) |
| `security-reviewer` | `CODING` | PR diff, dependency manifest | `security-review` | github (R) |
| `qa` | `CODING` | story, AC, PR diff, architecture, Figma, existing tests | `test-plan`, `test-cases`, `qa-report` | playwright (full), github (R), figma (R) |
| `bug-analyzer` | `CODING` | failing results, evidence, diff | `bug`, `root-cause` | github (R), playwright (R) |

Blindness matters for the critic: it receives the three options with author metadata stripped and
labels randomised per run, so it cannot anchor on "option A is always the first-listed one".

## 5. Product Owner Agent (doc 6.1) — output contract

```ts
const ProductOwnerOutput = z.object({
  productVision:  z.object({ statement, problem, targetUsers, valueProposition, successMetrics }),
  businessGoals:  z.array(z.object({ ref, title, description, metric, targetValue, priority })),
  stakeholders:   z.array(z.object({ name, role, interests, influence, concerns })),
  requirements:   z.array(z.object({
                    ref, type, priority, statement, rationale,
                    sourceRefs: z.array(SourceRef).min(1),   // traceability is mandatory
                    confidence: z.number().min(0).max(1),
                  })),
  businessRules:  z.array(z.object({ ref, statement, appliesTo, rationale })),
  constraints:    z.array(z.object({ kind, statement, impact })),
  assumptions:    z.array(z.object({ statement, riskIfWrong, confidence })),
  priorities:     z.array(z.object({ requirementRef, moscow, justification })),
  openQuestions:  z.array(z.object({ question, blocksRefs, askedOf, severity })),
  risks:          z.array(z.object({ description, likelihood, impact, mitigation })),
  conflicts:      z.array(z.object({ leftRef, rightRef, nature, suggestedResolution })),
  missingInformation: z.array(z.string()),
  decisionSummary: DecisionSummary,
});
```

The PO Agent explicitly **does not** produce development stories — `writes` excludes `stories`, so a
schema-valid attempt to emit them is rejected at persistence.

## 6. Business Analyst Agent (doc 8) — output contract

```ts
const StorySchema = z.object({
  ref, epicRef, title,
  userStory: z.string().regex(/^As an? .+, I want .+, so that .+/i),
  businessValue: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.object({
    kind: z.enum(['GWT','CHECKLIST']), given, when, then,
  })).min(1),
  businessRules: z.array(z.string()),
  functionalRequirements: z.array(z.string()),
  nonFunctionalRequirements: z.array(z.object({ category, requirement, measure })),
  edgeCases: z.array(z.string()).min(1),
  dependencies: z.array(z.object({ storyRef, kind })),
  risks: z.array(z.string()),
  assumptions: z.array(z.string()),
  priority: z.enum(['MUST','SHOULD','COULD','WONT']),
  labels: z.array(z.string()),
  definitionOfReady: z.array(z.object({ item, met: z.boolean() })),
  requirementRefs: z.array(z.string()).min(1),
  sizeSignal: z.enum(['XS','S','M','L','XL']),
  qualityFlags: z.array(QualityFlag),        // the agent reports its own doubts
});
```

`qualityFlags` is how the BA surfaces duplicates, ambiguity, oversized stories, technical-as-business
requirements and missing edge cases as structured data the dashboard can filter, rather than as prose
buried in a description.

## 7. Developer Agent — the Development Context Package (doc 18)

Assembled by an activity, not by the agent, so its composition is auditable and cacheable:

```ts
interface DevelopmentContextPackage {
  story: Story; acceptanceCriteria: AcceptanceCriterion[];
  architecture: ArchitectureOptionSummary; adr: Adr;
  tasks: Task[];
  repositories: { id, role, url, branch, workspacePath }[];
  relevantCode: CodeExcerpt[];        // retrieval-selected, budgeted
  codingStandards: string;            // per-repo, from config or CONTRIBUTING/CLAUDE.md
  databaseSchema?: string;
  apiContracts?: OpenApiFragment[];
  designReferences: FigmaReference[] | { status: 'DESIGN_CONTEXT_UNAVAILABLE' };
  securityRequirements: string[]; testingRequirements: string[];
  dependencies: { storyRef, status }[];
}
```

If Figma MCP is not configured the package carries `DESIGN_CONTEXT_UNAVAILABLE` and the workflow
proceeds **only** when the story has no `design-required` label; otherwise it parks for human input
rather than inventing a UI.

The developer's operating sequence is fixed by the workflow (doc 03 §4.7), not left to the model:
inspect → plan → implement → test → lint → typecheck → build → self-review → branch → commit → push →
PR. Each step is a separate activity so a failure resumes at the failed step.

## 8. Agent testing

Every agent has three test tiers (doc 14):

1. **Schema contract tests** — recorded outputs parse; malformed outputs are rejected.
2. **Golden-fixture tests** — a fixed project state + `MockModelProvider` replaying recorded responses
   produces a byte-stable artifact; catches prompt/parsing regressions with no API cost.
3. **Quality-check unit tests** — each `QualityCheck` tested against passing and failing samples.
