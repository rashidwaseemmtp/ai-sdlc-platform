/**
 * Layered configuration loader — docs/11 §1.
 *
 *   4. Project overrides   (DB)
 *   3. Runtime settings    (DB)
 *   2. Config files        (config/*.yaml)
 *   1. Environment         (.env)
 *
 * Highest layer wins. `resolve()` reports *which* layer supplied each value, because invisible
 * precedence is the thing that makes layered config miserable to operate.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodTypeAny, output as ZodOutput } from 'zod';
import {
  EnvSchema,
  ModelsConfigSchema,
  McpConfigSchema,
  AgentsConfigSchema,
  WorkflowsConfigSchema,
  SecurityConfigSchema,
  type Env,
  type ModelsConfig,
  type McpConfig,
  type AgentsConfig,
  type WorkflowsConfig,
  type SecurityConfig,
} from './schema.js';


/**
 * Find the monorepo root by walking up for `pnpm-workspace.yaml`.
 *
 * Config, prompts and the workspace directory are repo-relative, but processes start from their own
 * package directory. Resolving from `process.cwd()` would make the worker work when launched from
 * the root and fail when launched from `apps/worker`, which is a miserable thing to debug.
 */
export function findRepoRoot(from: string = process.cwd()): string {
  let current = resolvePath(from);
  for (;;) {
    if (existsSync(joinPath(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolvePath(from);
    current = parent;
  }
}

export function repoPath(...segments: string[]): string {
  return joinPath(findRepoRoot(), ...segments);
}

export type ConfigLayer = 'env' | 'file' | 'runtime' | 'project';

export interface ResolvedValue<T> {
  value: T;
  layer: ConfigLayer;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse process env. Throws with the full issue list rather than starting up degraded — a worker
 * that boots with a missing DATABASE_URL fails later, in an activity, where it is far harder to
 * diagnose.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid environment configuration:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function readYaml<S extends ZodTypeAny>(path: string, schema: S, label: string): ZodOutput<S> {
  if (!existsSync(path)) {
    throw new ConfigError(`Missing config file: ${path}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`Could not parse ${label} (${path}): ${(cause as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid ${label} (${path}):\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** Interpolate `${VAR}` references so YAML can point at env without embedding secrets. */
export function interpolateEnv(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => env[name] ?? '');
}

export interface FileConfig {
  models: ModelsConfig;
  mcp: McpConfig;
  agents: AgentsConfig;
  workflows: WorkflowsConfig;
  security: SecurityConfig;
}

export function loadFileConfig(configDir = repoPath('config')): FileConfig {
  return {
    models: readYaml(joinPath(configDir, 'models.yaml'), ModelsConfigSchema, 'models config'),
    mcp: readYaml(joinPath(configDir, 'mcp.yaml'), McpConfigSchema, 'mcp config'),
    agents: readYaml(joinPath(configDir, 'agents.yaml'), AgentsConfigSchema, 'agents config'),
    workflows: readYaml(joinPath(configDir, 'workflows.yaml'), WorkflowsConfigSchema, 'workflows config'),
    security: readYaml(joinPath(configDir, 'security.yaml'), SecurityConfigSchema, 'security config'),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge where later sources win. Arrays are replaced, not concatenated. */
export function deepMerge<T extends Record<string, unknown>>(...sources: Partial<T>[]): T {
  const out: Record<string, unknown> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined) continue;
      const existing = out[key];
      out[key] = isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : value;
    }
  }
  return out as T;
}

/**
 * Resolve one key across the four layers, reporting the winning layer.
 * `GET /settings` uses this so an operator can see which lever actually applied.
 */
export function resolveLayered<T>(layers: {
  env?: T | undefined;
  file?: T | undefined;
  runtime?: T | undefined;
  project?: T | undefined;
}): ResolvedValue<T> | undefined {
  if (layers.project !== undefined) return { value: layers.project, layer: 'project' };
  if (layers.runtime !== undefined) return { value: layers.runtime, layer: 'runtime' };
  if (layers.file !== undefined) return { value: layers.file, layer: 'file' };
  if (layers.env !== undefined) return { value: layers.env, layer: 'env' };
  return undefined;
}

/**
 * Guard for the doc-11 §6 rule: turning demo mode off with no provider configured must fail at
 * startup naming exactly what to set, rather than failing later inside an agent.
 */
export function assertProvidersAvailable(env: Env): void {
  if (env.DEMO_MODE) return;
  const configured = [
    env.ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY',
    env.OPENAI_API_KEY && 'OPENAI_API_KEY',
    env.GOOGLE_API_KEY && 'GOOGLE_API_KEY',
    env.OPENROUTER_API_KEY && 'OPENROUTER_API_KEY',
    env.OLLAMA_BASE_URL && 'OLLAMA_BASE_URL',
  ].filter(Boolean);

  if (configured.length === 0) {
    throw new ConfigError(
      'DEMO_MODE is false but no model provider is configured. Set one of ' +
        'ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY or ' +
        'OLLAMA_BASE_URL, or set DEMO_MODE=true to run against mock providers.',
    );
  }
}
