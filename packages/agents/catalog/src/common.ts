/**
 * Shared building blocks for agent definitions.
 *
 * Every agent shares the same skeleton — model policy, budget, permissions, writes, quality checks
 * — so the differences between agents are visible rather than buried in boilerplate.
 */

import { z } from 'zod';
import {
  Capability,
  ModelTier,
  type AgentBudget,
  type AgentDefinition,
  type AgentKey,
  type AgentPermission,
  type ArtifactKind,
  type McpPermission,
  type ModelPolicy,
  type QualityCheck,
  type QualityCheckResult,
} from '@sdlc/shared';
import type { ModelRequest } from '@sdlc/shared';
import type { Schema } from '@sdlc/agent-runtime';

// ── shared schema fragments ────────────────────────────────────────────────

export const Severity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const Priority = z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']);
export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH']);

/**
 * The auditable explanation every agent must produce. Note what it is *not*: a reasoning trace.
 * The platform never asks for, logs or stores chain-of-thought (invariant I9); it asks for
 * conclusions and their basis, which is what an approver can actually act on.
 */
export const DecisionSummary = z.object({
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  risks: z.array(z.object({ description: z.string(), severity: Severity })).default([]),
  tradeoffs: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const SourceRef = z.object({
  documentId: z.string(),
  span: z.tuple([z.number(), z.number()]).optional(),
});

export const ChangeRequestInput = z
  .array(
    z.object({
      target: z.object({ kind: z.string(), ref: z.string() }),
      instruction: z.string(),
      severity: z.enum(['MUST', 'SHOULD', 'CONSIDER']),
    }),
  )
  .default([]);

/** Every agent takes at least a mode and, on revision runs, structured reviewer feedback. */
export const BaseInput = z.object({
  mode: z.enum(['create', 'revise']).default('create'),
  changeRequests: ChangeRequestInput,
  notes: z.string().optional(),
});

// ── budgets ────────────────────────────────────────────────────────────────

export const DEFAULT_BUDGET: AgentBudget = {
  maxCostUsd: 5,
  maxTokens: 400_000,
  maxToolCalls: 60,
  maxIterations: 25,
  maxWallClockSeconds: 1200,
};

export function budget(overrides: Partial<AgentBudget> = {}): AgentBudget {
  return { ...DEFAULT_BUDGET, ...overrides };
}

// ── model policies ─────────────────────────────────────────────────────────

export const POLICY = {
  frontierReasoning: (extra: Partial<ModelPolicy> = {}): ModelPolicy => ({
    capability: Capability.HIGH_REASONING,
    minimumTier: ModelTier.FRONTIER,
    requireStructuredOutput: true,
    ...extra,
  }),
  structured: (extra: Partial<ModelPolicy> = {}): ModelPolicy => ({
    capability: Capability.STRUCTURED_REASONING,
    minimumTier: ModelTier.MID,
    requireStructuredOutput: true,
    ...extra,
  }),
  coding: (extra: Partial<ModelPolicy> = {}): ModelPolicy => ({
    capability: Capability.CODING,
    minimumTier: ModelTier.MID,
    requireStructuredOutput: true,
    ...extra,
  }),
} as const;

// ── quality check helpers ──────────────────────────────────────────────────

export function check<O>(
  code: string,
  severity: 'HARD' | 'SOFT',
  description: string,
  run: (output: O) => { passed: boolean; message: string; details?: Record<string, unknown> },
): QualityCheck<O> {
  return {
    code,
    severity,
    description,
    run(output): QualityCheckResult {
      const result = run(output);
      return {
        passed: result.passed,
        severity,
        code,
        message: result.message,
        ...(result.details ? { details: result.details } : {}),
      };
    },
  };
}

export function pass(message = 'ok'): { passed: true; message: string } {
  return { passed: true, message };
}

export function fail(
  message: string,
  details?: Record<string, unknown>,
): { passed: false; message: string; details?: Record<string, unknown> } {
  return { passed: false, message, ...(details ? { details } : {}) };
}

// ── definition builder ─────────────────────────────────────────────────────

export interface DefineAgentInput<I, O> {
  key: AgentKey;
  name: string;
  role: string;
  promptVersion?: string;
  modelPolicy: ModelPolicy;
  contextRecipe: string;
  mcpServers?: McpPermission[];
  permissions: AgentPermission[];
  writes: ArtifactKind[];
  inputSchema: Schema<I>;
  outputSchema: Schema<O>;
  qualityChecks?: QualityCheck<O>[];
  budget?: Partial<AgentBudget>;
  timeoutSeconds?: number;
  maxRetries?: number;
}

export function defineAgent<I, O>(input: DefineAgentInput<I, O>): AgentDefinition<I, O> {
  return {
    key: input.key,
    version: 1,
    name: input.name,
    role: input.role,
    enabled: true,
    promptRef: {
      agentKey: input.key,
      version: input.promptVersion ?? 'v1',
      path: `${input.key}/${input.promptVersion ?? 'v1'}.md`,
      // Filled in by the PromptRegistry at load time; the run records the real hash.
      sha256: '',
    },
    modelPolicy: input.modelPolicy,
    contextRecipe: input.contextRecipe,
    mcpServers: input.mcpServers ?? [],
    permissions: input.permissions,
    writes: input.writes,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    qualityChecks: input.qualityChecks ?? [],
    maxRetries: input.maxRetries ?? 3,
    timeoutSeconds: input.timeoutSeconds ?? 1200,
    budget: budget(input.budget),
  };
}

export function mcp(
  serverKey: string,
  toolPatterns: string[],
  scopes: string[],
  required = false,
): McpPermission {
  return { serverKey, toolPatterns, scopes, required };
}

// ── demo-handler helpers ───────────────────────────────────────────────────

/**
 * Demo handlers receive the raw ModelRequest. These helpers pull out the task input and the
 * context sections so a handler can produce output that actually reflects the project state
 * rather than a fixed blob — which is what makes the demo pipeline feel real.
 */
export function readTask<T = Record<string, unknown>>(req: ModelRequest): T {
  const body = flattenMessages(req);
  const match = /<task>\s*([\s\S]*?)\s*<\/task>/.exec(body);
  if (!match?.[1]) return {} as T;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return {} as T;
  }
}

export function readSection(req: ModelRequest, key: string): string | null {
  const body = flattenMessages(req);
  const pattern = new RegExp(`<context section="${key}"[^>]*>\\s*([\\s\\S]*?)\\s*</context>`);
  return pattern.exec(body)?.[1] ?? null;
}

export function readJsonSection<T>(req: ModelRequest, key: string): T | null {
  const raw = readSection(req, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function flattenMessages(req: ModelRequest): string {
  return req.messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((block) => block.text ?? '').join('\n'),
    )
    .join('\n');
}

export function demoSummary(summary: string, confidence = 0.8): z.infer<typeof DecisionSummary> {
  return {
    summary,
    evidence: [],
    assumptions: ['Generated by the mock provider in demo mode; not a real model judgement.'],
    risks: [],
    tradeoffs: [],
    openQuestions: [],
    confidence,
  };
}
