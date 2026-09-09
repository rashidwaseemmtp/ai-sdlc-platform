/**
 * The model layer — one function, three adapters.
 *
 * `chat()` takes a provider-neutral conversation and returns a provider-neutral turn: some text,
 * possibly some tool calls, possibly a structured object. Everything above it (the tool loop, the
 * schema validation, the audit rows) is written once and works on every provider.
 *
 * The three adapters:
 *   · **anthropic**   the official SDK — structured output, tool use, prompt caching.
 *   · **compatible**  the OpenAI chat-completions shape, which OpenAI, Google's published
 *                     compatible endpoint, OpenRouter and Ollama all serve. One adapter, four
 *                     providers.
 *   · **cli**         a vendor's own CLI in headless mode, entitled by a subscription. Holds no
 *                     credential, and cannot carry tools — see the note in `providers.ts`.
 *
 * There is no router, no fallback chain and no circuit breaker. One entitlement is active; a
 * failure is reported rather than quietly re-billed to a second vendor.
 */

import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import OpenAI from 'openai';
import { modeSpec } from './providers.js';
import { NotConfiguredError, type Selection } from './settings.js';

export { NotConfiguredError } from './settings.js';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolInvocation {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolInvocation[] }
  /** All results from one round of tool calls, together — several providers require that. */
  | { role: 'tool'; results: { id: string; name: string; content: string; isError?: boolean }[] };

export interface ChatRequest {
  system: string;
  messages: Msg[];
  /** Offered tools. Empty means none, which is also when a structured answer is demanded. */
  tools: ToolSpec[];
  /** The shape the final answer must take. Requested only once no tools are in play. */
  schema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  effort: string;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolInvocation[];
  structured?: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Subscription runs cost nothing per token but consume plan quota; this counts the calls. */
  quotaUnits: number;
  finish: 'stop' | 'tools' | 'length' | 'refusal';
}

export async function chat(req: ChatRequest, selection: Selection): Promise<ChatResponse> {
  const spec = modeSpec(selection.providerKey, selection.mode);
  if (!spec) throw new NotConfiguredError(`Unknown provider pair ${selection.providerKey}:${selection.mode}.`);

  if (req.tools.length > 0 && !spec.supportsTools) {
    throw new NotConfiguredError(
      `${selection.label} cannot carry MCP tools. Set a tool provider on the Settings page.`,
    );
  }

  const bare =
    selection.mode === 'subscription'
      ? await callCli(req, selection)
      : selection.providerKey === 'anthropic'
        ? await callAnthropic(req, selection)
        : await callCompatible(req, selection);

  return {
    ...bare,
    costUsd: price(bare.inputTokens, bare.outputTokens, selection),
  };
}

type Bare = Omit<ChatResponse, 'costUsd'>;

function price(inputTokens: number, outputTokens: number, selection: Selection): number {
  const cost =
    (inputTokens / 1_000_000) * selection.inputCostPer1M +
    (outputTokens / 1_000_000) * selection.outputCostPer1M;
  return Math.round(cost * 1e6) / 1e6;
}

// ── Anthropic ──────────────────────────────────────────────────────────────

async function callAnthropic(req: ChatRequest, selection: Selection): Promise<Bare> {
  const client = new Anthropic({
    apiKey: selection.apiKey,
    ...(selection.baseUrl ? { baseURL: selection.baseUrl } : {}),
    timeout: 10 * 60_000,
  });

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: selection.model || 'claude-opus-5',
    max_tokens: req.maxOutputTokens,
    // The system prompt is the stable prefix, so it is where the cache breakpoint belongs.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: toAnthropicMessages(req.messages),
    thinking: { type: 'adaptive' },
    output_config: { effort: req.effort as 'high' },
  };

  if (req.tools.length) {
    params.tools = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    }));
    params.tool_choice = { type: 'auto' };
  }

  // Structured output is only requested once no tools remain in play: a model asked for both at
  // once will usually satisfy the schema and skip the tools.
  const wantsStructured = Boolean(req.schema) && req.tools.length === 0;
  const response = wantsStructured
    ? await client.messages.parse({
        ...params,
        output_config: {
          ...params.output_config,
          format: jsonSchemaOutputFormat(req.schema!.schema as Parameters<typeof jsonSchemaOutputFormat>[0]),
        },
      })
    : await client.messages.create(params);

  let text = '';
  const toolCalls: ToolInvocation[] = [];
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
    }
    // `thinking` blocks are deliberately not collected: chain-of-thought is never stored.
  }

  return {
    text,
    toolCalls,
    structured: wantsStructured ? ((response as { parsed_output?: unknown }).parsed_output ?? undefined) : undefined,
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    quotaUnits: 0,
    finish: mapAnthropicStop(response.stop_reason, toolCalls.length),
  };
}

