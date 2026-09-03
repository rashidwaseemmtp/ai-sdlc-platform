/**
 * @sdlc/agents — the agent catalogue.
 *
 * One registry builder, so a worker, a test and the demo all get exactly the same agents. Demo
 * handlers are registered into the mock provider here rather than inside the provider package,
 * which keeps the dependency direction right: agents know about the mock, the mock knows nothing
 * about agents.
 */

import { AgentRegistry } from '@sdlc/agent-runtime';
import type { MockModelProvider } from '@sdlc/ai-providers';

import { productOwnerAgent, productOwnerDemoHandler } from './discovery.js';
import { businessAnalystAgent, businessAnalystDemoHandler } from './backlog.js';
import {
  architectAgent,
  architectDemoHandler,
  architectureCriticAgent,
  architectureCriticDemoHandler,
} from './architecture.js';
import {
  deliveryPlannerAgent,
  deliveryPlannerDemoHandler,
  estimatorAgent,
  estimatorDemoHandler,
  resourcePlannerAgent,
  resourcePlannerDemoHandler,
} from './planning.js';
import {
  codeReviewerAgent,
  codeReviewerDemoHandler,
  developerAgent,
  developerDemoHandler,
  securityReviewerAgent,
  securityReviewerDemoHandler,
} from './development.js';
import { bugAnalyzerAgent, bugAnalyzerDemoHandler, qaAgent, qaDemoHandler } from './quality.js';
import { echoAgent, echoDemoHandler } from './echo.js';

export * from './common.js';
export * from './discovery.js';
export * from './backlog.js';
export * from './architecture.js';
export * from './planning.js';
export * from './development.js';
export * from './quality.js';
export * from './echo.js';

/** Every agent the platform ships, in pipeline order. */
export const ALL_AGENTS = [
  echoAgent,
  productOwnerAgent,
  businessAnalystAgent,
  architectAgent,
  architectureCriticAgent,
  estimatorAgent,
  resourcePlannerAgent,
  deliveryPlannerAgent,
  developerAgent,
  codeReviewerAgent,
  securityReviewerAgent,
  qaAgent,
  bugAnalyzerAgent,
] as const;

export function buildAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  for (const agent of ALL_AGENTS) {
    registry.register(agent as Parameters<AgentRegistry['register']>[0]);
  }
  return registry;
}

/**
 * Wire demo responses into the mock provider. Called at worker boot when DEMO_MODE is on, and by
 * the integration tests — so the code path under test is the real runtime, not a stub.
 */
export function registerDemoHandlers(mock: MockModelProvider): void {
  mock.registerHandler('echo', echoDemoHandler);
  mock.registerHandler('product-owner', productOwnerDemoHandler);
  mock.registerHandler('business-analyst', businessAnalystDemoHandler);
  mock.registerHandler('architect', architectDemoHandler);
  mock.registerHandler('architecture-critic', architectureCriticDemoHandler);
  mock.registerHandler('estimator', estimatorDemoHandler);
  mock.registerHandler('resource-planner', resourcePlannerDemoHandler);
  mock.registerHandler('delivery-planner', deliveryPlannerDemoHandler);
  mock.registerHandler('developer', developerDemoHandler);
  mock.registerHandler('code-reviewer', codeReviewerDemoHandler);
  mock.registerHandler('security-reviewer', securityReviewerDemoHandler);
  mock.registerHandler('qa', qaDemoHandler);
  mock.registerHandler('bug-analyzer', bugAnalyzerDemoHandler);
}
