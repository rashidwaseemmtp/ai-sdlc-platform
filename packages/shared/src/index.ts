/**
 * @sdlc/shared — types, schemas, events and errors.
 *
 * This entry point is IMPORTED BY WORKFLOW CODE, which runs in Temporal's deterministic sandbox.
 * Nothing here may touch `node:fs`, `node:path`, the network, the clock, or randomness — the
 * bundler will fail the build if it does, which is exactly what we want.
 *
 * Anything that performs I/O lives in `@sdlc/shared/node`.
 */

export * from './errors.js';
export * from './events.js';

export * from './types/model.js';
export * from './types/mcp.js';
export * from './types/agent.js';
export * from './types/artifact.js';
export * from './types/approval.js';
export * from './types/context.js';
export * from './types/workflow.js';

// Schemas are pure Zod declarations — no file access — so they are safe in the sandbox.
export * from './config/schema.js';
