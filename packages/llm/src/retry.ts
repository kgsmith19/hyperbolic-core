/**
 * Retry, backoff, and stream-stall discipline. Binding numbers, per the
 * issue spec: full-jitter exponential backoff, base 2s, cap 30s, max 2
 * retries; a stream that produces no delta for 60s aborts.
 *
 * Every wait in this file goes through the global `setTimeout` /
 * `clearTimeout` (never a bound alias captured at import time, never
 * `node:timers/promises`), so `node --test`'s MockTimers can drive the
 * exact-numbers tests without spending real wall-clock seconds.
 */
import { isLlmError, RETRYABLE_CLASSES } from "./errors.ts";

export const RETRY_BASE_MS = 2000;
export const RETRY_CAP_MS = 30000;
export const MAX_RETRIES = 2;
export const STREAM_STALL_MS = 60000;

/** Full jitter (AWS's formula): sleep = random(0, min(cap, base * 2^retryIndex)). */
export function computeBackoffMs(retryIndex: number, random: () => number = Math.random): number {
  const exp = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** retryIndex);
  return random() * exp;
}

/** Resolves after `ms`, or rejects immediately/on-abort if `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 && !signal) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(onDone, ms);
    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("aborted"));
    }
    function onDone(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Runs `run` with up to MAX_RETRIES retries. Only retries when the thrown
 * value is an LlmError whose `class` is one of RETRYABLE_CLASSES (rate_limit
 * | overloaded | transport). Retryability is derived fresh from `class` at
 * this decision point (finding #85) -- via RETRYABLE_CLASSES.has(err.class),
 * never by trusting the error's own stored `.retryable` field -- so a
 * forged/duck-typed error object with a mismatched `retryable` flag is
 * judged by its class, not its claim. Every error createLlmError actually
 * produces already has `retryable` derived the same way, so this changes
 * nothing for any legitimate error; it only closes the gap for a
 * hypothetical forged one. Honors `retryAfterMs` verbatim when the error
 * carries one; otherwise waits the full-jitter backoff for that retry's
 * index.
 */
export async function withRetry<T>(run: () => Promise<T>, opts: { random?: () => number; signal?: AbortSignal } = {}): Promise<T> {
  const random = opts.random ?? Math.random;
  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await run();
    } catch (err) {
      const retryable = isLlmError(err) && RETRYABLE_CLASSES.has(err.class);
      const isLastAttempt = attemptIndex >= MAX_RETRIES;
      // Finding #87: a caller signal that has already fired stops retrying
      // immediately, regardless of the error's own class -- the same
      // reasoning as `isLastAttempt` above, just triggered by cancellation
      // instead of running out of budget. This is what keeps a driver call
      // that aborted because of `opts.signal` (composed into its own
      // per-attempt AbortController -- see drivers/abort.ts) from being
      // retried just because its resulting error still carries a retryable
      // class like "transport".
      if (!retryable || isLastAttempt || opts.signal?.aborted) {
        throw err;
      }
      const waitMs = isLlmError(err) && err.retryAfterMs !== undefined ? err.retryAfterMs : computeBackoffMs(attemptIndex, random);
      await sleep(waitMs, opts.signal);
    }
  }
}

export interface StallWatchdog {
  /** Re-arms the timer; call on every sign of life from the stream. */
  reset(): void;
  clear(): void;
  fired(): boolean;
}

/** Fires `onStall` once if `reset()` is not called again within `ms`. */
export function createStallWatchdog(ms: number, onStall: () => void): StallWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didFire = false;

  function arm(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      didFire = true;
      onStall();
    }, ms);
  }

  arm();

  return {
    reset: arm,
    clear(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    fired(): boolean {
      return didFire;
    },
  };
}
