/**
 * @sdlc/activities — every side effect the platform performs.
 *
 * Workflows import only the *type* of this object (`typeof activities`), never the implementation.
 * That is the determinism firewall from docs/12: a workflow that could import this could also
 * import Prisma, and the replay guarantee would be gone.
 */

import { agentActivities } from './agent-activities.js';
import { approvalActivities } from './approval-activities.js';
import { projectActivities } from './project-activities.js';
import { developmentActivities } from './development-activities.js';
import { qaActivities } from './qa-activities.js';
import { withFailureConversion } from './failure.js';
import type { ActivityDeps } from './context.js';

export type { ActivityDeps } from './context.js';
export type { RunAgentInput } from './agent-activities.js';
export type { FileChange, GateResult } from './development-activities.js';
export type { TestOutcome } from './qa-activities.js';
export { recordEvent } from './approval-activities.js';
export { toApplicationFailure, withFailureConversion } from './failure.js';

export function createActivities(deps: ActivityDeps) {
  // Every activity is wrapped so a PlatformError reaches Temporal as a typed ApplicationFailure.
  // Without that, `nonRetryableErrorTypes` matches nothing and the retry policies do not apply.
  return withFailureConversion({
    ...agentActivities(deps),
    ...approvalActivities(deps),
    ...projectActivities(deps),
    ...developmentActivities(deps),
    ...qaActivities(deps),
  });
}

/** The shape workflows proxy against. */
export type Activities = ReturnType<typeof createActivities>;
