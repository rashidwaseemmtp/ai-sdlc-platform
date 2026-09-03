/**
 * Anthropic adapter — uses the official `@anthropic-ai/sdk` and its own exported types.
 *
 * Pinned behaviour for the current model generation:
 *   - Reasoning is `thinking: { type: 'adaptive' }`. `budget_tokens` is REJECTED with a 400 on
 *     Opus 5, so this adapter must never emit it; depth is controlled by `output_config.effort`.
 *   - Assistant prefill is removed on this generation — structured output is used instead.
 *   - Thinking `display` is left at its default (omitted). The platform never surfaces or stores
 *     chain-of-thought (invariant I9), so there is nothing to gain by asking for it.
 *   - Streaming is used for large `max_tokens` to stay under HTTP timeouts.
 *   - The prompt-cache breakpoint sits on the system block: `tools -> system -> messages` is the
 *     render order, so a stable system prefix is what makes repeated agent runs cheap.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import {
  BillingMode,
  FailureCode,
  PlatformError,
  type ContentBlock,
  type ModelChunk,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderHealth,
  type ToolCall,
} from '@sdlc/shared';
import { estimateMessageTokens } from '@sdlc/ai-core';

/** Above this the SDK requires streaming to avoid request timeouts. */
const STREAMING_THRESHOLD_TOKENS = 20_000;

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export class AnthropicProvider implements ModelProvider {
  readonly key = 'anthropic';
  readonly billingMode = BillingMode.API_METERED;

  private client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    // A bare constructor resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
    // profile — an unset API key does not mean there are no credentials.
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 600_000,
    });
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const params = this.buildParams(req);

    try {
      // Native structured output, but only when no tools compete for the turn.
      if (req.outputSchema && !req.tools?.length) {
        const response = await this.client.messages.parse({
          ...params,
          output_config: {
            ...params.output_config,
            format: jsonSchemaOutputFormat(
              req.outputSchema as Parameters<typeof jsonSchemaOutputFormat>[0],
            ),
          },
        });
        return this.toModelResponse(req, response, started, {
          structured: response.parsed_output ?? undefined,
        });
      }

      if (req.maxOutputTokens > STREAMING_THRESHOLD_TOKENS) {
        const stream = this.client.messages.stream(params);
        return this.toModelResponse(req, await stream.finalMessage(), started, {});
      }

      const response = await this.client.messages.create(params);
      return this.toModelResponse(req, response, started, {});
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    try {
      const stream = this.client.messages.stream(this.buildParams(req));
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      yield { type: 'done', usage: this.toUsage(final) };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async countTokens(req: ModelRequest): Promise<number> {
    try {
      const params = this.buildParams(req);
      const result = await this.client.messages.countTokens({
        model: params.model,
        messages: params.messages,
        ...(params.system ? { system: params.system } : {}),
        ...(params.tools ? { tools: params.tools } : {}),
      });
      return result.input_tokens;
    } catch {
      // Token counting is advisory; a failure here must not fail the run.
      return estimateMessageTokens(req.messages, req.system);
    }
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.client.models.list({ limit: 1 });
      return {
        providerKey: this.key,
        status: 'HEALTHY',
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
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

  async listModels(): Promise<never[]> {
    // Catalog sync happens in the router against `models.list()`; capability metadata is
    // configuration, not something the API reports in the shape we need.
    return [];
  }

  // ── internals ────────────────────────────────────────────────────────────

  private buildParams(req: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.modelId,
      max_tokens: req.maxOutputTokens,
      messages: this.toAnthropicMessages(req),
    };

    if (req.system) {
      params.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
    }

    // Never emit budget_tokens — it is a 400 on this model generation.
    if (req.reasoning !== 'off') {
      params.thinking = { type: 'adaptive' };
    }
    if (req.effort) {
      params.output_config = { effort: req.effort };
    }

    if (req.tools?.length) {
      params.tools = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
        ...(tool.strict ? { strict: true } : {}),
      }));
      if (req.toolChoice === 'none') params.tool_choice = { type: 'none' };
      else if (typeof req.toolChoice === 'object') {
        params.tool_choice = { type: 'tool', name: req.toolChoice.name };
      }
    }

    if (req.stopSequences?.length) params.stop_sequences = req.stopSequences;
    return params;
  }

  private toAnthropicMessages(req: ModelRequest): Anthropic.MessageParam[] {
    return req.messages
      .filter((m) => m.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((block) => this.toAnthropicBlock(block)),
      }));
  }

  private toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
    switch (block.type) {
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.toolUseId ?? '',
          name: block.name ?? '',
          input: block.input ?? {},
        };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId ?? '',
          content:
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          ...(block.isError ? { is_error: true } : {}),
        };
      default:
        return { type: 'text', text: block.text ?? '' };
    }
  }

  private toUsage(message: Anthropic.Message): ModelResponse['usage'] {
    return {
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cachedReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cachedWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
  }

  private toModelResponse(
    req: ModelRequest,
    message: Anthropic.Message,
    started: number,
    extra: { structured?: unknown },
  ): ModelResponse {
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let text = '';

    for (const block of message.content) {
      if (block.type === 'text') {
        text += block.text;
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
        content.push({
          type: 'tool_use',
          toolUseId: block.id,
          name: block.name,
          input: block.input,
        });
      }
      // `thinking` blocks are deliberately not collected — invariant I9.
    }

    return {
      content,
      text,
      toolCalls,
      structured: extra.structured,
      usage: this.toUsage(message),
      costUsd: 0, // priced by the router against the catalog entry
      costUnknown: false,
      quotaUnits: 0,
      finishReason: mapStopReason(message.stop_reason),
      modelId: req.modelId,
      providerKey: this.key,
      billingMode: this.billingMode,
      latencyMs: Date.now() - started,
    };
  }

  private translateError(error: unknown): PlatformError {
    if (error instanceof PlatformError) return error;
    const status = (error as { status?: number }).status;
    const message = (error as Error).message ?? 'anthropic request failed';

    // 429 and 5xx are transient — the router should fall back rather than fail the activity.
    if (status === 429 || (status !== undefined && status >= 500) || status === undefined) {
      return new PlatformError({
        code: FailureCode.MODEL_UNAVAILABLE,
        message,
        details: { status, provider: this.key },
        cause: error,
      });
    }
    return new PlatformError({
      code: FailureCode.AGENT_FAILED,
      message,
      details: { status, provider: this.key },
      cause: error,
    });
  }
}

function mapStopReason(reason: string | null | undefined): ModelResponse['finishReason'] {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'refusal';
    default:
      return 'stop';
  }
}
