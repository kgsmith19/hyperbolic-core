import type { LlmError, LlmErrorClass } from "./types.ts";

/**
 * The full closed set of LlmErrorClass values, as a runtime-checkable Set
 * alongside the type-only union in types.ts (finding #85). Before this,
 * isLlmError only checked `typeof class === "string"` -- true for *any*
 * string, including one the union doesn't even contain -- so a
 * forged/duck-typed error object with a bogus `class` still passed the type
 * guard. Kept in sync with LlmErrorClass by hand (types.ts has no other
 * runtime-checkable form of that union to derive this from).
 */
export const ALL_ERROR_CLASSES: ReadonlySet<LlmErrorClass> = new Set<LlmErrorClass>([
  "auth",
  "rate_limit",
  "overloaded",
  "transport",
  "invalid_request",
  "content_policy",
  "provider_bug",
]);

/**
 * The only three classes that ever retry (binding, per the issue spec).
 * `retryable` on every LlmError this package creates is *derived* from
 * `class` here, never settable independently -- that is what makes "never
 * retry invalid_request or content_policy" a structural guarantee instead of
 * a convention every call site has to remember. Exported (finding #85) so
 * retry.ts's withRetry -- and complete.ts's own hop-fallover/stream-retry
 * decision points, which face the identical forgery gap -- can derive
 * retryability fresh from `class` at the actual decision point, instead of
 * trusting a possibly-forged/duck-typed error's own stored `.retryable`.
 */
export const RETRYABLE_CLASSES: ReadonlySet<LlmErrorClass> = new Set<LlmErrorClass>(["rate_limit", "overloaded", "transport"]);

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
  if (!(value instanceof Error)) {
    return false;
  }
  const candidate = value as Partial<LlmError>;
  return (
    typeof candidate.class === "string" &&
    ALL_ERROR_CLASSES.has(candidate.class as LlmErrorClass) &&
    typeof candidate.retryable === "boolean"
  );
}
