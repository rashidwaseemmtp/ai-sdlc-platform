/**
 * Agent Runtime — docs/04 §2.
 *
 * One Temporal activity, twelve steps, no branch that skips validation or audit. Deterministic in
 * *structure* and non-deterministic in *content*, which is exactly why it lives in an activity
 * rather than in workflow code.
 *
 * The only thing that crosses back to the workflow is an ArtifactRef (invariant I4).
 */

import { z, type ZodType, type ZodTypeDef } from 'zod';

/**
 * A schema whose *output* is T. The input type is intentionally loose: `.default()` and
 * `.optional()` make a Zod schema's input differ from its output, and pinning both would make
 * every agent schema unassignable to its own declaration.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Schema<T> = ZodType<T, ZodTypeDef, any>;
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { PrismaClient } from '@sdlc/database';
import {
  FailureCode,
  InvalidOutputError,
  PlatformError,
  parseQualifiedToolName,
  type AgentDefinition,
  type AgentInvocation,
  type AgentKey,
  type AgentRunResult,
  type ArtifactRef,
  type ChatMessage,
  type ContentBlock,
  type DecisionSummary,
  type InvocationContext,
  type McpGrant,
  type QualityCheckResult,
  type ToolSchema,
} from '@sdlc/shared';
import { buildRepairMessage, extractJson, hashRequest } from '@sdlc/ai-core';
import type { ModelRouter } from '@sdlc/ai-router';
import type { McpManager } from '@sdlc/mcp-manager';
import { ContextEngine } from '@sdlc/context';
import { getLogger, metrics, startTimer } from '@sdlc/observability';
import { BudgetGuard } from './budget-guard.js';
import { PromptRegistry } from './prompt-registry.js';
import { ArtifactStore } from './artifact-store.js';

const log = getLogger({ component: 'agent-runtime' });

export interface AgentRuntimeDeps {
  prisma: PrismaClient;
  router: ModelRouter;
  mcp: McpManager;
  context: ContextEngine;
  prompts: PromptRegistry;
  artifacts: ArtifactStore;
  grants: McpGrant[];
  /** Called after each tool-loop turn so a long run can heartbeat and stream progress. */
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
  workspaceRoot?: string;
}

export interface AgentProgress {
  agentRunId: string;
  projectId: string;
  agentKey: AgentKey;
  step: string;
  iteration: number;
  tokensUsed: number;
  costUsd: number;
  elapsedMs: number;
}

/** How an agent's structured output becomes persisted artifacts. */
export interface ArtifactMapping {
  kind: ArtifactRef['kind'];
  name: string;
  scope?: 'PROJECT' | 'STORY' | 'OPTION' | 'PR';
  scopeRef?: string;
  content: unknown;
}

export interface RegisteredAgent<I = unknown, O = unknown> {
  definition: AgentDefinition<I, O>;
  inputSchema: Schema<I>;
  outputSchema: Schema<O>;
  /** Maps validated output to one or more artifacts. */
  toArtifacts(output: O, invocation: AgentInvocation): ArtifactMapping[];
  /** Optional side effects (writing stories, estimates…) after the artifact is stored. */
  project?(
    output: O,
    ctx: { prisma: PrismaClient; invocation: AgentInvocation; ref: ArtifactRef },
  ): Promise<void>;
  /** Extra prompt variables beyond the standard set. */
  promptVariables?(invocation: AgentInvocation): Record<string, string>;
  /** Context variables (change requests, blind options, retrieval queries). */
  contextVariables?(invocation: AgentInvocation): Record<string, unknown>;
}

export class AgentRegistry {
  private agents = new Map<AgentKey, RegisteredAgent<never, never>>();

  register<I, O>(agent: RegisteredAgent<I, O>): void {
    this.agents.set(agent.definition.key, agent as unknown as RegisteredAgent<never, never>);
  }

  get(key: AgentKey): RegisteredAgent<unknown, unknown> {
    const agent = this.agents.get(key);
    if (!agent) {
      throw new PlatformError({
        code: FailureCode.NOT_FOUND,
        message: `agent "${key}" is not registered`,
        details: { key, registered: [...this.agents.keys()] },
      });
    }
    return agent as unknown as RegisteredAgent<unknown, unknown>;
  }