function mapAnthropicStop(reason: string | null | undefined, toolCount: number): ChatResponse['finish'] {
  if (reason === 'refusal') return 'refusal';
  if (reason === 'max_tokens') return 'length';
  return toolCount > 0 ? 'tools' : 'stop';
}

function toAnthropicMessages(messages: Msg[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user' as const, content: message.text };

    if (message.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      return { role: 'assistant' as const, content };
    }

    // Every result from one round goes back in a single user message, which is what the API wants.
    return {
      role: 'user' as const,
      content: message.results.map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      })),
    };
  });
}

// ── OpenAI-compatible (openai · google · openrouter · ollama) ──────────────

async function callCompatible(req: ChatRequest, selection: Selection): Promise<Bare> {
  const client = new OpenAI({
    apiKey: selection.apiKey || 'not-needed',
    ...(selection.baseUrl ? { baseURL: selection.baseUrl } : {}),
    timeout: 10 * 60_000,
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }];
  for (const message of req.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            }
          : {}),
      });
    } else {
      // Unlike Anthropic, each result is its own message.
      for (const result of message.results) {
        messages.push({ role: 'tool', tool_call_id: result.id, content: result.content });
      }
    }
  }

  const wantsStructured = Boolean(req.schema) && req.tools.length === 0;
  const response = await client.chat.completions.create({
    model: selection.model || 'gpt-5',
    max_completion_tokens: req.maxOutputTokens,
    messages,
    ...(req.tools.length
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function' as const,
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          })),
        }
      : {}),
    ...(wantsStructured
      ? {
          response_format:
            // Ollama's compatible endpoint accepts json_object but not a full json_schema, so it
            // gets the looser constraint and leans on the schema being restated in the prompt.
            selection.providerKey === 'ollama'
              ? ({ type: 'json_object' } as const)
              : ({
                  type: 'json_schema',
                  json_schema: { name: req.schema!.name, schema: req.schema!.schema, strict: false },
                } as const),
        }
      : {}),
  });

  const choice = response.choices[0];
  const rawCalls = choice?.message?.tool_calls ?? [];
  const toolCalls: ToolInvocation[] = rawCalls.flatMap((call) => {
    if (!('function' in call)) return [];
    // Never string-match a serialised tool argument; providers escape JSON differently.
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    return [{ id: call.id, name: call.function.name, args }];
  });

  const text = choice?.message?.content ?? '';
  return {
    text,
    toolCalls,
    structured: wantsStructured && text ? safeJson(text) : undefined,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    quotaUnits: 0,
    finish:
      choice?.finish_reason === 'length'
        ? 'length'
        : toolCalls.length > 0
          ? 'tools'
          : 'stop',
  };
}

// ── Subscription CLI (claude · codex · gemini) ─────────────────────────────

/**
 * Drive a vendor's own CLI in headless mode.
 *
 * Four things make this genuinely different from an API adapter, and the design respects all four:
 * the platform holds no credential; the vendor's API-key variables are stripped from the child
 * environment so a stray key cannot silently divert the run onto metered billing; cost is zero but
 * quota is not, so a run reports `quotaUnits` rather than a misleading $0.00; and a seat is
 * serialised, so it is never handed a tool loop to run in parallel.
 */
async function callCli(req: ChatRequest, selection: Selection): Promise<Bare> {
  const spec = modeSpec(selection.providerKey, selection.mode);
  const cli = spec?.cli;
  if (!cli) throw new NotConfiguredError(`${selection.providerKey} has no subscription CLI configured.`);

  const command = selection.command || cli.command;
  const args = [
    ...cli.execArgs,
    // A blank model means "whatever the plan gives us"; pinning it would invent a model id.
    ...(cli.modelFlag && selection.model ? [cli.modelFlag, selection.model] : []),
  ];

  const prompt = renderFlatPrompt(req);
  const { stdout, stderr, code } = await run(command, args, prompt, cli.stripEnv);

  // These CLIs report their own failures in the *stdout* envelope, not on stderr — an
  // unauthenticated `claude -p` exits 1 with an empty stderr and `{"is_error":true,"result":"Not
  // logged in · Please run /login"}` on stdout. Reading only stderr turns a precise, actionable
  // message into a blank one, so the envelope is checked first.
  const envelope = safeJson(stdout) as (CliEnvelope & { is_error?: boolean }) | undefined;
  const reported = envelope?.result ?? envelope?.response ?? envelope?.text;

  if (code !== 0 || envelope?.is_error) {
    const detail = (reported ?? stderr ?? '').trim().slice(0, 400) || `exited ${code} with no output`;
    throw new Error(
      `${command}: ${detail}\n` +
        `If this is an authentication failure, sign in inside the backend container:\n` +
        `  docker compose exec backend ${cli.loginCommand}`,
    );
  }

  const { text, inputTokens, outputTokens } = parseCliStdout(stdout, cli.stdout, prompt);
  return {
    text,
    toolCalls: [],
    structured: req.schema ? safeJson(text) : undefined,
    inputTokens,
    outputTokens,
    quotaUnits: 1,
    finish: 'stop',
  };
}

