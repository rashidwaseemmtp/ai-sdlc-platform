# 09 — Context Engine, Memory & Artifacts

Two rules drive this whole subsystem:

1. **Never send the whole project to an LLM.** Cost, latency and quality all degrade; and a model
   given everything attends to nothing.
2. **Never let an agent choose its own context silently.** Context composition is declared,
   retrieved by the platform, and recorded — so a bad output can be diagnosed as a bad input.

## 1. Project memory

The memory *is* the database (doc 02). There is no separate agent-memory store to drift out of sync.
Five memory kinds, all queryable and all versioned:

| Kind | Source | Retrieval |
|---|---|---|
| **Structured state** | requirements, stories, ADRs, estimates, PRs, tests | SQL by relation — precise, always preferred |
| **Documents** | meetings, notes, emails, specs | pgvector over `document_chunks` |
| **Code** | git working copies | ripgrep + symbol index + embeddings over chunks |
| **Decisions** | ADRs, product decisions, approval comments | SQL, always included when relevant to the task |
| **History** | `domain_events`, prior agent runs, prior failures | SQL windowed by recency and relevance |

Structured retrieval beats semantic retrieval wherever a relation exists. Embeddings are for prose and
code, not for finding "the acceptance criteria of US-142" — that is a join.

## 2. Context recipes

Every agent declares what it needs. The recipe is data, so it can be inspected, versioned and diffed.

```ts
interface ContextRecipe {
  sections: ContextSection[];
  tokenBudget: number;               // total, enforced
  overflowStrategy: 'summarize' | 'drop-lowest-priority' | 'fail';
}

interface ContextSection {
  key: string;                       // 'approved-architecture'
  source: ContextSource;             // sql | vector | git | artifact | computed
  query: ContextQuery;
  priority: 1 | 2 | 3;               // 1 = never dropped
  maxTokens: number;
  format: 'json' | 'markdown' | 'code';
  required: boolean;                 // missing → fail the run rather than proceed blind
}
```

Example — the Business Analyst:

```yaml
businessAnalyst:
  tokenBudget: 120000
  overflowStrategy: summarize
  sections:
    - key: product-vision        source: sql     priority: 1  required: true   maxTokens: 2000
    - key: approved-requirements source: sql     priority: 1  required: true   maxTokens: 40000
    - key: business-rules        source: sql     priority: 1  required: true   maxTokens: 8000
    - key: product-decisions     source: sql     priority: 1  required: false  maxTokens: 6000
    - key: existing-backlog      source: sql     priority: 2  required: false  maxTokens: 30000
    - key: meeting-excerpts      source: vector  priority: 2  required: false  maxTokens: 20000
      query: { topK: 12, filter: { kind: [MEETING, NOTE] } }
    - key: open-questions        source: sql     priority: 2  required: false  maxTokens: 4000
    - key: prior-review-feedback source: sql     priority: 1  required: false  maxTokens: 8000
```

The BA sees the whole approved requirement set (priority 1 — a backlog built from a sample is wrong),
but only the *relevant* meeting excerpts.

## 3. Build pipeline

```
identify task (agent, phase, subject: project | story | option)
      ↓
load recipe (agent definition, versioned)
      ↓
resolve sections in parallel
      ├─ sql      typed repository queries
      ├─ vector   embed(query) → HNSW top-k → rerank → dedupe by chunk hash
      ├─ git      changed files + import graph neighbours + symbol matches
      └─ artifact pinned versions passed by the workflow (inputRefs)
      ↓
budget pass   count tokens (provider tokenizer where available)
      ↓ over budget?
      ├─ summarize    priority-3 sections replaced by extractive summaries
      ├─ drop         priority-3 then 2, never 1
      └─ fail         if a required section cannot fit → INVALID_CONTEXT, park
      ↓
assemble  stable ordering: system → project card → structured state → documents → code → task
      ↓
ContextPackage { sections[], tokenCount, inputRefs[], sha256 }
```

