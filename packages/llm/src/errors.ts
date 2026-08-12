import type { LlmError, LlmErrorClass } from "./types.ts";

/**
 * The only three classes that ever retry (binding, per the issue spec).
 * `retryable` on every LlmError this package creates is *derived* from
 * `class` here, never settable independently -- that is what makes "never
 * retry invalid_request or content_policy" a structural guarantee instead of
 * a convention every call site has to remember.
 */
const RETRYABLE_CLASSES: ReadonlySet<LlmErrorClass> = new Set(["rate_limit", "overloaded", "transport"]);

export interface CreateLlmErrorOptions {
  /** Honored verbatim by the retry engine instead of the computed backoff. */
  retryAfterMs?: number;
  /** The underlying provider/SDK error, if any, kept as Error.cause. */
  cause?: unknown;
}

export function createLlmError(errClass: LlmErrorClass, message: string, options: CreateLlmErrorOptions = {}): LlmError {
  const error = new Error(message, options.cause !== undefined ? { cause: options.cause } : undefined) as LlmError;
  error.class = errClass;
  error.retryable = RETRYABLE_CLASSES.has(errClass);
  if (options.retryAfterMs !== undefined) {
    error.retryAfterMs = options.retryAfterMs;
  }
  return error;
}

export function isLlmError(value: unknown): value is LlmError {
  return (
    value instanceof Error &&
    typeof (value as Partial<LlmError>).class === "string" &&
    typeof (value as Partial<LlmError>).retryable === "boolean"
  );
}
