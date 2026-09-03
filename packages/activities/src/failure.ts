/**
 * Failure conversion — the missing link between our failure taxonomy and Temporal's retry engine.
 *
 * Temporal decides retryability by matching `ApplicationFailure.type` against the activity's
 * `nonRetryableErrorTypes`. A plain `Error` never matches, so without this wrapper the entire
 * non-retryable classification in docs/03 §5 is inert: a `PERMISSION_DENIED` would be retried three
 * times, and an `INVALID_OUTPUT` would burn the budget re-running a deterministic failure.
 *
 * This was not theoretical — it is exactly what happened the first time the pipeline ran.
 */

import { ApplicationFailure } from '@temporalio/activity';
import { FailureCode, PlatformError, isRetryable } from '@sdlc/shared';

export function toApplicationFailure(error: unknown): unknown {
  if (error instanceof ApplicationFailure) return error;

  if (error instanceof PlatformError) {
    return ApplicationFailure.create({
      message: error.message,
      // The type is the failure code, which is what the retry policies name.
      type: error.code,
      nonRetryable: !error.retryable,
      details: [error.details],
    });
  }

  // An unknown error is assumed transient — but it still gets a type so the policy can see it.
  return ApplicationFailure.create({
    message: (error as Error)?.message ?? String(error),
    type: FailureCode.INTERNAL,
    nonRetryable: !isRetryable(error),
  });
}

type AnyFn = (...args: never[]) => Promise<unknown>;

/**
 * Wrap every activity so its failures reach Temporal correctly classified. Applied once in
 * `createActivities`, so no individual activity has to remember.
 */
export function withFailureConversion<T extends Record<string, AnyFn>>(activities: T): T {
  const wrapped: Record<string, AnyFn> = {};

  for (const [name, fn] of Object.entries(activities)) {
    wrapped[name] = (async (...args: never[]) => {
      try {
        return await fn(...args);
      } catch (error) {
        throw toApplicationFailure(error);
      }
    }) as AnyFn;
  }

  return wrapped as T;
}
