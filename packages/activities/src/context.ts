/**
 * Activity dependencies.
 *
 * Everything with a side effect is constructed once at worker boot and handed to the activity
 * factory. Workflows never see any of this — they hold IDs and small state only.
 */

import type { PrismaClient } from '@sdlc/database';
import type { AgentRegistry, AgentRuntime, ArtifactStore, PromptRegistry } from '@sdlc/agent-runtime';
import type { ModelRouter } from '@sdlc/ai-router';
import type { McpManager } from '@sdlc/mcp-manager';
import type { ContextEngine, EmbeddingProvider } from '@sdlc/context';
import type { McpGrant } from '@sdlc/shared';

export interface ActivityDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  registry: AgentRegistry;
  router: ModelRouter;
  mcp: McpManager;
  context: ContextEngine;
  embeddings: EmbeddingProvider;
  prompts: PromptRegistry;
  artifacts: ArtifactStore;
  grants: McpGrant[];
  workspaceRoot: string;
  /** Publishes to the event bus after the transaction commits. */
  publish(topic: string, payload: unknown): Promise<void>;
  limits: {
    maxPrFixIterations: number;
    maxQaFixIterations: number;
    maxBuildFixIterations: number;
    maxBacklogRevisions: number;
    maxArchitectureRounds: number;
    maxParallelStories: number;
    maxWorkflowCostUsd: number;
    estimationVarianceThreshold: number;
    approvalDefaultTimeoutHours: number;
  };
  aiMergePermission: boolean;
}
