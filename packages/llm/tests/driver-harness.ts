// Shared fake-transport harness for the three driver test files and the
// cross-driver conformance suite. No real network call happens anywhere in
// this package's tests: every test patches globalThis.fetch for its duration
// (same idiom as packages/platform-client's own tests), so each driver is
// exercised through its real SDK against a fake wire.
//
// Everything here is provider-neutral by construction. The SSE builders take
// *pre-encoded* chunk strings so each driver test file keeps its own one-line
// wire encoder (Anthropic's `event: <name>\ndata: ...`, OpenAI's and Gemini's
// bare `data: ...`) and its own terminator convention (OpenAI sends a
// `data: [DONE]` sentinel; the other two just end the body).
import assert from "node:assert/strict";

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The subset of node:test's TestContext these helpers drive. */
export type TimerContext = { mock: { timers: { tick(ms: number): void } } };

/** Advances the fake clock by `totalMs` in small `stepMs` increments,
 * flushing real microtasks/setImmediate between each step so a chain of
 * awaits many levels deep (auth, request building, fetch, JSON parsing,
 * classification, backoff scheduling) gets as many turns as it needs. */
export async function tickInSteps(t: TimerContext, totalMs: number, stepMs = 250): Promise<void> {
  for (let advanced = 0; advanced < totalMs; advanced += stepMs) {
    t.mock.timers.tick(Math.min(stepMs, totalMs - advanced));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export async function collectStream<T>(gen: AsyncGenerator<T, void, unknown>): Promise<T[]> {
  const collected: T[] = [];
  for await (const delta of gen) {
    collected.push(delta);
  }
  return collected;
}

/** Errors an SSE body the way real fetch/undici does when the caller's
 * AbortSignal fires -- what every driver's stall watchdog and hard timeout
 * actually observe. */
function abortOn(controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal | null | undefined): void {
  if (!signal) {
    return; // held open forever; only used in tests that abort explicitly
  }
  const errorStream = () => {
    try {
      controller.error(new DOMException("The operation was aborted.", "AbortError"));
    } catch {
      // already closed/errored -- fine, nothing left to signal.
    }
  };
  if (signal.aborted) {
    errorStream();
  } else {
    signal.addEventListener("abort", errorStream);
  }
}

function sseBody(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export interface SseOptions {
  signal?: AbortSignal | null;
  /** Leave the stream open after the last chunk (a stalled connection). */
  holdOpen?: boolean;
  /** Sentinel emitted immediately before close, e.g. OpenAI's `data: [DONE]`. */
  terminator?: string;
}

/** Builds a fake SSE Response from already-encoded chunk strings. */
export function sseResponse(chunks: string[], opts: SseOptions = {}): Response {
  const encoder = new TextEncoder();
  return sseBody(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        if (!opts.holdOpen) {
          if (opts.terminator) {
            controller.enqueue(encoder.encode(opts.terminator));
          }
          controller.close();
          return;
        }
        abortOn(controller, opts.signal);
      },
    }),
  );
}

/** Like sseResponse, but chunks are enqueued at scheduled fake-clock offsets
 * (via global setTimeout, driven by t.mock.timers) instead of all at once at
 * stream start -- how the stall-watchdog tests pace real activity. */
export function pacedSseResponse(
  scheduled: Array<{ atMs: number; chunk: string }>,
  opts: SseOptions & { closeAfterMs?: number } = {},
): Response {
  const encoder = new TextEncoder();
  const timers: ReturnType<typeof setTimeout>[] = [];
  return sseBody(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // stream already closed/errored -- nothing left to enqueue into.
          }
        };
        for (const item of scheduled) {
          timers.push(setTimeout(() => enqueue(item.chunk), item.atMs));
        }
        if (opts.closeAfterMs !== undefined) {
          timers.push(
            setTimeout(() => {
              if (opts.terminator) {
                enqueue(opts.terminator);
              }
              try {
                controller.close();
              } catch {
                // already closed/errored
              }
            }, opts.closeAfterMs),
          );
        }
        // No close scheduled and no signal: held open until the test ends.
        abortOn(controller, opts.signal);
      },
      cancel() {
        for (const timer of timers) {
          clearTimeout(timer);
        }
      },
    }),
  );
}

export interface Settled {
  ok: boolean;
  error?: { class: string; retryable: boolean };
}

/** Drives a promise to settlement under fake timers, advancing the clock in
 * 1s steps so retry backoff elapses. Worst-case cumulative backoff across
 * MAX_RETRIES is well under 20s; exact timing is covered by retry.test.ts,
 * so this advances generously rather than precisely. */
export async function settleUnderFakeTimers(t: TimerContext, promise: Promise<unknown>, label = "promise"): Promise<Settled> {
  let settled: Settled | undefined;
  promise.then(
    () => (settled = { ok: true }),
    (error) => (settled = { ok: false, error }),
  );
  for (let i = 0; i < 20 && !settled; i++) {
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await promise.catch(() => undefined);
  assert.ok(settled, `${label} never settled`);
  return settled;
}
