/**
 * Structured-output helpers.
 *
 * Preference order per provider: native JSON-schema mode, then tool-call-shaped output, then
 * fenced JSON with a parser. The adapter reports which mode it used so the runtime can tell a
 * truncation (retry with a larger output budget) from a malformed response (repair once, then fail).
 */

import { createHash } from 'node:crypto';

export type StructuredMode = 'native' | 'tool' | 'fenced';

export interface ParseAttempt<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  mode: StructuredMode;
}

/**
 * Extract JSON from a model response: bare JSON, fenced blocks, or JSON wrapped in prose.
 * Never repairs by guessing — a truncated document fails so the caller can retry properly.
 */
export function extractJson<T = unknown>(text: string): ParseAttempt<T> {
  const trimmed = text.trim();
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/g;
  for (const match of trimmed.matchAll(fenced)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  candidates.push(trimmed);

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let lastError = 'no JSON found in response';
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as T, mode: 'fenced' };
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  return { ok: false, error: lastError, mode: 'fenced' };
}

/** Deterministic hash of a request, so a historical run can be reproduced exactly. */
export function hashRequest(parts: {
  promptSha: string;
  contextSha: string;
  input: unknown;
  modelId: string;
}): string {
  return createHash('sha256')
    .update(parts.promptSha)
    .update(' ')
    .update(parts.contextSha)
    .update(' ')
    .update(stableStringify(parts.input))
    .update(' ')
    .update(parts.modelId)
    .digest('hex');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Key-sorted JSON. Unsorted keys are a classic silent prompt-cache invalidator. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * The single repair turn. A model that fails validation twice will not succeed on the third try,
 * and the remaining budget is better spent surfacing the problem to a human.
 */
export function buildRepairMessage(errors: string[], schemaName: string): string {
  const lines = [
    `Your previous response did not satisfy the ${schemaName} schema.`,
    '',
    'Validation errors:',
    ...errors.map((e) => `  - ${e}`),
    '',
    'Return the corrected document as a single JSON object matching the schema exactly.',
    'Do not include commentary, explanation, or markdown fences.',
  ];
  return lines.join('\n');
}
