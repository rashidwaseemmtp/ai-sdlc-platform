# 11 — Configuration Specification

Nothing operational is hard-coded (doc 49). Model provider, model name, MCP server, repository, Figma
project, tracker, database, workflow limits, approval rules, retry limits and agent permissions are
all configuration.

## 1. Four layers, highest wins

```
4. Project overrides   (DB: settings scope=PROJECT, project_integrations, routing_policies)
3. Runtime settings    (DB: settings scope=GLOBAL — edited in the dashboard, hot-reloaded)
2. Config files        (config/*.yaml — version-controlled defaults)
1. Environment         (.env — secrets, connection strings, deployment shape)
```

Rationale: `.env` holds only what must exist before the process starts (connections, secret refs).
YAML holds reviewable defaults. The DB holds what operators change at runtime. Projects override what
differs per client. Every layer merge is deep, and `GET /settings` reports the effective value **and
which layer supplied it** — invisible precedence is a support nightmare.

Every value is parsed through a Zod schema at boot. A malformed config fails startup loudly; it never
degrades to a default.

## 2. Environment (`.env.example`)

```bash
# ─── Core ────────────────────────────────────────────────────────────
NODE_ENV=development
API_PORT=3001
DASHBOARD_PORT=3000
LOG_LEVEL=info

# ─── Data ────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://sdlc:sdlc@localhost:5432/sdlc
REDIS_URL=redis://localhost:6379

# ─── Temporal ────────────────────────────────────────────────────────
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE_MAIN=sdlc-main
TEMPORAL_TASK_QUEUE_AGENTS=sdlc-agents
TEMPORAL_TASK_QUEUE_TOOLS=sdlc-tools
TEMPORAL_TASK_QUEUE_HEAVY=sdlc-heavy

# ─── Model providers (all optional — demo mode needs none) ───────────
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434

# ─── Integrations (optional) ─────────────────────────────────────────
GITHUB_TOKEN=
FIGMA_TOKEN=
JIRA_BASE_URL=
JIRA_TOKEN=
LINEAR_API_KEY=

# ─── Secrets & workspace ─────────────────────────────────────────────
SECRET_PROVIDER=env                  # env | file | vault | aws-kms | doppler
MASTER_KEY=                          # required when SECRET_PROVIDER=file
WORKSPACE_ROOT=./.workspace
ARTIFACT_STORAGE=./.artifacts        # local path or s3://bucket

# ─── Safety rails ────────────────────────────────────────────────────
DEMO_MODE=true                       # mock providers, no credentials required
AI_MERGE_PERMISSION=false            # never true without deliberate intent
MAX_AGENT_RETRIES=3
MAX_PR_FIX_ITERATIONS=3
MAX_QA_FIX_ITERATIONS=3
MAX_BUILD_FIX_ITERATIONS=2
MAX_BACKLOG_REVISIONS=3
MAX_ARCHITECTURE_ROUNDS=2
MAX_PARALLEL_STORIES=3
MAX_WORKFLOW_COST_USD=25
MAX_AGENT_COST_USD=5
MAX_AGENT_TOKENS=400000
MAX_AGENT_ITERATIONS=25
MAX_AGENT_WALLCLOCK_SECONDS=1200
ESTIMATION_VARIANCE_THRESHOLD=0.30
APPROVAL_DEFAULT_TIMEOUT_HOURS=72
PROVIDER_COOLDOWN_SECONDS=120
```

## 3. Config files

```
config/
├── models.yaml        providers, catalog seed, per-agent routing (doc 05 §6)
├── mcp.yaml           servers, transports, default permissions (doc 06 §5)
├── agents.yaml        per-agent budgets, retries, timeouts, context recipes
├── workflows.yaml     gate definitions, iteration caps, retry policies
├── security.yaml      command allowlist, path denylist, protected branches
└── demo.yaml          the seeded demo project (doc 66)
```

`config/agents.yaml`:

```yaml
agents:
  defaults:
    maxRetries: 3
    timeoutSeconds: 1200
    budget: { maxCostUsd: 5, maxTokens: 400000, maxToolCalls: 60,
              maxIterations: 25, maxWallClockSeconds: 1200 }

  product-owner:
    enabled: true
    promptVersion: v1
    contextRecipe: product-owner
    budget: { maxCostUsd: 3 }

  developer:
    enabled: true
    promptVersion: v1
    contextRecipe: developer
    timeoutSeconds: 2400
    budget: { maxCostUsd: 10, maxToolCalls: 200, maxIterations: 60 }
```

`config/workflows.yaml`:

```yaml
approvalGates:
  backlog:        { enabled: true, requiredRole: PRODUCT,   timeoutHours: 72, autoApprove: false }
  architecture:   { enabled: true, requiredRole: ARCHITECT, timeoutHours: 72, autoApprove: false }
  estimation:     { enabled: true, requiredRole: PRODUCT,   timeoutHours: 48, autoApprove: false }
  dev-readiness:  { enabled: true, requiredRole: PRODUCT,   timeoutHours: 48, autoApprove: false }
  pr:             { enabled: true, requiredRole: ENGINEER,  timeoutHours: 72, autoApprove: false }
  qa:             { enabled: true, requiredRole: QA,        timeoutHours: 48, autoApprove: false }
  release:        { enabled: true, requiredRole: ADMIN,     timeoutHours: 168, autoApprove: false }

limits:
  maxPrFixIterations: 3
  maxQaFixIterations: 3
  maxBacklogRevisions: 3
  maxParallelStories: 3
  maxWorkflowCostUsd: 25
```

## 4. Per-project configuration

A project may override models, repositories, Figma project, MCP servers, tech stack, approval rules,
enabled agents and team members (doc 50):

```jsonc
// projects.settings
{
  "techStack": { "backend": "NestJS", "frontend": "Next.js", "db": "PostgreSQL" },
  "routingOverrides": { "developer": { "primary": "anthropic", "effort": "xhigh" } },
  "approvalGates": { "qa": { "requiredRole": "ENGINEER", "timeoutHours": 24 } },
  "limits": { "maxParallelStories": 5, "maxWorkflowCostUsd": 60 },
  "integrations": { "product": "jira", "ba": "jira", "design": "figma", "vcs": "github" },
  "codingStandardsRef": "docs/engineering-standards.md",
  "enabledAgents": ["product-owner","business-analyst","architect","architecture-critic",
                    "estimator","resource-planner","delivery-planner","developer",
                    "code-reviewer","security-reviewer","qa","bug-analyzer"]
}
```

## 5. Hot reload

Changing settings, routing, MCP servers or grants in the dashboard takes effect on the **next** agent
run — never mid-run. A run pins its config snapshot at step 1 and records it, so an audit reflects
what was actually in force. Changing `.env` or `config/*.yaml` requires a restart, and the API surfaces
which layer a value came from so operators know which lever they pulled.

## 6. Demo mode

`DEMO_MODE=true` (the default in `.env.example`) selects `mock` providers for models, GitHub, Figma
and Playwright, seeds the demo project, and uses the deterministic hash embedder. The entire pipeline
runs, end to end, with zero credentials — which is also how CI runs it. Turning demo mode off with no
provider configured fails at startup with a message naming exactly what to set, rather than failing
later inside an agent.