**Stable ordering is a caching decision, not a cosmetic one.** Sections are emitted most-stable-first
so the provider prompt cache hits across the many agent runs in a project; volatile content (the
specific story, the change requests) goes last, after the final cache breakpoint.

`ContextPackage.sha256` plus `promptVersion.sha256` is what makes a historical run reproducible.

## 4. Code retrieval

For the Developer, Reviewer and QA agents, "relevant code" is computed, not guessed:

1. Seed from the story: referenced modules, API paths, entities named in acceptance criteria.
2. Expand by import graph one hop (callers and callees of seed symbols).
3. Add files touched by the diff (for review/QA), always in full for changed hunks.
4. Semantic top-k over code chunks for anything still unmatched.
5. Rank by (relevance × recency × ownership), truncate to budget, keep whole functions rather than
   arbitrary line windows.

Repository conventions (`CLAUDE.md`, `CONTRIBUTING.md`, lint config, `package.json` scripts) are
always included at priority 1 — they are how an agent writes code that matches the surrounding style.

## 5. Artifacts

An artifact is a logical document; a version is an immutable snapshot (doc 02 §10).

```
artifact: { id, projectId, kind, scope, scopeRef, currentVersionId }
version:  { artifactId, version, contentJson, contentSha256, status,
            producedByRunId, approvedByUserId, approvedAt }
```

Kinds: `requirements`, `backlog`, `story`, `architecture-option`, `architecture-evaluation`,
`architecture-recommendation`, `adr`, `estimate`, `resource-plan`, `delivery-plan`,
`implementation-plan`, `code-review`, `security-review`, `test-plan`, `test-cases`, `qa-report`,
`bug`, `release-notes`.

Rules:

- **Insert-only.** A revision is version *n+1*. Approved versions are never mutated (I3, enforced by a
  DB trigger, not by convention).
- **Content-addressed.** `contentSha256` deduplicates identical regenerations and proves integrity.
- **Reference-passing.** Workflows pass `{artifactId, version, sha256}`; bodies never enter Temporal
  history (I4).
- **Superseding, not deleting.** An ADR replaced by a later decision gets `supersededByAdrId`; the
  original stays readable forever.

## 6. Lineage & traceability

`artifact_lineage(childVersionId, parentVersionId, relation)` is written by the runtime from the
`inputRefs` the workflow supplied — agents cannot forge or omit it.

This is what makes the doc-68 trace real and queryable:

```sql
-- Why does this test case exist?
WITH RECURSIVE up AS (
  SELECT * FROM artifact_lineage WHERE child_version_id = :testCaseVersionId
  UNION ALL
  SELECT l.* FROM artifact_lineage l JOIN up ON l.child_version_id = up.parent_version_id
)
SELECT * FROM up;
```

```
Meeting "Discovery call 12 Mar" (doc chunk 41)
  → REQ-014  "Admins must be able to deactivate a customer"
    → US-142 "Deactivate customer account"
      → ADR-001 (architecture context)
        → estimate-v1 (US-142: 14h, confidence 0.71)
          → implementation-plan-v1
            → PR #38
              → TC-88 "Deactivating a customer with open invoices is blocked"
                → test_result (FAIL) → BUG-12 → PR #39 → test_result (PASS)
```

Every arrow is a row, not an inference. The dashboard renders this as the project trace view, and it
is the answer to "why did the agent make this decision?".

## 7. Embeddings

- Provider-independent behind `EmbeddingProvider` (OpenAI, Google, Ollama/`nomic-embed-text`, mock).
- Dimension is a config value; the column is `vector(N)` with N fixed per installation and asserted at
  startup — mixing dimensions silently is a classic and painful bug.
- Chunking: documents by heading + ~800 tokens with 100 overlap; code by symbol boundary.
- Re-embedding is a versioned background job; `document_chunks.embeddingModel` records which model
  produced each vector so a model change re-embeds rather than mixes spaces.
- Local/demo mode uses a deterministic hash embedder so the whole pipeline runs with no credentials.
