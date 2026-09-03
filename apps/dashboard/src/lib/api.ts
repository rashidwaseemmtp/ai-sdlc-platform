/**
 * API client.
 *
 * The dashboard talks only to the API — never to the database or Temporal directly. Every read is
 * uncached so a page reflects the pipeline as it is now, which for an operations console matters
 * more than a fast second load.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(response.status, body || response.statusText);
  }
  return (await response.json()) as T;
}

/**
 * Reads never take the whole page down. A single failing panel shows its own error rather than
 * replacing the console with a stack trace — this is the screen someone opens *because* something
 * is wrong.
 */
export async function safeGet<T>(path: string, fallback: T): Promise<{ data: T; error?: string }> {
  try {
    const result = await request<{ data: T }>(path);
    return { data: result.data };
  } catch (error) {
    return { data: fallback, error: (error as Error).message };
  }
}

export const api = {
  get: <T>(path: string) => request<{ data: T }>(path),
  post: <T>(path: string, body?: unknown) =>
    request<{ data: T }>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    request<{ data: T }>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  health: () => request<Health>('/health'),
};

// ── shapes the pages consume ───────────────────────────────────────────────

export interface Health {
  status: string;
  database: string;
  temporal: string;
  demoMode: boolean;
  aiMergePermission: boolean;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  status: string;
  phase: string;
  repositories: { key: string; role: string; url: string }[];
  _count: { stories: number; requirements: number };
}

export interface PipelineStage {
  name: string;
  state: 'DONE' | 'ACTIVE' | 'PENDING';
  detail: string;
}

export interface Pipeline {
  phase: string;
  stages: PipelineStage[];
  pendingApprovals: {
    id: string;
    gateKey: string;
    title: string;
    requiredRole: string;
    expiresAt: string | null;
  }[];
}

export interface ApprovalListItem {
  id: string;
  gate: string;
  status: string;
  title: string;
  summary: string | null;
  requiredRole: string;
  requestedAt: string;
  expiresAt: string | null;
  project: { key: string; name: string };
  isIntervention: boolean;
}

export interface ApprovalDetail {
  requestId: string;
  gate: string;
  status: string;
  requiredRole: string;
  title: string;
  summary: string | null;
  project: { id: string; key: string; name: string };
  isIntervention: boolean;
  artifact: { kind: string; version: number; content: unknown; sha256: string } | null;
  previousVersion: { version: number; content: unknown } | null;
  decisionSummary: DecisionSummary | null;
  qualityWarnings: { code?: string; message?: string; severity?: string }[];
  provenance: {
    agentKey?: string;
    promptVersion?: string;
    modelId?: string;
    providerKey?: string;
    billingMode?: string;
    costUsd?: number;
    tokens?: number;
    durationMs?: number;
  } | null;
  lineage: { relation: string; kind: string; name: string; version: number }[];
  context: Record<string, unknown>;
  actions: string[];
}

export interface DecisionSummary {
  summary: string;
  assumptions: string[];
  risks: { description: string; severity: string }[];
  tradeoffs: string[];
  openQuestions: string[];
  confidence: number;
}

export interface AgentRunRow {
  id: string;
  agentKey: string;
  phase: string | null;
  status: string;
  startedAt: string;
  durationMs: number | null;
  totalCostUsd: number;
  totalTokens: number;
  error: { code?: string; message?: string } | null;
  project: { key: string } | null;
}

export interface AgentRow {
  key: string;
  routing: { capability?: string; minimumTier?: string; effort?: string } | undefined;
  grants: { server: string; tools: string; scopes: string[] }[];
  canMerge: boolean;
  runs: number;
  failed: number;
  costUsd: number;
}

export interface CostRollup {
  rows: { agentKey: string; runs: number; costUsd: number; tokens: number; quotaUnits: number; costUnknown: boolean }[];
  total: { runs: number; costUsd: number; tokens: number; quotaUnits: number; costUnknown: boolean };
  budgetUsd: number;
}

export interface Story {
  id: string;
  ref: string;
  title: string;
  userStory: string;
  description: string;
  priority: string;
  status: string;
  sizeSignal: string;
  labels: string[];
  edgeCases: string[];
  acceptanceCriteria: {
    ref: string;
    kind: string;
    given: string | null;
    whenText: string | null;
    thenText: string | null;
    statement: string | null;
  }[];
  qualityFlags: { kind: string; detail: string; severity: string }[];
  estimates: { estimatorKind: string; hoursEngineering: number; confidence: number; rangeLowHours: number; rangeHighHours: number }[];
  requirementLinks: { requirement: { ref: string } }[];
  epic: { ref: string; title: string } | null;
}

export interface ArchitectureBundle {
  options: {
    id: string;
    variant: string;
    name: string;
    overview: string;
    diagramMermaid: string | null;
    advantages: string[];
    disadvantages: string[];
    developmentComplexity: string | null;
    operationalComplexity: string | null;
    evaluations: { criterion: string; score: number; reasoning: string }[];
  }[];
  recommendation: { recommendedOptionId: string; reasoning: string; scores: unknown } | null;
  adrs: { number: number; title: string; status: string; decision: string; rationale: string }[];
}
