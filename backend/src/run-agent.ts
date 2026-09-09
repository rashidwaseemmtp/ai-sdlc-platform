/**
 * Running one agent.
 *
 * The shape, in order, with no branch that skips validation or the audit row:
 *
 *   1. open the run row            5. the tool loop, bounded
 *   2. bind the agent's tools      6. validate against the agent's schema
 *   3. pick the entitlement        7. one repair turn, then give up
 *   4. render prompt and context   8. run the platform's checks, persist, close the run
 *
 * The run row is created *before* the model is called, so a crash mid-call is still attributable
 * and still visible. Nothing reaches the domain tables until every HARD check has passed — an
 * agent cannot half-persist.
 *
 * Which entitlement answers is decided here, from one fact: whether this agent has MCP grants. An
 * agent with tools cannot run on a subscription CLI (the tool would bypass the permission engine),
 * so it is sent to the configured tool provider instead.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Prisma } from '@prisma/client';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { db, logEvent } from './db.js';
import { buildContext } from './context.js';
import { chat, type Msg, type ToolSpec } from './llm.js';
import { bindTools, callTool, hasGrants, type ToolContext } from './mcp.js';
import { getSettings, selectFor } from './settings.js';
import { getAgent, type AgentInput, type ChangeRequest } from './agents/index.js';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/** How many model turns one agent may take before the loop is declared stuck. */
const MAX_TURNS = 25;

export interface RunAgentInput {
  agentKey: string;
  projectId: string;
  /** Free label for the run list: `round-2`, `independent`, `US-101`. */
  phase?: string;
  mode?: 'create' | 'revise';
  changeRequests?: ChangeRequest[];
  vars?: Record<string, unknown>;
}

export interface AgentRunResult {
  agentRunId: string;
  output: unknown;
  summary: string;
  costUsd: number;
  /** Failed SOFT checks. Shown to the approver rather than failing the run. */
  warnings: string[];
  toolCalls: number;
}

