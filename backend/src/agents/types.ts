/**
 * What an agent is, in this platform.
 *
 * A prompt, an output schema, the project state it is allowed to see, the checks the platform runs
 * on its answer, and how that answer becomes rows. Nothing else — no model policy, no tool grants,
 * no budget object. An agent is a file in this directory, not a row in a table: changing one is a
 * code change with a diff and a review, which is the only way the provenance on an AgentRun means
 * anything.
 */

import { z } from 'zod';
import type { ContextSection } from '../context.js';

export const Severity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const Priority = z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']);
export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH']);

/**
 * The auditable explanation every agent must produce.
 *
 * Note what it is not: a reasoning trace. The platform never asks for, logs or stores
 * chain-of-thought — it asks for conclusions and their basis, which is what an approver can act on.
 */
export const DecisionSummary = z.object({
  summary: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  risks: z.array(z.object({ description: z.string(), severity: Severity })).default([]),
  tradeoffs: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

/** Structured reviewer feedback, carried from an approval decision into the next agent run. */
export interface ChangeRequest {
  target: string;
  instruction: string;
  severity: 'MUST' | 'SHOULD' | 'CONSIDER';
}

export interface AgentInput {
  projectId: string;
  /** `create` on the first pass; `revise` when an approver asked for changes. */
  mode: 'create' | 'revise';
  changeRequests: ChangeRequest[];
  /** Per-invocation values: the architect's brief, the estimator's kind, the blinded options. */
  vars: Record<string, unknown>;
}

export interface Check<O> {
  code: string;
  /** HARD fails the run before anything is persisted. SOFT is surfaced to the approver. */
  severity: 'HARD' | 'SOFT';
  description: string;
  run(output: O): { passed: boolean; message: string };
}

export interface Agent<O = unknown> {
  key: string;
  name: string;
  role: string;
  /** Which slices of project state this agent is shown. Deny by default: an empty list sees only the project card. */
  context: ContextSection[];
  schema: z.ZodType<O, z.ZodTypeDef, unknown>;
  /** The instruction block for this particular invocation, appended after the context. */
  task?(input: AgentInput): string;
  checks?: Check<O>[];
  /** Turn validated output into rows. Runs only after every HARD check has passed. */
  persist?(output: O, input: AgentInput): Promise<void>;
  /** One line for the run list and the approval card. */
  summary(output: O): string;
}

/** Identity function that pins `O` from the schema, so `checks` and `persist` are typed. */
export function defineAgent<O>(agent: Agent<O>): Agent<O> {
  return agent;
}

export function pass(message = 'ok'): { passed: true; message: string } {
  return { passed: true, message };
}

export function fail(message: string): { passed: false; message: string } {
  return { passed: false, message };
}

/** Rendered into the prompt so the agent addresses the reviewer's points one by one. */
export function renderChangeRequests(input: AgentInput): string {
  if (input.mode !== 'revise' || input.changeRequests.length === 0) return '';
  return [
    '',
    'A human reviewed your previous answer and asked for these changes. Address each one, and',
    'preserve everything they did not object to — a revision is an edit, not a regeneration.',
    '',
    ...input.changeRequests.map(
      (change, index) => `${index + 1}. [${change.severity}] ${change.target}: ${change.instruction}`,
    ),
  ].join('\n');
}
