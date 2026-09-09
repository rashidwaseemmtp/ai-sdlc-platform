/**
 * The agent catalogue — every agent this platform ships, in pipeline order.
 *
 * Hardcoded on purpose. There is no `agents.yaml`, no database table of agent definitions and no
 * admin screen that edits one. An agent's prompt, output schema and quality checks are code, so a
 * change to any of them shows up as a diff, and the provenance recorded against a run ("this came
 * from business-analyst") is a claim about a specific version of a specific file.
 *
 * What *is* configurable is everything around them: which model answers, which MCP servers exist,
 * and which tools each agent is granted. That is the line — the agent's judgement is code, its
 * capabilities are configuration.
 */

import type { Agent } from './types.js';
import { productOwner } from './product-owner.js';
import { businessAnalyst } from './business-analyst.js';
import { architect, architectureCritic } from './architect.js';
import { estimator } from './estimator.js';
import { deliveryPlanner, resourcePlanner } from './planners.js';
import { developer } from './developer.js';
import { codeReviewer, securityReviewer } from './reviewers.js';
import { bugAnalyzer, qa } from './qa.js';

export * from './types.js';

export const AGENTS: Agent<never>[] = [
  productOwner,
  businessAnalyst,
  architect,
  architectureCritic,
  estimator,
  resourcePlanner,
  deliveryPlanner,
  developer,
  codeReviewer,
  securityReviewer,
  qa,
  bugAnalyzer,
] as unknown as Agent<never>[];

export function getAgent(key: string): Agent<never> {
  const agent = AGENTS.find((candidate) => candidate.key === key);
  if (!agent) throw new Error(`no agent registered under "${key}"`);
  return agent;
}