/** Headless mode takes one prompt, so the conversation is flattened deterministically. */
function renderFlatPrompt(req: ChatRequest): string {
  const parts: string[] = [req.system, ''];
  for (const message of req.messages) {
    if (message.role === 'user') parts.push(message.text, '');
    else if (message.role === 'assistant') parts.push(`Assistant: ${message.text}`, '');
    else parts.push(message.results.map((result) => result.content).join('\n'), '');
  }
  if (req.schema) {
    parts.push(
      'Respond with a single JSON object matching this schema. No prose, no markdown fences:',
      JSON.stringify(req.schema.schema),
    );
  }
  return parts.join('\n');
}

interface CliEnvelope {
  result?: string;
  response?: string;
  text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function parseCliStdout(
  stdout: string,
  shape: 'json' | 'text',
  prompt: string,
): { text: string; inputTokens: number; outputTokens: number } {
  // ~3.4 characters per token is close enough to keep the dashboard's numbers honest for vendors
  // whose CLI reports no usage at all.
  const estimate = (value: string): number => Math.ceil(value.length / 3.4);

  if (shape === 'text') {
    const text = stdout.trim();
    return { text, inputTokens: estimate(prompt), outputTokens: estimate(text) };
  }

  const envelope = safeJson(stdout) as CliEnvelope | undefined;
  const text = (envelope?.result ?? envelope?.response ?? envelope?.text ?? stdout).trim();
  return {
    text,
    inputTokens: envelope?.usage?.input_tokens ?? estimate(prompt),
    outputTokens: envelope?.usage?.output_tokens ?? estimate(text),
  };
}

function run(
  command: string,
  args: string[],
  stdin: string,
  stripEnv: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of stripEnv) delete env[name];

    const child = spawn(command, args, { env, shell: process.platform === 'win32' });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after 15 minutes`));
    }, 900_000);

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Could not start ${command}: ${error.message}. Install the CLI in the backend container ` +
            'and sign in — see the Settings page for the exact command.',
        ),
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

/**
 * Probe a subscription CLI for the Settings page.
 *
 * Installed and signed-in are separate facts and only the second one makes a run possible, so they
 * are reported separately rather than one being inferred from the other. `signedIn` is null when
 * the vendor ships no way to ask.
 */
export async function probeCli(
  command: string,
  probeArgs: string[],
  statusArgs?: string[],
  signedOutMarkers: string[] = [],
): Promise<{ installed: boolean; detail: string; signedIn: boolean | null; status: string }> {
  let installed = false;
  let detail = '';

  try {
    const { stdout, stderr, code } = await run(command, probeArgs, '', []);
    installed = code === 0;
    detail = installed
      ? (stdout.trim().split('\n')[0] ?? 'installed')
      : (stderr || stdout).trim().slice(0, 200);
  } catch (error) {
    return { installed: false, detail: (error as Error).message, signedIn: null, status: '' };
  }

  if (!installed || !statusArgs) return { installed, detail, signedIn: null, status: '' };

  try {
    const { stdout, stderr, code } = await run(command, statusArgs, '', []);
    const output = `${stdout}${stderr}`.trim();
    const signedOut =
      code !== 0 || signedOutMarkers.some((marker) => output.toLowerCase().includes(marker.toLowerCase()));
    return { installed, detail, signedIn: !signedOut, status: output.slice(0, 300) };
  } catch {
    return { installed, detail, signedIn: null, status: '' };
  }
}

// ── parsing ────────────────────────────────────────────────────────────────

/**
 * Pull a JSON object out of a response that may be wrapped in prose or a fenced block.
 * Returns undefined rather than throwing; the caller decides whether an absent object is fatal.
 */
export function safeJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}
