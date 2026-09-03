/**
 * Echo agent — the Phase 1 exit criterion made executable.
 *
 * It has no interesting behaviour, which is the point: a run through this agent exercises the
 * runtime loop, model routing, artifact persistence, lineage, audit, the approval gate and workflow
 * resumption without any real intelligence being involved. If the echo path works end to end, every
 * seam works, and any later failure is an agent problem rather than a platform problem.
 */

import { z } from 'zod';
import { ArtifactKind, Capability, ModelTier, type ModelRequest } from '@sdlc/shared';
import type { RegisteredAgent } from '@sdlc/agent-runtime';
import { DecisionSummary, defineAgent, demoSummary, readTask } from './common.js';

export const EchoInput = z.object({ message: z.string().min(1) });

export const EchoOutput = z.object({
  echoed: z.string(),
  receivedAt: z.string(),
  decisionSummary: DecisionSummary,
});
export type EchoOutput = z.infer<typeof EchoOutput>;

export const echoAgent: RegisteredAgent<z.infer<typeof EchoInput>, EchoOutput> = {
  definition: defineAgent({
    key: 'echo',
    name: 'Echo',
    role: 'Trivial agent used to verify the platform end to end without engaging real reasoning.',
    // A SMALL floor deliberately routes this to the cheapest eligible model.
    modelPolicy: {
      capability: Capability.CLASSIFICATION,
      minimumTier: ModelTier.SMALL,
      requireStructuredOutput: true,
    },
    contextRecipe: 'echo',
    mcpServers: [],
    permissions: ['read_project'],
    writes: [ArtifactKind.REQUIREMENTS],
    inputSchema: EchoInput,
    outputSchema: EchoOutput,
    timeoutSeconds: 60,
    budget: { maxCostUsd: 0.1, maxIterations: 2, maxToolCalls: 2, maxWallClockSeconds: 60 },
  }),
  inputSchema: EchoInput,
  outputSchema: EchoOutput,
  toArtifacts: (output) => [
    { kind: ArtifactKind.REQUIREMENTS, name: 'echo', scopeRef: 'echo', content: output },
  ],
};

export function echoDemoHandler(req: ModelRequest): EchoOutput {
  const { message = 'hello' } = readTask<{ message?: string }>(req);
  return {
    echoed: message,
    // The mock provider is deterministic; a fixed timestamp keeps golden fixtures byte-stable.
    receivedAt: '1970-01-01T00:00:00.000Z',
    decisionSummary: demoSummary(`Echoed the message: ${message}`, 1),
  };
}
