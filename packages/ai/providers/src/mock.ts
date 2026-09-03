/**
 * MockModelProvider — deterministic, credential-free model responses.
 *
 * This is what makes `DEMO_MODE=true` and the entire test suite work with no API keys (docs/65).
 * Three resolution strategies, in order:
 *
 *   1. Recorded fixture keyed by request hash — byte-stable replay for golden tests.
 *   2. A registered per-agent handler — used by demo mode to produce realistic artifacts.
 *   3. Loud failure. An unknown key is never answered with an invented response, because a mock
 *      that quietly improvises turns a golden test into a coin flip.
 *
 * Failure injection covers the paths that are otherwise untestable offline: malformed output,
 * truncation, refusal, rate limits and timeouts.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BillingMode,
  type ModelChunk,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderHealth,
  PlatformError,
  FailureCode,
} from '@sdlc/shared';
import { estimateMessageTokens, hashRequest, stableStringify } from '@sdlc/ai-core';

export type MockHandler = (req: ModelRequest) => unknown | Promise<unknown>;

export type MockFailure =
  | { kind: 'malformed' }
  | { kind: 'truncated' }
  | { kind: 'refusal' }
  | { kind: 'rate_limit' }
  | { kind: 'timeout' }
  | { kind: 'unavailable' };

export interface MockFixture {
  requestSha: string;
  text?: string;
  structured?: unknown;
  toolCalls?: { id: string; name: string; input: unknown }[];
  finishReason?: ModelResponse['finishReason'];
}

export interface MockProviderOptions {
  fixtureDir?: string;
  /** Deterministic latency so time-based assertions are stable. */
  latencyMs?: number;
}

export class MockModelProvider implements ModelProvider {
  readonly key = 'mock';
  readonly billingMode = BillingMode.LOCAL_FREE;

  private fixtures = new Map<string, MockFixture>();
  private handlers = new Map<string, MockHandler>();
  private failures = new Map<string, MockFailure>();
  private callLog: { agentKey: string; modelId: string; requestSha: string }[] = [];

  constructor(private readonly options: MockProviderOptions = {}) {
    if (options.fixtureDir && existsSync(options.fixtureDir)) {
      this.loadFixtures(options.fixtureDir);
    }
  }

  loadFixtures(dir: string): void {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as MockFixture | MockFixture[];
      for (const fixture of Array.isArray(parsed) ? parsed : [parsed]) {
        this.fixtures.set(fixture.requestSha, fixture);
      }
    }
  }

  /** Agents register a demo handler at boot; the direction of dependency stays agents → provider. */
  registerHandler(agentKey: string, handler: MockHandler): void {
    this.handlers.set(agentKey, handler);
  }

  /** Force the next call for an agent to fail in a specific way. Consumed on use. */
  injectFailure(agentKey: string, failure: MockFailure): void {
    this.failures.set(agentKey, failure);
  }

  getCallLog(): ReadonlyArray<{ agentKey: string; modelId: string; requestSha: string }> {
    return this.callLog;
  }

  resetCallLog(): void {
    this.callLog = [];
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const agentKey = req.metadata.agentKey;
    const requestSha = hashRequest({
      promptSha: req.system ?? '',
      contextSha: stableStringify(req.messages),
      input: req.tools?.map((t) => t.name) ?? [],
      modelId: req.modelId,
    });
    this.callLog.push({ agentKey, modelId: req.modelId, requestSha });

    const failure = this.failures.get(agentKey);
    if (failure) {
      this.failures.delete(agentKey);
      return this.applyFailure(failure, req, requestSha);
    }

    if (this.options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    }

    const fixture = this.fixtures.get(requestSha);
    if (fixture) {
      return this.respond(req, requestSha, {
        text: fixture.text ?? (fixture.structured ? JSON.stringify(fixture.structured) : ''),
        structured: fixture.structured,
        toolCalls: fixture.toolCalls ?? [],
        finishReason: fixture.finishReason ?? 'stop',
      });
    }

    const handler = this.handlers.get(agentKey);
    if (handler) {
      const value = await handler(req);
      return this.respond(req, requestSha, {
        text: JSON.stringify(value),
        structured: value,
        toolCalls: [],
        finishReason: 'stop',
      });
    }

    throw new PlatformError({
      code: FailureCode.MODEL_UNAVAILABLE,
      message:
        `MockModelProvider has no fixture or handler for agent "${agentKey}" ` +
        `(requestSha ${requestSha.slice(0, 12)}). Record a fixture or register a handler; ` +
        'the mock will not invent a response.',
      details: { agentKey, requestSha, modelId: req.modelId },
    });
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    const response = await this.generate(req);
    for (const word of response.text.split(' ')) {
      yield { type: 'text', text: `${word} ` };
    }
    yield { type: 'done', usage: response.usage };
  }

  async countTokens(req: ModelRequest): Promise<number> {
    return estimateMessageTokens(req.messages, req.system);
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerKey: this.key,
      status: 'HEALTHY',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      message: 'mock provider is always healthy',
    };
  }

  private applyFailure(
    failure: MockFailure,
    req: ModelRequest,
    requestSha: string,
  ): Promise<ModelResponse> {
    switch (failure.kind) {
      case 'malformed':
        return Promise.resolve(
          this.respond(req, requestSha, {
            text: '{ this is not valid json',
            toolCalls: [],
            finishReason: 'stop',
          }),
        );
      case 'truncated':
        return Promise.resolve(
          this.respond(req, requestSha, {
            text: '{"stories": [{"ref": "US-1", "title": "trunc',
            toolCalls: [],
            finishReason: 'length',
          }),
        );
      case 'refusal':
        return Promise.resolve(
          this.respond(req, requestSha, { text: '', toolCalls: [], finishReason: 'refusal' }),
        );
      case 'rate_limit':
        return Promise.reject(
          new PlatformError({
            code: FailureCode.MODEL_UNAVAILABLE,
            message: 'mock: rate limited',
            details: { retryAfterMs: 1000 },
          }),
        );
      case 'timeout':
        return Promise.reject(
          new PlatformError({ code: FailureCode.MODEL_UNAVAILABLE, message: 'mock: timeout' }),
        );
      case 'unavailable':
        return Promise.reject(
          new PlatformError({ code: FailureCode.MODEL_UNAVAILABLE, message: 'mock: provider down' }),
        );
    }
  }

  private respond(
    req: ModelRequest,
    _requestSha: string,
    parts: {
      text: string;
      structured?: unknown;
      toolCalls: { id: string; name: string; input: unknown }[];
      finishReason: ModelResponse['finishReason'];
    },
  ): ModelResponse {
    const inputTokens = estimateMessageTokens(req.messages, req.system);
    return {
      content: [{ type: 'text', text: parts.text }],
      text: parts.text,
      toolCalls: parts.toolCalls,
      structured: parts.structured,
      usage: {
        inputTokens,
        outputTokens: Math.ceil(parts.text.length / 3.4),
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      costUsd: 0,
      costUnknown: false,
      quotaUnits: 0,
      finishReason: parts.finishReason,
      modelId: req.modelId,
      providerKey: this.key,
      billingMode: this.billingMode,
      latencyMs: this.options.latencyMs ?? 0,
    };
  }
}
