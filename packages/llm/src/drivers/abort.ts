/**
 * Per-attempt AbortController construction, shared by all three drivers
 * (finding #87). Every driver already built its own `AbortController` per
 * attempt purely to enforce `request.timeoutMs`; this composes an optional
 * caller-supplied `LlmRequest.signal` into that *same* controller --
 * `addEventListener`, never a second/replacement controller -- so a caller
 * cancellation aborts the in-flight SDK call exactly the way a timeout or
 * stream-stall already does, through the one abort path every driver's SDK
 * call is already wired to observe.
 */
export function createAttemptController(request: { timeoutMs: number; signal?: AbortSignal }): {
  controller: AbortController;
  hardTimer: ReturnType<typeof setTimeout>;
} {
  const controller = new AbortController();
  const callerSignal = request.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      // Already aborted before this attempt even started (e.g. a caller
      // that cancels before the first hop is dispatched at all) -- abort
      // immediately rather than waiting for an "abort" event that an
      // already-fired signal will never emit again.
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), { once: true });
    }
  }
  const hardTimer = setTimeout(() => controller.abort(), request.timeoutMs);
  return { controller, hardTimer };
}
