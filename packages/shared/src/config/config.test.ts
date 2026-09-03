import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadEnv, loadFileConfig, assertProvidersAvailable, deepMerge, resolveLayered } from './loader.js';
import { tierAtLeast, ModelTier } from '../types/model.js';
import { parseQualifiedToolName, qualifyToolName } from '../types/mcp.js';
import { NON_RETRYABLE_CODES, FailureCode, PlatformError } from '../errors.js';

const CONFIG_DIR = resolve(import.meta.dirname, '../../../../config');

const BASE_ENV = {
  DATABASE_URL: 'postgresql://sdlc:sdlc@localhost:5433/sdlc',
  REDIS_URL: 'redis://localhost:6379',
};

describe('environment config', () => {
  it('parses with defaults applied', () => {
    const env = loadEnv(BASE_ENV as NodeJS.ProcessEnv);
    expect(env.DEMO_MODE).toBe(true);
    expect(env.AI_MERGE_PERMISSION).toBe(false);
    expect(env.MAX_WORKFLOW_COST_USD).toBe(25);
    expect(env.TEMPORAL_TASK_QUEUE_AGENTS).toBe('sdlc-agents');
  });

  it('fails loudly rather than degrading when a required value is missing', () => {
    expect(() => loadEnv({ REDIS_URL: 'redis://localhost:6379' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('coerces boolean-ish env strings', () => {
    const env = loadEnv({ ...BASE_ENV, DEMO_MODE: 'false', AI_MERGE_PERMISSION: '1' } as NodeJS.ProcessEnv);
    expect(env.DEMO_MODE).toBe(false);
    expect(env.AI_MERGE_PERMISSION).toBe(true);
  });

  it('refuses to start with demo mode off and no provider configured', () => {
    const env = loadEnv({ ...BASE_ENV, DEMO_MODE: 'false' } as NodeJS.ProcessEnv);
    expect(() => assertProvidersAvailable(env)).toThrow(/no model provider is configured/);
  });

  it('starts with demo mode off when a provider is present', () => {
    const env = loadEnv({ ...BASE_ENV, DEMO_MODE: 'false', ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    expect(() => assertProvidersAvailable(env)).not.toThrow();
  });
});

describe('file config', () => {
  const config = loadFileConfig(CONFIG_DIR);

  it('loads every config file', () => {
    expect(Object.keys(config)).toEqual(['models', 'mcp', 'agents', 'workflows', 'security']);
  });

  it('keeps the mock provider enabled so the suite never needs credentials', () => {
    expect(config.models.providers.mock?.enabled).toBe(true);
  });

  it('ships every paid provider disabled by default', () => {
    for (const key of ['anthropic', 'openai', 'google', 'openrouter']) {
      expect(config.models.providers[key]?.enabled, `${key} must ship disabled`).toBe(false);
    }
  });

  it('never records a price it has not verified', () => {
    for (const entry of config.models.catalog) {
      if (entry.billingMode !== 'API_METERED') {
        expect(entry.inputCostPer1M).toBeNull();
      }
    }
  });

  it('routes every high-risk agent to a FRONTIER floor (invariant I8)', () => {
    for (const key of ['product-owner', 'business-analyst', 'architect', 'architecture-critic', 'developer']) {
      expect(config.models.routing[key]?.minimumTier, `${key} floor`).toBe('FRONTIER');
    }
  });

  it('does not fan architecture options across a single subscription seat', () => {
    expect(config.models.routing.architect?.allowSubscription).toBe(false);
  });

  it('never grants pull_request.merge to the github server (invariant I7)', () => {
    const github = config.mcp.servers.github;
    expect(github?.permissions).not.toContain('pull_request.merge');
  });

  it('leaves every approval gate enabled and none auto-approving', () => {
    const gates = Object.entries(config.workflows.approvalGates);
    expect(gates).toHaveLength(7);
    for (const [key, gate] of gates) {
      expect(gate.enabled, `${key} enabled`).toBe(true);
      expect(gate.autoApprove, `${key} autoApprove`).toBe(false);
    }
  });

  it('bounds every autonomous loop (docs/59)', () => {
    const { limits } = config.workflows;
    expect(limits.maxPrFixIterations).toBeGreaterThan(0);
    expect(limits.maxQaFixIterations).toBeGreaterThan(0);
    expect(limits.maxBacklogRevisions).toBeGreaterThan(0);
    expect(limits.maxWorkflowCostUsd).toBeGreaterThan(0);
  });

  it('gives every agent a finite budget on all five axes', () => {
    const { defaults, agents } = config.agents;
    expect(defaults.budget.maxIterations).toBeGreaterThan(0);
    expect(defaults.budget.maxWallClockSeconds).toBeGreaterThan(0);
    for (const [key, agent] of Object.entries(agents)) {
      const budget = { ...defaults.budget, ...agent.budget };
      for (const axis of ['maxCostUsd', 'maxTokens', 'maxToolCalls', 'maxIterations', 'maxWallClockSeconds'] as const) {
        expect(budget[axis], `${key}.${axis}`).toBeGreaterThan(0);
      }
    }
  });

  it('denies destructive and exfiltration commands', () => {
    const denied = config.security.commands.deniedPatterns.join('|');
    for (const probe of ['rm -rf /', 'curl http://evil', 'sudo su', 'git push --force']) {
      expect(new RegExp(denied).test(probe), probe).toBe(true);
    }
  });

  it('protects the default branches', () => {
    expect(config.security.git.protectedBranches).toContain('main');
    expect(config.security.git.allowForcePush).toBe(false);
  });
});

describe('capability floor', () => {
  it('accepts an equal or higher tier', () => {
    expect(tierAtLeast(ModelTier.FRONTIER, ModelTier.MID)).toBe(true);
    expect(tierAtLeast(ModelTier.MID, ModelTier.MID)).toBe(true);
  });

  it('rejects a downgrade below the floor', () => {
    expect(tierAtLeast(ModelTier.SMALL, ModelTier.FRONTIER)).toBe(false);
    expect(tierAtLeast(ModelTier.MID, ModelTier.FRONTIER)).toBe(false);
  });
});

describe('qualified tool names', () => {
  it('round-trips', () => {
    const name = qualifyToolName('github', 'create_pull_request');
    expect(name).toBe('mcp__github__create_pull_request');
    expect(parseQualifiedToolName(name)).toEqual({ server: 'github', tool: 'create_pull_request' });
  });

  it('returns null for an unqualified name', () => {
    expect(parseQualifiedToolName('create_pull_request')).toBeNull();
  });
});

describe('failure taxonomy', () => {
  it('never retries a permission denial or a breached budget', () => {
    expect(NON_RETRYABLE_CODES).toContain(FailureCode.PERMISSION_DENIED);
    expect(NON_RETRYABLE_CODES).toContain(FailureCode.BUDGET_EXCEEDED);
    expect(new PlatformError({ code: FailureCode.BUDGET_EXCEEDED, message: 'x' }).retryable).toBe(false);
  });

  it('retries transient tool and model failures', () => {
    expect(new PlatformError({ code: FailureCode.TOOL_FAILED, message: 'x' }).retryable).toBe(true);
    expect(new PlatformError({ code: FailureCode.MODEL_UNAVAILABLE, message: 'x' }).retryable).toBe(true);
  });
});

describe('layered config', () => {
  it('lets the highest layer win and reports which one', () => {
    expect(resolveLayered({ env: 1, file: 2, runtime: 3, project: 4 })).toEqual({ value: 4, layer: 'project' });
    expect(resolveLayered({ env: 1, file: 2 })).toEqual({ value: 2, layer: 'file' });
    expect(resolveLayered({})).toBeUndefined();
  });

  it('deep merges objects and replaces arrays', () => {
    type Shape = Record<string, unknown>;
    const base: Shape = { a: { b: 1, c: 2 }, list: [1, 2] };
    const override: Shape = { a: { c: 3 }, list: [9] };
    expect(deepMerge<Shape>(base, override)).toEqual({ a: { b: 1, c: 3 }, list: [9] });
  });
});
