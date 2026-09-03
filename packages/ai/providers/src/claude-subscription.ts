/**
 * Claude subscription adapter — drives the locally installed `claude` CLI in headless mode.
 *
 * This is the SUBSCRIPTION billing mode from docs/05 §1. Three things make it different from
 * every other adapter, and the design has to respect all three:
 *
 *   1. **We hold no credential.** The CLI owns the login session; no key crosses this process.
 *      That is a security property, not a limitation.
 *   2. **Cost is zero but capacity is not.** It reports `costUsd: 0` with `quotaUnits: 1`, so the
 *      dashboard shows a quota column rather than a misleading blank, and `MAX_WORKFLOW_COST`
 *      cannot police it — iteration and wall-clock ceilings do.
 *   3. **A seat is serialised.** The router holds a semaphore before selecting this provider, so
 *      three parallel architect runs never contend on one seat.
 */

import { spawn } from 'node:child_process';
import {
  BillingMode,
  FailureCode,
  PlatformError,
  type ModelChunk,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderHealth,
} from '@sdlc/shared';
import { estimateMessageTokens, extractJson } from '@sdlc/ai-core';

export interface ClaudeSubscriptionOptions {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  cwd?: string;
}

export class ClaudeSubscriptionProvider implements ModelProvider {
  readonly key = 'claude-subscription';
  readonly billingMode = BillingMode.SUBSCRIPTION;

  constructor(private readonly options: ClaudeSubscriptionOptions = {}) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const command = this.options.command ?? 'claude';

    // Tool use is not exposed through headless mode, so the runtime must not bind MCP tools to an
    // agent routed here. Failing loudly beats silently dropping the agent's tools.
    if (req.tools?.length) {
      throw new PlatformError({
        code: FailureCode.NO_ELIGIBLE_MODEL,
        message:
          'The claude-subscription provider cannot expose MCP tools. Route tool-using agents to ' +
          'an API-metered provider, or set allowSubscription: false for this agent.',
        details: { agentKey: req.metadata.agentKey, toolCount: req.tools.length },
      });
    }

    const prompt = this.renderPrompt(req);
    const args = [
      '-p',
      '--output-format',
      'json',
      ...(req.modelId && req.modelId !== 'default' ? ['--model', req.modelId] : []),
      ...(this.options.extraArgs ?? []),
    ];

    const { stdout, stderr, code } = await this.run(command, args, prompt);

    if (code !== 0) {
      throw new PlatformError({
        code: FailureCode.MODEL_UNAVAILABLE,
        message: `claude CLI exited ${code}: ${stderr.slice(0, 500)}`,
        details: { provider: this.key },
      });
    }

    const parsed = extractJson<ClaudeCliResult>(stdout);
    const text = parsed.ok && parsed.value ? (parsed.value.result ?? '') : stdout.trim();

    return {
      content: [{ type: 'text', text }],
      text,
      toolCalls: [],
      structured: req.outputSchema ? (extractJson(text).value ?? undefined) : undefined,
      usage: {
        inputTokens: parsed.value?.usage?.input_tokens ?? estimateMessageTokens(req.messages, req.system),
        outputTokens: parsed.value?.usage?.output_tokens ?? Math.ceil(text.length / 3.4),
        cachedReadTokens: parsed.value?.usage?.cache_read_input_tokens ?? 0,
        cachedWriteTokens: 0,
      },
      costUsd: 0,
      costUnknown: false,
      quotaUnits: 1,
      finishReason: 'stop',
      modelId: req.modelId,
      providerKey: this.key,
      billingMode: this.billingMode,
      latencyMs: Date.now() - started,
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    const response = await this.generate(req);
    yield { type: 'text', text: response.text };
    yield { type: 'done', usage: response.usage };
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const { code } = await this.run(this.options.command ?? 'claude', ['--version'], '');
      return {
        providerKey: this.key,
        status: code === 0 ? 'HEALTHY' : 'UNHEALTHY',
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        ...(code === 0 ? {} : { message: 'claude CLI not available or not logged in' }),
      };
    } catch (error) {
      return {
        providerKey: this.key,
        status: 'UNHEALTHY',
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        message: (error as Error).message,
      };
    }
  }

  /** Headless mode takes a single prompt, so the conversation is flattened deterministically. */
  private renderPrompt(req: ModelRequest): string {
    const parts: string[] = [];
    if (req.system) parts.push(req.system, '');
    for (const message of req.messages) {
      const body =
        typeof message.content === 'string'
          ? message.content
          : message.content.map((b) => b.text ?? JSON.stringify(b.content ?? b.input ?? '')).join('\n');
      parts.push(message.role === 'assistant' ? `Assistant: ${body}` : body, '');
    }
    if (req.outputSchema) {
      parts.push(
        'Respond with a single JSON object matching this schema. No prose, no markdown fences:',
        JSON.stringify(req.outputSchema),
      );
    }
    return parts.join('\n');
  }

  private run(
    command: string,
    args: string[],
    stdin: string,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.options.cwd ?? process.cwd(),
        shell: process.platform === 'win32',
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new PlatformError({
            code: FailureCode.MODEL_UNAVAILABLE,
            message: 'claude CLI timed out',
            details: { provider: this.key },
          }),
        );
      }, this.options.timeoutMs ?? 900_000);

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new PlatformError({
            code: FailureCode.MODEL_UNAVAILABLE,
            message: `could not start ${command}: ${error.message}`,
            details: { provider: this.key },
          }),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });

      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

interface ClaudeCliResult {
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}
