import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmError } from "../src/errors.ts";
import { MAX_RETRIES, RETRY_BASE_MS, RETRY_CAP_MS, computeBackoffMs, createStallWatchdog, withRetry } from "../src/retry.ts";

/** Yields to the real event loop so pending promise chains (rejections,
 * newly-scheduled fake timers) settle between ticks of the fake clock. Same
 * technique platform-client's own MockTimers test uses. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function advance(t: { mock: { timers: { tick(ms: number): void } } }, totalMs: number, stepMs = 500): Promise<void> {
  for (let advanced = 0; advanced < totalMs; advanced += stepMs) {
    t.mock.timers.tick(Math.min(stepMs, totalMs - advanced));
    await flush();
  }
}

// ---------------------------------------------------------------------------
// computeBackoffMs: exact numbers (base 2s, cap 30s, full jitter)
// ---------------------------------------------------------------------------

test("computeBackoffMs: retryIndex 0 ranges over [0, base] (2000ms)", () => {
  assert.equal(computeBackoffMs(0, () => 0), 0);
  assert.equal(computeBackoffMs(0, () => 1), RETRY_BASE_MS);
  assert.equal(computeBackoffMs(0, () => 0.5), RETRY_BASE_MS * 0.5);
});

test("computeBackoffMs: retryIndex 1 doubles the exponential term (base * 2^1)", () => {
  assert.equal(computeBackoffMs(1, () => 1), RETRY_BASE_MS * 2);
  assert.equal(computeBackoffMs(1, () => 0), 0);
});

test("computeBackoffMs: caps at 30s even for a retryIndex whose exponential term would exceed it", () => {
  // base * 2^4 = 32000ms > cap; base * 2^10 is enormously over cap.
  assert.equal(computeBackoffMs(4, () => 1), RETRY_CAP_MS);
  assert.equal(computeBackoffMs(10, () => 1), RETRY_CAP_MS);
  assert.equal(computeBackoffMs(10, () => 0), 0); // full jitter still ranges down to 0 at the cap
});

// ---------------------------------------------------------------------------
// withRetry: retry only the three retryable classes, exact max-retries count
// ---------------------------------------------------------------------------

test("withRetry: a successful first attempt never retries", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry: retries a retryable class up to MAX_RETRIES times, then throws the last error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const promise = withRetry(async () => {
    calls += 1;
    throw createLlmError("transport", `attempt ${calls}`);
  });
  let settled: { ok: boolean; error?: unknown } | undefined;
  promise.then(
    () => (settled = { ok: true }),
    (error) => (settled = { ok: false, error }),
  );
  // Worst case two backoffs sum to at most base*2^0 + base*2^1 = 6000ms of
  // jitter; advance well past that so both waits have definitely elapsed
  // regardless of the actual (random) jittered value.
  await advance(t, 20_000);
  assert.ok(settled);
  assert.equal(settled?.ok, false);
  assert.equal(calls, MAX_RETRIES + 1); // 1 initial attempt + 2 retries = 3
  const error = settled?.error as { message: string };
  assert.equal(error.message, "attempt 3"); // the *last* attempt's error surfaces
});

test("withRetry: succeeds after exactly one retry when the second attempt succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const promise = withRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw createLlmError("rate_limit", "first attempt rate limited");
    }
    return "recovered";
  });
  let result: string | undefined;
  promise.then((value) => (result = value));
  await advance(t, 5_000);
  assert.equal(result, "recovered");
  assert.equal(calls, 2);
});

test("withRetry: never retries invalid_request", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(async () => {
        calls += 1;
        throw createLlmError("invalid_request", "bad request");
      }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(calls, 1);
});

test("withRetry: never retries content_policy", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(async () => {
        calls += 1;
        throw createLlmError("content_policy", "refused");
      }),
    (error: { class: string }) => error.class === "content_policy",
  );
  assert.equal(calls, 1);
});

test("withRetry: never retries auth or provider_bug (implied by the binding rule, not just the two named classes)", async () => {
  for (const errClass of ["auth", "provider_bug"] as const) {
    let calls = 0;
    await assert.rejects(() =>
      withRetry(async () => {
        calls += 1;
        throw createLlmError(errClass, `${errClass} failure`);
      }),
    );
    assert.equal(calls, 1, `expected exactly one attempt for class ${errClass}`);
  }
});

test("withRetry: honors retryAfterMs verbatim instead of the computed backoff, even above the 30s cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const retryAfterMs = 45_000; // deliberately above RETRY_CAP_MS
  const promise = withRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw createLlmError("rate_limit", "slow down", { retryAfterMs });
    }
    return "ok";
  });
  let result: string | undefined;
  promise.then((value) => (result = value));

  // Comfortably past anything a computed backoff could ever produce for the
  // first retry (at most RETRY_BASE_MS = 2000ms), but comfortably short of
  // the 45s retry-after -- proves it is not using the computed backoff.
  await advance(t, 20_000);
  assert.equal(calls, 1, "must not retry within the computed-backoff window -- it must be honoring retryAfterMs");
  assert.equal(result, undefined);

  // Cross the 45s mark with margin (advance()'s own stepped ticking shifts
  // the timer's scheduled fire point slightly later than "t=0", since the
  // timer isn't actually armed until the first attempt's rejection has been
  // through a microtask turn -- 30s of extra margin comfortably absorbs that).
  await advance(t, 30_000);
  assert.equal(calls, 2, "must retry once the verbatim retry-after elapses");
  assert.equal(result, "ok");
});

// ---------------------------------------------------------------------------
// Finding #85: retryability is derived fresh from `class` at withRetry's own
// decision point (RETRYABLE_CLASSES.has(err.class)), never by trusting a
// possibly-forged/duck-typed error's own stored `.retryable` field.
// ---------------------------------------------------------------------------

test("withRetry: a duck-typed error with class \"transport\" (retryable) but a forged retryable:false is still retried -- judged by class, not the claimed flag", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const forged = Object.assign(new Error("transport-classed but claims non-retryable"), { class: "transport", retryable: false });
  const promise = withRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw forged;
    }
    return "recovered";
  });
  let result: string | undefined;
  promise.then((value) => (result = value));
  await advance(t, 5_000);
  assert.equal(calls, 2, "class transport must be retried regardless of the forged retryable:false flag");
  assert.equal(result, "recovered");
});

test("withRetry: a duck-typed error with class \"invalid_request\" (non-retryable) but a forged retryable:true is never retried -- judged by class, not the claimed flag", async () => {
  let calls = 0;
  const forged = Object.assign(new Error("invalid_request-classed but claims retryable"), { class: "invalid_request", retryable: true });
  await assert.rejects(() =>
    withRetry(async () => {
      calls += 1;
      throw forged;
    }),
  );
  assert.equal(calls, 1, "class invalid_request must never be retried regardless of the forged retryable:true flag");
});

// ---------------------------------------------------------------------------
// Finding #87: caller cancellation (opts.signal) stops withRetry promptly --
// both mid-backoff-sleep (already partly supported before this fix, via
// sleep's own signal handling) and at the retry-decision point itself
// (newly added: opts.signal?.aborted now also gates whether a retryable
// error is retried at all).
// ---------------------------------------------------------------------------

test("withRetry: an already-aborted signal stops retrying immediately after the first failure, without sleeping out the backoff", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const start = Date.now();
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls += 1;
        throw createLlmError("transport", "would normally retry");
      },
      { signal: controller.signal },
    ),
  );
  const elapsedMs = Date.now() - start;
  assert.equal(calls, 1, "must not retry once the signal is already aborted, even though the error class is retryable");
  assert.ok(elapsedMs < 500, `must not wait out any backoff once already aborted (took ${elapsedMs}ms)`);
});

test("withRetry: a signal that fires DURING the backoff sleep cuts the wait short instead of sleeping out the full backoff", async () => {
  const controller = new AbortController();
  let calls = 0;
  setTimeout(() => controller.abort(), 30);
  const start = Date.now();
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls += 1;
        // A deliberately long explicit wait (well above anything a computed
        // backoff would produce) so a real, uninterrupted sleep would take
        // seconds -- proving the abort actually cuts it short, not that the
        // wait just happened to be short already.
        throw createLlmError("transport", "still down", { retryAfterMs: 5000 });
      },
      { signal: controller.signal },
    ),
  );
  const elapsedMs = Date.now() - start;
  assert.equal(calls, 1, "the first attempt's own failure already carries a 5s retryAfterMs -- the abort must land during that sleep, before a second attempt");
  assert.ok(elapsedMs < 1000, `expected the signal to cut the 5s backoff short, took ${elapsedMs}ms`);
});

// (No-signal regression coverage: every pre-existing test in this file above
// calls withRetry with no `opts.signal` at all and is unchanged by this fix
// -- e.g. "retries a retryable class up to MAX_RETRIES times" and "succeeds
// after exactly one retry" both still pass unmodified.)

// ---------------------------------------------------------------------------
// createStallWatchdog: fires only after `ms` with no reset()
// ---------------------------------------------------------------------------

test("createStallWatchdog: fires once after ms of silence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const watchdog = createStallWatchdog(1000, () => {
    fired += 1;
  });
  t.mock.timers.tick(999);
  await flush();
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(fired, 1);
  assert.equal(watchdog.fired(), true);
});

test("createStallWatchdog: reset() postpones the fire", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const watchdog = createStallWatchdog(1000, () => {
    fired += 1;
  });
  t.mock.timers.tick(700);
  await flush();
  watchdog.reset();
  t.mock.timers.tick(700); // 1400ms of wall time, but only 700ms since reset()
  await flush();
  assert.equal(fired, 0, "reset() should have restarted the 1000ms window");
  t.mock.timers.tick(300); // now 1000ms since reset()
  await flush();
  assert.equal(fired, 1);
});

test("createStallWatchdog: clear() prevents it from ever firing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const watchdog = createStallWatchdog(1000, () => {
    fired += 1;
  });
  watchdog.clear();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(fired, 0);
  assert.equal(watchdog.fired(), false);
});