export async function runAgent(request: RunAgentInput): Promise<AgentRunResult> {
  const agent = getAgent(request.agentKey);
  const settings = await getSettings();
  const started = Date.now();

  const input: AgentInput = {
    projectId: request.projectId,
    mode: request.mode ?? 'create',
    changeRequests: request.changeRequests ?? [],
    vars: request.vars ?? {},
  };

  // Bound before the entitlement is chosen, not after: what the agent can reach decides which
  // entitlements are eligible, and discovering the mismatch mid-call costs a failed run.
  const tools = (await hasGrants(agent.key)) ? await bindTools(agent.key) : [];
  const selection = selectFor(settings, tools.length > 0);

  const run = await db.agentRun.create({
    data: {
      projectId: request.projectId,
      agentKey: agent.key,
      phase: request.phase ?? '',
      status: 'RUNNING',
      model: selection.model || '(plan default)',
      provider: selection.providerKey,
      authMode: selection.mode,
      input: {
        mode: input.mode,
        vars: input.vars,
        changeRequests: input.changeRequests,
        tools: tools.map((tool) => tool.name),
      } as unknown as Prisma.InputJsonValue,
    },
  });

  try {
    const system = renderPrompt(agent.key, input.vars);
    const context = await buildContext(request.projectId, agent.context, input.vars);
    const schema = {
      name: agent.key.replace(/-/g, '_'),
      schema: zodToJsonSchema(agent.schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<
        string,
        unknown
      >,
    };

    const messages: Msg[] = [
      {
        role: 'user',
        text: [
          context,
          '',
          '<task>',
          agent.task?.(input) ?? 'Produce your output for this project.',
          '</task>',
          '',
          tools.length
            ? 'Use the tools available to you to gather what you need. When you have finished using ' +
              'tools, reply with a single JSON object matching the required output schema.'
            : 'Respond with a single JSON object matching the required output schema. No prose around it.',
        ].join('\n'),
      },
    ];

    const toolCtx: ToolContext = {
      agentKey: agent.key,
      agentRunId: run.id,
      counts: new Map(),
      maxCallsPerRun: settings.limits.toolCallsPerRun,
    };

    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let quotaUnits = 0;
    let toolCallCount = 0;
    let answer: { text: string; structured?: unknown } | undefined;

    // ── the tool loop ──────────────────────────────────────────────────────
    //
    // Tools are offered while the agent is still gathering. Once it stops asking for them they are
    // withdrawn and the schema is demanded, because a model offered both at once will usually
    // satisfy the schema and skip the tools it needed.
    let offered: ToolSpec[] = tools;

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const response = await chat(
        {
          system,
          messages,
          tools: offered,
          schema,
          maxOutputTokens: settings.maxOutputTokens,
          effort: settings.effort,
        },
        selection,
      );

      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;
      costUsd += response.costUsd;
      quotaUnits += response.quotaUnits;

      if (response.finish === 'refusal') throw new Error('The model declined to answer this request.');
      if (response.finish === 'length') {
        throw new Error(
          'The model hit its output limit before finishing. Raise "max output tokens" in Settings, ' +
            'or narrow the work — a truncated document is deliberately not parsed.',
        );
      }

      if (response.toolCalls.length === 0) {
        if (offered.length > 0) {
          // It stopped asking for tools. Withdraw them and ask once more for the structured answer.
          offered = [];
          messages.push({ role: 'assistant', text: response.text, toolCalls: [] });
          messages.push({ role: 'user', text: 'Now produce the final JSON object for this task.' });
          continue;
        }
        answer = { text: response.text, structured: response.structured };
        break;
      }

      messages.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls });

      const results = [];
      for (const call of response.toolCalls) {
        const outcome = await callTool(toolCtx, call.name, call.args);
        toolCallCount += 1;
        results.push({ id: call.id, name: call.name, content: outcome.content, isError: outcome.isError });
      }
      messages.push({ role: 'tool', results });
    }

    if (!answer) {
      throw new Error(
        `${agent.name} used ${MAX_TURNS} turns without producing its answer. Narrow its grants or ` +
          'the task; a loop that never converges is not going to on the next attempt.',
      );
    }

    let parsed = agent.schema.safeParse(answer.structured ?? safeParseJson(answer.text));

    // Exactly one repair turn. A model that fails the schema twice will not succeed on the third,
    // and the remaining budget is better spent telling a human what went wrong.
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      const repair = await chat(
        {
          system,
          messages: [
            ...messages,
            { role: 'assistant', text: answer.text, toolCalls: [] },
            {
              role: 'user',
              text: [
                'Your answer did not match the schema. Fix exactly these problems and return the',
                'complete corrected object:',
                ...errors.map((error) => `- ${error}`),
              ].join('\n'),
            },
          ],
          tools: [],
          schema,
          maxOutputTokens: settings.maxOutputTokens,
          effort: settings.effort,
        },
        selection,
      );

      inputTokens += repair.inputTokens;
      outputTokens += repair.outputTokens;
      costUsd += repair.costUsd;
      quotaUnits += repair.quotaUnits;

      parsed = agent.schema.safeParse(repair.structured ?? safeParseJson(repair.text));
      if (!parsed.success) {
        throw new Error(
          `${agent.name} produced output that does not match its schema, twice. ` +
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).slice(0, 5).join('; '),
        );
      }
    }

    const output = parsed.data;

    const results = (agent.checks ?? []).map((check) => ({
      ...check,
      result: safely(() => check.run(output as never)),
    }));
    const hard = results.filter((entry) => entry.severity === 'HARD' && !entry.result.passed);
    if (hard.length) {
      throw new Error(
        `${agent.name} failed ${hard.length} quality check(s): ` +
          hard.map((entry) => `${entry.code} — ${entry.result.message}`).join('; '),
      );
    }
    const warnings = results
      .filter((entry) => !entry.result.passed)
      .map((entry) => `${entry.code}: ${entry.result.message}`);

    await agent.persist?.(output as never, input);

    if (settings.limits.agentCostUsd > 0 && costUsd > settings.limits.agentCostUsd) {
      throw new Error(
        `${agent.name} cost $${costUsd.toFixed(2)}, over the per-agent ceiling of ` +
          `$${settings.limits.agentCostUsd.toFixed(2)}. Raise it in Settings or use a cheaper model.`,
      );
    }

    const summary = agent.summary(output as never);
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        output: output as object,
        summary,
        warnings,
        inputTokens,
        outputTokens,
        costUsd,
        quotaUnits,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      },
    });

    await logEvent(request.projectId, 'AGENT_RUN_SUCCEEDED', {
      agentKey: agent.key,
      agentRunId: run.id,
      costUsd,
      toolCalls: toolCallCount,
      warnings: warnings.length,
    });

    return { agentRunId: run.id, output, summary, costUsd, warnings, toolCalls: toolCallCount };
  } catch (error) {
    const message = (error as Error).message;
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', error: message, durationMs: Date.now() - started, finishedAt: new Date() },
    });
    await logEvent(request.projectId, 'AGENT_RUN_FAILED', { agentKey: agent.key, agentRunId: run.id, error: message });
    throw error;
  }
}

/** `{{name}}` in a prompt file is replaced by the matching invocation variable. */
function renderPrompt(agentKey: string, vars: Record<string, unknown>): string {
  const body = readFileSync(join(PROMPTS, `${agentKey}.md`), 'utf8');
  return body.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** A model that wraps its JSON in prose still gets parsed; one that returns none fails validation. */
function safeParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');

  for (const candidate of [trimmed, fenced?.[1]?.trim(), first !== -1 && last > first ? trimmed.slice(first, last + 1) : undefined]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

/** A check that throws is a failed check, not a failed run. */
function safely(run: () => { passed: boolean; message: string }): { passed: boolean; message: string } {
  try {
    return run();
  } catch (error) {
    return { passed: false, message: `the check itself threw: ${(error as Error).message}` };
  }
}
