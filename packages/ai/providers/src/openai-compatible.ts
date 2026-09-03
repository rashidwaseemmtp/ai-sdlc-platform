/**
 * OpenAI-compatible adapter.
 *
 * Covers OpenAI itself, OpenRouter, Ollama, vLLM, LM Studio and any custom endpoint speaking the
 * same wire format. This is the *one* place a shim is legitimate: those servers genuinely
 * implement the OpenAI API. It is never pointed at a vendor with its own SDK.
 */

import OpenAI from 'openai';
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

export interface OpenAICompatibleOptions {
  key: string;
  apiKey?: string;
  baseUrl?: string;
  billingMode?: BillingMode;
  maxRetries?: number;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly key: string;
  readonly billingMode: BillingMode;

  private client: OpenAI;

  constructor(options: OpenAICompatibleOptions) {
    this.key = options.key;
    this.billingMode = options.billingMode ?? BillingMode.API_METERED;
    this.client = new OpenAI({
      // Local servers accept any key; sending a placeholder keeps the SDK happy.
      apiKey: options.apiKey ?? 'not-required',
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 600_000,
      ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
    });
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: req.modelId,
        max_completion_tokens: req.maxOutputTokens,
        messages: this.toMessages(req),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((tool) => ({
                type: 'function' as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                  ...(tool.strict ? { strict: true } : {}),
                },
              })),
              tool_choice:
                req.toolChoice === 'none'
                  ? ('none' as const)
                  : typeof req.toolChoice === 'object'
                    ? ({ type: 'function' as const, function: { name: req.toolChoice.name } })
                    : ('auto' as const),
            }
          : {}),
        ...(req.outputSchema && !req.tools?.length
          ? {
              response_format: {
                type: 'json_schema' as const,
                json_schema: { name: 'output', schema: req.outputSchema, strict: true },
              },
            }
          : {}),
        ...(req.stopSequences?.length ? { stop: req.stopSequences } : {}),
      });

      const choice = response.choices[0];
      const text = choice?.message?.content ?? '';
      const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).flatMap((call) =>
        'function' in call
          ? [{ id: call.id, name: call.function.name, input: safeParse(call.function.arguments) }]
          : [],
      );

      const content: ContentBlock[] = [];
      if (text) content.push({ type: 'text', text });
      for (const call of toolCalls) {
        content.push({ type: 'tool_use', toolUseId: call.id, name: call.name, input: call.input });
      }

      return {
        content,
        text,
        toolCalls,
        structured: req.outputSchema && text ? safeParse(text) : undefined,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          cachedReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cachedWriteTokens: 0,
        },
        costUsd: 0,
        costUnknown: false,
        quotaUnits: 0,
        finishReason: mapFinishReason(choice?.finish_reason),
        modelId: req.modelId,
        providerKey: this.key,
        billingMode: this.billingMode,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    try {
      const stream = await this.client.chat.completions.create({
        model: req.modelId,
        max_completion_tokens: req.maxOutputTokens,
        messages: this.toMessages(req),
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield { type: 'text', text: delta };
        if (chunk.usage) {
          yield {
            type: 'done',
            usage: {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              cachedReadTokens: 0,
              cachedWriteTokens: 0,
            },
          };
        }
      }
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async countTokens(req: ModelRequest): Promise<number> {
    return estimateMessageTokens(req.messages, req.system);
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.client.models.list();
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

  private toMessages(req: ModelRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });

    for (const message of req.messages) {
      if (typeof message.content === 'string') {
        messages.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.content,
        } as OpenAI.Chat.ChatCompletionMessageParam);
        continue;
      }

      const toolResults = message.content.filter((b) => b.type === 'tool_result');
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolUseId ?? '',
          content:
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        });
      }

      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');

      if (toolUses.length) {
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((use) => ({
            id: use.toolUseId ?? '',
            type: 'function' as const,
            function: { name: use.name ?? '', arguments: JSON.stringify(use.input ?? {}) },
          })),
        });
      } else if (text && !toolResults.length) {
        messages.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: text,
        } as OpenAI.Chat.ChatCompletionMessageParam);
      }
    }
    return messages;
  }

  private translateError(error: unknown): PlatformError {
    const status = (error as { status?: number }).status;
    const message = (error as Error).message ?? 'request failed';
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

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function mapFinishReason(reason: string | null | undefined): ModelResponse['finishReason'] {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'stop';
  }
}