  keys(): AgentKey[] {
    return [...this.agents.keys()];
  }
}

const DecisionSummarySchema = z.object({
  summary: z.string(),
  evidence: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  risks: z
    .array(z.object({ description: z.string(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) }))
    .default([]),
  tradeoffs: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export class AgentRuntime {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly deps: AgentRuntimeDeps,
  ) {}

  async execute(invocation: AgentInvocation): Promise<AgentRunResult> {
    const timer = startTimer();
    const agent = this.registry.get(invocation.agentKey);
    const definition = agent.definition;

    // ── 1. Create the run record up front, so a crash is still attributable ──
    const run = await this.deps.prisma.agentRun.create({
      data: {
        projectId: invocation.projectId,
        agentKey: definition.key,
        agentVersion: definition.version,
        ...(invocation.phase ? { phase: invocation.phase } : {}),
        ...(invocation.subjectRef ? { subjectRef: invocation.subjectRef } : {}),
        ...(invocation.workflowId ? { workflowId: invocation.workflowId } : {}),
        ...(invocation.workflowRunId ? { workflowRunId: invocation.workflowRunId } : {}),
        ...(invocation.activityId ? { activityId: invocation.activityId } : {}),
        attempt: invocation.attempt,
        status: 'RUNNING',
        inputRefs: invocation.inputRefs as object,
      },
    });

    const guard = new BudgetGuard(definition.budget, invocation.workflowCeilings ?? {});

    try {
      if (!definition.enabled) {
        throw new PlatformError({
          code: FailureCode.VALIDATION_ERROR,
          message: `agent "${definition.key}" is disabled`,
        });
      }

      // ── 2. Validate the invocation input against the agent's own schema ──
      const input = agent.inputSchema.parse(invocation.input);

      // ── 3. Resolve the prompt version and pin it to this run ──
      const prompt = this.deps.prompts.get(definition.key, definition.promptRef.version);
      // Several agents of the same key run in parallel (three architects, two estimators), so this
      // is a genuine race: `upsert` is not atomic against a concurrent insert on the same unique
      // key. Read first, create optimistically, and treat a unique-constraint loss as a win.
      const promptVersion = await this.resolvePromptVersion(definition.key, prompt);
      await this.deps.prisma.agentRun.update({
        where: { id: run.id },
        data: { promptVersionId: promptVersion.id },
      });

      await this.progress(run.id, invocation, definition.key, 'building-context', guard, timer);

      // ── 4. Build the context package ──
      const contextPackage = await this.deps.context.build({
        recipeKey: definition.contextRecipe,
        projectId: invocation.projectId,
        ...(invocation.subjectRef ? { storyId: invocation.subjectRef } : {}),
        inputRefs: invocation.inputRefs,
        variables: agent.contextVariables?.(invocation) ?? {},
      });

      // ── 5. Route to a model ──
      const outputJsonSchema = zodToJsonSchema(agent.outputSchema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as Record<string, unknown>;

      const binding = await this.deps.router.select(definition.modelPolicy, {
        estimatedInputTokens: contextPackage.tokenCount,
        expectedOutputTokens: 16_000,
      });

      // ── 6. Bind tools (deny by default) ──
      const requiredServers = definition.mcpServers.filter((s) => s.required).map((s) => s.serverKey);
      const agentGrants = this.deps.grants.filter((grant) => grant.agentKey === definition.key);
      const boundTools = await this.deps.mcp.bindTools(agentGrants, { requiredServers });

      const toolSchemas: ToolSchema[] = boundTools.map((tool) => ({
        name: tool.qualifiedName,
        description: `[${tool.serverKey}] ${tool.description}`,
        inputSchema: tool.inputSchema,
      }));

      const invocationContext: InvocationContext = {
        projectId: invocation.projectId,
        agentKey: definition.key,
        agentRunId: run.id,
        ...(invocation.workflowId ? { workflowId: invocation.workflowId } : {}),
        grants: agentGrants,
        callCounts: {},
      };

      // ── 7. Render the prompt (deterministic given prompt + context + input) ──
      const system = this.deps.prompts.render(prompt, {
        projectId: invocation.projectId,
        phase: invocation.phase ?? 'default',
        ...(agent.promptVariables?.(invocation) ?? {}),
      });

      const userMessage = [
        ContextEngine.render(contextPackage),
        '<task>',
        JSON.stringify(input, null, 2),
        '</task>',
        '',
        'Respond with a single JSON object matching the required output schema.',
      ].join('\n');

      const messages: ChatMessage[] = [
        { role: 'user', content: userMessage, cacheBreakpoint: true },
      ];

      const requestSha = hashRequest({
        promptSha: prompt.sha256,
        contextSha: contextPackage.sha256,
        input,
        modelId: binding.modelId,
      });
      await this.deps.prisma.agentRun.update({
        where: { id: run.id },
        data: { contextSha256: contextPackage.sha256, requestSha256: requestSha },
      });

      // ── 8. The tool loop ──
      const { rawOutput, callIndex } = await this.runToolLoop({
        run,
        invocation,
        definition,
        guard,
        binding,
        system,
        messages,
        toolSchemas,
        outputJsonSchema,
        invocationContext,
        boundTools,
        timer,
      });

      // ── 9. Validate, with a single repair turn ──
      await this.progress(run.id, invocation, definition.key, 'validating', guard, timer);
      const output = await this.parseAndRepair({
        agent,
        rawOutput,
        guard,
        binding,
        system,
        messages,
        outputJsonSchema,
        run,
        invocation,
        callIndex,
      });

      // ── 10. Quality checks ──
      const warnings = await this.runQualityChecks(agent, output, invocation);
      const hardFailures = warnings.filter((w) => !w.passed && w.severity === 'HARD');
      if (hardFailures.length) {
        throw new InvalidOutputError({
          agentKey: definition.key,
          failures: hardFailures.map((f) => `${f.code}: ${f.message}`),
        });
      }

      // ── 11. Persist artifacts + lineage ──
      await this.progress(run.id, invocation, definition.key, 'persisting', guard, timer);
      const mappings = agent.toArtifacts(output, invocation);
      let primaryRef: ArtifactRef | undefined;

      for (const mapping of mappings) {
        const ref = await this.deps.artifacts.persist({
          projectId: invocation.projectId,
          kind: mapping.kind,
          ...(mapping.scope ? { scope: mapping.scope } : {}),
          ...(mapping.scopeRef ? { scopeRef: mapping.scopeRef } : {}),
          name: mapping.name,
          content: mapping.content,
          producedByRunId: run.id,
          agentKey: definition.key,
          allowedKinds: definition.writes,
          inputRefs: invocation.inputRefs,
          qualityWarnings: warnings.filter((w) => !w.passed),
        });
        primaryRef ??= ref;
      }

      await agent.project?.(output, {
        prisma: this.deps.prisma,
        invocation,
        ref: primaryRef!,
      });

      // ── 12. Close the run ──
      const decisionSummary = extractDecisionSummary(output);
      const spend = guard.snapshot();
      const durationMs = timer.stop();

      await this.deps.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          ...(primaryRef ? { outputVersionId: primaryRef.versionId } : {}),
          ...(decisionSummary ? { decisionSummary: decisionSummary as object } : {}),
          totalCostUsd: spend.costUsd,
          totalTokens: spend.tokens,
          finishedAt: new Date(),
          durationMs,
        },
      });

      metrics.increment('agent.runs', 1, { agent: definition.key, status: 'SUCCEEDED' });
      metrics.observe('agent.duration_ms', durationMs, { agent: definition.key });

      return {
        agentRunId: run.id,
        status: 'SUCCEEDED',
        ...(primaryRef ? { outputRef: primaryRef } : {}),
        ...(decisionSummary ? { decisionSummary } : {}),
        qualityWarnings: warnings.filter((w) => !w.passed),
        costUsd: spend.costUsd,
        costUnknown: false,
        quotaUnits: spend.quotaUnits,
        tokens: spend.tokens,
        durationMs,
        modelId: binding.modelId,
        providerKey: binding.providerKey,
      };
    } catch (error) {
      const spend = guard.snapshot();
      const durationMs = timer.stop();
      const code = error instanceof PlatformError ? error.code : FailureCode.AGENT_FAILED;

      await this.deps.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: mapRunStatus(code),
          error: {
            code,
            message: (error as Error).message,
            details: (error instanceof PlatformError ? error.details : {}) as object,
          } as object,
          totalCostUsd: spend.costUsd,
          totalTokens: spend.tokens,
          finishedAt: new Date(),
          durationMs,
        },
      });

      metrics.increment('agent.runs', 1, { agent: invocation.agentKey, status: 'FAILED' });
      log.error(
        { agentKey: invocation.agentKey, runId: run.id, code, error: (error as Error).message },
        'agent run failed',
      );
      throw error;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Idempotent under concurrency, unlike `upsert`. */
  private async resolvePromptVersion(
    agentKey: AgentKey,
    prompt: { version: string; path: string; sha256: string; body: string },
  ): Promise<{ id: string }> {
    const existing = await this.deps.prisma.promptVersion.findUnique({
      where: { agentKey_version: { agentKey, version: prompt.version } },
    });
    if (existing) return existing;

    try {
      return await this.deps.prisma.promptVersion.create({
        data: {
          agentKey,
          version: prompt.version,
          path: prompt.path,
          sha256: prompt.sha256,
          body: prompt.body,
        },
      });
    } catch {
      // Another concurrent run inserted it between our read and our write. That is the expected
      // outcome of the race, not an error.
      const raced = await this.deps.prisma.promptVersion.findUnique({
        where: { agentKey_version: { agentKey, version: prompt.version } },
      });
      if (raced) return raced;
      throw new PlatformError({
        code: FailureCode.INTERNAL,
        message: `could not resolve prompt version ${agentKey}/${prompt.version}`,
      });
    }
  }

  private async runToolLoop(args: {
    run: { id: string };
    invocation: AgentInvocation;
    definition: AgentDefinition;
    guard: BudgetGuard;
    binding: Awaited<ReturnType<ModelRouter['select']>>;
    system: string;
    messages: ChatMessage[];
    toolSchemas: ToolSchema[];
    outputJsonSchema: Record<string, unknown>;
    invocationContext: InvocationContext;
    boundTools: Awaited<ReturnType<McpManager['bindTools']>>;
    timer: { stop(): number };
  }): Promise<{ rawOutput: { text: string; structured?: unknown }; callIndex: number }> {
    const { guard, binding, system, messages, toolSchemas, invocationContext } = args;
    let callIndex = 0;

    for (;;) {
      guard.assertCanIterate();
      guard.recordIteration();

      const request = {
        modelId: binding.modelId,
        system,
        messages,
        maxOutputTokens: 16_000,
        metadata: {
          projectId: args.invocation.projectId,
          agentKey: args.definition.key,
          runId: args.run.id,
        },
        // Structured output is only requested once no tools remain in play; a model asked for both
        // at once will usually satisfy the schema and skip the tools.
        ...(toolSchemas.length ? { tools: toolSchemas, toolChoice: 'auto' as const } : {}),
        ...(toolSchemas.length ? {} : { outputSchema: args.outputJsonSchema }),
        ...(binding.effort ? { effort: binding.effort } : {}),
      };

      const estimate = this.deps.router.priceRequest(binding, request);
      guard.assertCanAfford(estimate.costUsd);

      const { response, fellBackFrom } = await this.deps.router.execute(binding, request);

      await this.deps.prisma.llmCall.create({
        data: {
          agentRunId: args.run.id,
          ordinal: callIndex++,
          providerKey: response.providerKey,
          modelId: response.modelId,
          billingMode: response.billingMode,
          promptTokens: response.usage.inputTokens,
          completionTokens: response.usage.outputTokens,
          cachedReadTokens: response.usage.cachedReadTokens,
          cachedWriteTokens: response.usage.cachedWriteTokens,
          costUsd: response.costUsd,
          costUnknown: response.costUnknown,
          quotaUnits: response.quotaUnits,
          latencyMs: response.latencyMs,
          finishReason: response.finishReason,
          ...(fellBackFrom ? { fallbackFrom: fellBackFrom } : {}),
        },
      });

      guard.recordUsage({
        costUsd: response.costUsd,
        tokens: response.usage.inputTokens + response.usage.outputTokens,
        quotaUnits: response.quotaUnits,
      });

      await this.progress(
        args.run.id,
        args.invocation,
        args.definition.key,
        'model-turn',
        guard,
        args.timer,
      );

      if (response.finishReason === 'refusal') {
        throw new PlatformError({
          code: FailureCode.AGENT_FAILED,
          message: 'the model declined to answer this request',
          details: { agentKey: args.definition.key, modelId: response.modelId },
        });
      }

      // A truncated response is not a malformed one: retrying the repair path would waste a turn
      // producing the same truncation, so this fails clearly instead.
      if (response.finishReason === 'length') {
        throw new PlatformError({
          code: FailureCode.INVALID_OUTPUT,
          message:
            'the model hit its output limit before finishing. Raise maxOutputTokens or narrow ' +
            'the task; the partial document is deliberately not parsed.',
          details: { agentKey: args.definition.key, modelId: response.modelId },
        });
      }

      if (response.toolCalls.length === 0) {
        return { rawOutput: { text: response.text, structured: response.structured }, callIndex };
      }

      messages.push({ role: 'assistant', content: response.content });

      const results: ContentBlock[] = [];
      for (const call of response.toolCalls) {
        guard.assertCanCallTool();
        guard.recordToolCall();

        const parsed = parseQualifiedToolName(call.name);
        if (!parsed) {
          results.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: `unknown tool: ${call.name}`,
            isError: true,
          });
          continue;
        }

        try {
          const result = await this.deps.mcp.callTool(
            invocationContext,
            parsed.server,
            parsed.tool,
            (call.input ?? {}) as Record<string, unknown>,
            { ...(this.deps.workspaceRoot ? { workspaceRoot: this.deps.workspaceRoot } : {}) },
          );
          results.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: result.content,
            isError: result.isError,
          });
        } catch (error) {
          // A permission denial is fed back to the model as a tool error rather than crashing the
          // run: the agent should adapt, and the denial is already audited.
          if (error instanceof PlatformError && error.code === FailureCode.PERMISSION_DENIED) {
            results.push({
              type: 'tool_result',
              toolUseId: call.id,
              content: `permission denied: ${error.message}`,
              isError: true,
            });
            continue;
          }
          throw error;
        }
      }

      messages.push({ role: 'user', content: results });
    }
  }

  private async parseAndRepair(args: {
    agent: RegisteredAgent<unknown, unknown>;
    rawOutput: { text: string; structured?: unknown };
    guard: BudgetGuard;
    binding: Awaited<ReturnType<ModelRouter['select']>>;
    system: string;
    messages: ChatMessage[];
    outputJsonSchema: Record<string, unknown>;
    run: { id: string };
    invocation: AgentInvocation;
    callIndex: number;
  }): Promise<unknown> {
    const candidate = args.rawOutput.structured ?? extractJson(args.rawOutput.text).value;
    const first = args.agent.outputSchema.safeParse(candidate);
    if (first.success) return first.data;

    const errors = first.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    log.warn({ agentKey: args.agent.definition.key, errors }, 'output failed validation; repairing once');

    // Exactly one repair turn. A model that fails twice will not succeed on the third try, and the
    // remaining budget is better spent surfacing the problem to a human.
    args.guard.assertCanIterate();
    args.guard.recordIteration();

    const repairMessages: ChatMessage[] = [
      ...args.messages,
      { role: 'assistant', content: args.rawOutput.text },
      { role: 'user', content: buildRepairMessage(errors, args.agent.definition.key) },
    ];

    const { response } = await this.deps.router.execute(args.binding, {
      modelId: args.binding.modelId,
      system: args.system,
      messages: repairMessages,
      maxOutputTokens: 16_000,
      outputSchema: args.outputJsonSchema,
      metadata: {
        projectId: args.invocation.projectId,
        agentKey: args.agent.definition.key,
        runId: args.run.id,
      },
    });

    await this.deps.prisma.llmCall.create({
      data: {
        agentRunId: args.run.id,
        ordinal: args.callIndex,
        providerKey: response.providerKey,
        modelId: response.modelId,
        billingMode: response.billingMode,
        promptTokens: response.usage.inputTokens,
        completionTokens: response.usage.outputTokens,
        cachedReadTokens: response.usage.cachedReadTokens,
        cachedWriteTokens: response.usage.cachedWriteTokens,
        costUsd: response.costUsd,
        costUnknown: response.costUnknown,
        quotaUnits: response.quotaUnits,
        latencyMs: response.latencyMs,
        finishReason: `${response.finishReason}:repair`,
      },
    });

    args.guard.recordUsage({
      costUsd: response.costUsd,
      tokens: response.usage.inputTokens + response.usage.outputTokens,
      quotaUnits: response.quotaUnits,
    });

    const repaired = response.structured ?? extractJson(response.text).value;
    const second = args.agent.outputSchema.safeParse(repaired);
    if (second.success) return second.data;

    throw new InvalidOutputError({
      agentKey: args.agent.definition.key,
      firstAttemptErrors: errors,
      repairErrors: second.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  private async runQualityChecks(
    agent: RegisteredAgent<unknown, unknown>,
    output: unknown,
    invocation: AgentInvocation,
  ): Promise<QualityCheckResult[]> {
    const results: QualityCheckResult[] = [];
    for (const check of agent.definition.qualityChecks) {
      try {
        results.push(
          await check.run(output, {
            projectId: invocation.projectId,
            agentKey: agent.definition.key,
            inputRefs: invocation.inputRefs,
          }),
        );
      } catch (error) {
        results.push({
          passed: false,
          severity: check.severity,
          code: check.code,
          message: `quality check threw: ${(error as Error).message}`,
        });
      }
    }
    return results;
  }

  private async progress(
    agentRunId: string,
    invocation: AgentInvocation,
    agentKey: AgentKey,
    step: string,
    guard: BudgetGuard,
    timer: { stop(): number },
  ): Promise<void> {
    const spend = guard.snapshot();
    await this.deps.onProgress?.({
      agentRunId,
      projectId: invocation.projectId,
      agentKey,
      step,
      iteration: spend.iterations,
      tokensUsed: spend.tokens,
      costUsd: spend.costUsd,
      elapsedMs: spend.elapsedSeconds * 1000,
    });
    void timer;
  }
}

function extractDecisionSummary(output: unknown): DecisionSummary | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const candidate = (output as Record<string, unknown>).decisionSummary;
  const parsed = DecisionSummarySchema.safeParse(candidate);
  if (!parsed.success) return undefined;

  return {
    summary: parsed.data.summary,
    // Evidence arrives as artifact ids; the API resolves them to full refs for the approval UI.
    evidence: [],
    assumptions: parsed.data.assumptions,
    risks: parsed.data.risks,
    tradeoffs: parsed.data.tradeoffs,
    openQuestions: parsed.data.openQuestions,
    confidence: parsed.data.confidence,
  };
}

function mapRunStatus(code: FailureCode): 'FAILED' | 'BUDGET_EXCEEDED' | 'INVALID_OUTPUT' | 'PERMISSION_DENIED' {
  switch (code) {
    case FailureCode.BUDGET_EXCEEDED:
      return 'BUDGET_EXCEEDED';
    case FailureCode.INVALID_OUTPUT:
      return 'INVALID_OUTPUT';
    case FailureCode.PERMISSION_DENIED:
      return 'PERMISSION_DENIED';
    default:
      return 'FAILED';
  }
}

export { DecisionSummarySchema };
