/**
 * Failure taxonomy — docs/03-workflows.md §6.
 *
 * Every failure in the platform maps to exactly one code, and the code decides retry behaviour.
 * Temporal activity retry policies are configured from `NON_RETRYABLE_CODES`, so classifying an
 * error correctly is the whole mechanism: a mis-classified error either burns budget retrying
 * something that will never succeed, or gives up on something transient.
 */

export const FailureCode = {
  AGENT_FAILED: 'AGENT_FAILED',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  INVALID_CONTEXT: 'INVALID_CONTEXT',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  NO_ELIGIBLE_MODEL: 'NO_ELIGIBLE_MODEL',
  TOOL_FAILED: 'TOOL_FAILED',
  MCP_UNAVAILABLE: 'MCP_UNAVAILABLE',
  MCP_DISABLED: 'MCP_DISABLED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  BUILD_FAILED: 'BUILD_FAILED',
  TEST_FAILED: 'TEST_FAILED',
  PR_FAILED: 'PR_FAILED',
  APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
  GATE_DISABLED: 'GATE_DISABLED',
  ITERATION_LIMIT_EXCEEDED: 'ITERATION_LIMIT_EXCEEDED',
  DESIGN_CONTEXT_UNAVAILABLE: 'DESIGN_CONTEXT_UNAVAILABLE',
  HUMAN_INTERVENTION_REQUIRED: 'HUMAN_INTERVENTION_REQUIRED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/**
 * Codes that must never be retried. Retrying any of these is either pointless (the input is
 * malformed, the model is not permitted) or actively harmful (spending more budget after the
 * ceiling was hit).
 */
export const NON_RETRYABLE_CODES: readonly FailureCode[] = [
  FailureCode.INVALID_OUTPUT,
  FailureCode.INVALID_CONTEXT,
  FailureCode.NO_ELIGIBLE_MODEL,
  FailureCode.PERMISSION_DENIED,
  FailureCode.BUDGET_EXCEEDED,
  FailureCode.MCP_DISABLED,
  FailureCode.BUILD_FAILED,
  FailureCode.TEST_FAILED,
  FailureCode.APPROVAL_TIMEOUT,
  FailureCode.GATE_DISABLED,
  FailureCode.ITERATION_LIMIT_EXCEEDED,
  FailureCode.HUMAN_INTERVENTION_REQUIRED,
  FailureCode.VALIDATION_ERROR,
  FailureCode.NOT_FOUND,
  FailureCode.CONFLICT,
];

export interface PlatformErrorOptions {
  code: FailureCode;
  message: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class PlatformError extends Error {
  readonly code: FailureCode;
  readonly details: Record<string, unknown>;

  constructor({ code, message, details, cause }: PlatformErrorOptions) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PlatformError';
    this.code = code;
    this.details = details ?? {};
  }

  get retryable(): boolean {
    return !NON_RETRYABLE_CODES.includes(this.code);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Thrown by the model router when no candidate satisfies the capability floor (invariant I8). */
export class NoEligibleModelError extends PlatformError {
  constructor(details: Record<string, unknown>) {
    super({
      code: FailureCode.NO_ELIGIBLE_MODEL,
      message:
        'No model satisfies the required capability floor. Refusing to downgrade a high-risk task.',
      details,
    });
    this.name = 'NoEligibleModelError';
  }
}

/** Thrown by the MCP manager when an agent calls a tool it was not granted (invariant I5). */
export class PermissionDeniedError extends PlatformError {
  constructor(details: Record<string, unknown>) {
    super({
      code: FailureCode.PERMISSION_DENIED,
      message: 'Agent is not permitted to perform this action.',
      details,
    });
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Thrown by the budget guard when a ceiling is breached (invariant I6).
 *
 * The message names the specific limit and the numbers. "Budget exceeded" on its own sends whoever
 * reads the log digging through JSON to find out which of five ceilings actually stopped the run.
 */
export class BudgetExceededError extends PlatformError {
  constructor(details: Record<string, unknown>) {
    const limit = typeof details.limit === 'string' ? details.limit : 'budget';
    const actual = details.actual;
    const allowed = details.allowed;
    const numbers =
      actual !== undefined && allowed !== undefined ? ` (${String(actual)} > ${String(allowed)})` : '';

    super({
      code: FailureCode.BUDGET_EXCEEDED,
      message: `Agent budget exceeded: ${limit}${numbers}. Halting rather than continuing to spend.`,
      details,
    });
    this.name = 'BudgetExceededError';
  }
}

/** Thrown when agent output fails schema validation after the single repair attempt (I2). */
export class InvalidOutputError extends PlatformError {
  constructor(details: Record<string, unknown>) {
    super({
      code: FailureCode.INVALID_OUTPUT,
      message: 'Agent output failed schema validation after repair.',
      details,
    });
    this.name = 'InvalidOutputError';
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof PlatformError) return error.retryable;
  return true; // unknown errors are assumed transient
}

export function failureCodeOf(error: unknown): FailureCode {
  return error instanceof PlatformError ? error.code : FailureCode.INTERNAL;
}
