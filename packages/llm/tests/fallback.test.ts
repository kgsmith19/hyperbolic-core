import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { complete, stream } from "../src/complete.ts";
import { createLlmError } from "../src/errors.ts";
import { MAX_RETRIES } from "../src/retry.ts";
import type { LlmDelta, LlmRequest } from "../src/types.ts";
import { fakeDriver, fixtureResponse } from "./driver-harness.ts";

/** Drives `run()` to completion under fake timers, so a test that forces a
 * real retry/backoff wait (via a genuinely retryable fake-driver error)
 * doesn't burn real wall-clock seconds. Re-throws a rejection so callers can
 * still use `assert.rejects(() => withFakeTimers(t, ...))`. */
async function withFakeTimers<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const promise = run();
  let settled: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  promise.then(
    (value) => (settled = { ok: true, value }),
    (error) => (settled = { ok: false, error }),
  );
  for (let i = 0; i < 40 && !settled; i++) {
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!settled) {
    throw new Error("operation did not settle within the fake-timer budget");
  }
  if (!settled.ok) {
    throw settled.error;
  }
  return settled.value;
}

/** Same idea as withFakeTimers, but for draining an async generator instead
 * of awaiting a single promise -- used by the streaming fallover test below,
 * which also forces a real retry/backoff wait via a genuinely retryable
 * fake-driver error. */
async function drainWithFakeTimers(
  t: TestContext,
  gen: AsyncGenerator<LlmDelta, void, unknown>,
): Promise<LlmDelta[]> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const collected: LlmDelta[] = [];
  const drain = (async () => {
    for await (const delta of gen) {
      collected.push(delta);
    }
  })();
  let done = false;
  drain.then(() => (done = true));
  for (let i = 0; i < 40 && !done; i++) {
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await drain; // surface any rejection; no-op if already settled
  return collected;
}

const BASE_REQUEST: LlmRequest = {
  provider: "anthropic",
  model: "primary-model",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 128,
  metadata: { callerApp: "test-suite", purpose: "unit-test" },
  timeoutMs: 5000,
  fallback: [{ provider: "openai", model: "fallback-model" }],
};

const CREDENTIALS = { anthropic: { apiKey: "primary-key" }, openai: { apiKey: "fallback-key" } };

// ---------------------------------------------------------------------------
// Explicit-only fallback: rejected outright when tools are attached
// ---------------------------------------------------------------------------

test("complete(): rejects fallback+tools as invalid_request before attempting the primary call", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const fallback = fakeDriver("openai", { complete: async () => fixtureResponse("openai", "fallback-model") });
  const request: LlmRequest = { ...BASE_REQUEST, tools: [{ name: "noop", inputSchema: { type: "object" } }] };

  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: primary, openai: fallback } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0, "primary must never be attempted");
  assert.equal(fallback.calls, 0, "fallback must never be attempted");
});

// ---------------------------------------------------------------------------
// Finding #82: fallback+tools is only rejected ACROSS providers -- a
// same-provider fallback (a different model on the same provider) is legal,
// since it's the same tool-calling wire contract on both ends.
// ---------------------------------------------------------------------------

test("complete(): a same-provider fallback with tools attached is accepted (not rejected the way a cross-provider one is)", async () => {
  // A same-provider fallback hop shares its provider key with the primary
  // request, so it resolves to this same registered driver -- there is only
  // ever one driver per provider in the registry, unlike the cross-provider
  // case where primary/fallback are genuinely different drivers.
  const anthropicDriver = fakeDriver("anthropic", { complete: async (request) => fixtureResponse("anthropic", request.model) });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    fallback: [{ provider: "anthropic", model: "primary-model-b" }],
    tools: [{ name: "noop", inputSchema: { type: "object" } }],
  };

  const response = await complete(request, CREDENTIALS, { drivers: { anthropic: anthropicDriver } });
  assert.equal(anthropicDriver.calls, 1, "the primary attempt alone should succeed; assertNoFallbackWithTools must not have rejected this request");
  assert.equal(response.provider, "anthropic");
  assert.equal(response.model, "primary-model");
});

test("complete(): a same-provider fallback with tools actually fails over on retryable-exhaustion, same as the no-tools case", async (t) => {
  // A same-provider fallback hop reuses the SAME registered driver as the
  // primary (there is exactly one driver per provider key in the registry),
  // so this fakeDriver has to distinguish primary vs. fallback by the
  // *model* each hop actually requests, not by which driver instance was
  // called -- unlike the cross-provider tests above, where primary and
  // fallback are genuinely different driver objects.
  const anthropicDriver = fakeDriver("anthropic", {
    complete: async (request) => {
      if (request.model === BASE_REQUEST.model) {
        throw createLlmError("transport", "primary model down");
      }
      return fixtureResponse("anthropic", request.model);
    },
  });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    fallback: [{ provider: "anthropic", model: "fallback-model-same-provider" }],
    tools: [{ name: "noop", inputSchema: { type: "object" } }],
  };

  const response = await withFakeTimers(t, () => complete(request, CREDENTIALS, { drivers: { anthropic: anthropicDriver } }));
  assert.equal(anthropicDriver.calls, MAX_RETRIES + 1 + 1, "primary's own retry budget (MAX_RETRIES+1 calls), then one more call for the fallback hop");
  assert.equal(response.model, "fallback-model-same-provider");
});

test("complete(): tools + a fallback list mixing a same-provider hop and a cross-provider hop is still rejected (any cross-provider hop triggers it)", async () => {
  const primary = fakeDriver("anthropic", {
    complete: async () => {
      throw new Error("must never be attempted: rejected before dispatch");
    },
  });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    fallback: [
      { provider: "anthropic", model: "same-provider-model" },
      { provider: "openai", model: "cross-provider-model" },
    ],
    tools: [{ name: "noop", inputSchema: { type: "object" } }],
  };

  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: primary } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0);
});

// ---------------------------------------------------------------------------
// complete(): fails over only on retryable-exhaustion
// ---------------------------------------------------------------------------

test("complete(): falls over to the next provider only after the primary's retries are exhausted on a retryable class", async (t) => {
  const primary = fakeDriver("anthropic", {
    complete: async () => {
      throw createLlmError("transport", "primary down");
    },
  });
  const fallback = fakeDriver("openai", { complete: async (request) => fixtureResponse("openai", request.model) });

  const response = await withFakeTimers(t, () => complete(BASE_REQUEST, CREDENTIALS, { drivers: { anthropic: primary, openai: fallback } }));

  assert.equal(primary.calls, MAX_RETRIES + 1, "primary should exhaust its own retry budget before failing over");
  assert.equal(fallback.calls, 1);
  assert.equal(response.provider, "openai", "the response must name the provider that actually answered");
  assert.equal(response.model, "fallback-model");
});

test("complete(): does not fail over on a non-retryable error -- it propagates immediately", async () => {
  const primary = fakeDriver("anthropic", {
    complete: async () => {
      throw createLlmError("invalid_request", "bad params");
    },
  });
  const fallback = fakeDriver("openai", {
    complete: async () => {
      throw new Error("fallback must never be called for a non-retryable primary error");
    },
  });

  await assert.rejects(
    () => complete(BASE_REQUEST, CREDENTIALS, { drivers: { anthropic: primary, openai: fallback } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 1, "invalid_request never retries, so exactly one attempt");
  assert.equal(fallback.calls, 0);
});

test("complete(): a request with no fallback array never touches any other provider, retryable or not", async (t) => {
  const primary = fakeDriver("anthropic", {
    complete: async () => {
      throw createLlmError("overloaded", "primary overloaded");
    },
  });
  const request: LlmRequest = { ...BASE_REQUEST, fallback: undefined };

  await assert.rejects(() => withFakeTimers(t, () => complete(request, CREDENTIALS, { drivers: { anthropic: primary } })));
  assert.equal(primary.calls, MAX_RETRIES + 1);
});

// ---------------------------------------------------------------------------
// stream(): fallover only before the first delta is yielded to the consumer
// ---------------------------------------------------------------------------

test("stream(): fails over to the next provider when the primary never yields a delta before retries are exhausted", async (t) => {
  const primary = fakeDriver("anthropic", {
    async *stream() {
      throw createLlmError("transport", "primary stream never opened");
    },
  });
  const fallback = fakeDriver("openai", {
    async *stream(request) {
      yield { kind: "text", text: "from fallback" } as const;
      yield { kind: "done", response: fixtureResponse("openai", request.model) } as const;
    },
  });

  const collected = await drainWithFakeTimers(t, stream(BASE_REQUEST, CREDENTIALS, { drivers: { anthropic: primary, openai: fallback } }));

  assert.equal(primary.calls, MAX_RETRIES + 1);
  assert.equal(fallback.calls, 1);
  const done = collected.find((d): d is Extract<LlmDelta, { kind: "done" }> => d.kind === "done");
  assert.equal(done?.response.provider, "openai");
});

test("stream(): once a delta has been yielded, a later retryable failure throws immediately without failing over", async () => {
  const primary = fakeDriver("anthropic", {
    async *stream() {
      yield { kind: "text", text: "partial from primary" } as const;
      throw createLlmError("transport", "connection dropped mid-stream");
    },
  });
  const fallback = fakeDriver("openai", {
    async *stream() {
      throw new Error("fallback must never be called once the primary has already streamed content");
    },
  });

  const collected: LlmDelta[] = [];
  await assert.rejects(async () => {
    for await (const delta of stream(BASE_REQUEST, CREDENTIALS, { drivers: { anthropic: primary, openai: fallback } })) {
      collected.push(delta);
    }
  }, (error: { class: string }) => error.class === "transport");

  assert.deepEqual(collected, [{ kind: "text", text: "partial from primary" }]);
  assert.equal(primary.calls, 1, "no retry either, once content has streamed");
  assert.equal(fallback.calls, 0);
});

test("stream(): rejects fallback+tools before attempting the primary stream", async () => {
  const primary = fakeDriver("anthropic", {
    async *stream() {
      throw new Error("must not be called");
    },
  });
  const request: LlmRequest = { ...BASE_REQUEST, tools: [{ name: "noop", inputSchema: { type: "object" } }] };

  await assert.rejects(async () => {
    for await (const _delta of stream(request, CREDENTIALS, { drivers: { anthropic: primary } })) {
      // never reached
    }
  }, (error: { class: string }) => error.class === "invalid_request");
  assert.equal(primary.calls, 0);
});

// ---------------------------------------------------------------------------
// Finding #87: caller cancellation (LlmRequest.signal) stops retry/fallover
// immediately -- neither complete() nor stream() retries the same hop or
// fails over to another one once the caller's own signal has fired, even if
// the driver's error is otherwise a retryable class (e.g. "transport",
// exactly what a real driver reports when its own composed AbortController
// fires -- see drivers/abort.ts).
// ---------------------------------------------------------------------------

test("complete(): a pre-aborted signal rejects before dispatch even when a custom driver ignores signals", async () => {
  const reason = new Error("cancelled before complete");
  const controller = new AbortController();
  controller.abort(reason);
  const primary = fakeDriver("anthropic", {
    complete: async () => fixtureResponse("anthropic", "primary-model"),
  });

  await assert.rejects(
    () => complete({ ...BASE_REQUEST, signal: controller.signal }, CREDENTIALS, { drivers: { anthropic: primary } }),
    (error: unknown) => error === reason,
  );
  assert.equal(primary.calls, 0);
});

test("stream(): a pre-aborted signal rejects before dispatch even when a custom driver ignores signals", async () => {
  const reason = new Error("cancelled before stream");
  const controller = new AbortController();
  controller.abort(reason);
  const primary = fakeDriver("anthropic", {
    async *stream(request) {
      yield { kind: "done", response: fixtureResponse("anthropic", request.model) } as const;
    },
  });

  await assert.rejects(async () => {
    for await (const _delta of stream({ ...BASE_REQUEST, signal: controller.signal }, CREDENTIALS, { drivers: { anthropic: primary } })) {
      // never reached
    }
  }, (error: unknown) => error === reason);
  assert.equal(primary.calls, 0);
});

test("complete(): once the caller's signal has fired, a retryable error stops immediately instead of retrying or failing over", async () => {
  const controller = new AbortController();
  const primary = fakeDriver("anthropic", {
    complete: async () => {
      // Simulates what a real driver does once its own per-attempt
      // AbortController (composed with this caller signal) fires mid-flight.
      controller.abort();
      throw createLlmError("transport", "aborted mid-flight");
    },
  });
  const fallback = fakeDriver("openai", {
    complete: async () => {
      throw new Error("fallback must never be attempted once the caller has cancelled");
    },
  });
  const request: LlmRequest = { ...BASE_REQUEST, signal: controller.signal };

  const start = Date.now();
  await assert.rejects(() => complete(request, CREDENTIALS, { drivers: { anthropic: primary, openai: fallback } }));
  const elapsedMs = Date.now() - start;

  assert.equal(primary.calls, 1, "must not retry the primary once the caller's signal has fired");
  assert.equal(fallback.calls, 0, "must not fail over to another provider once the caller's signal has fired");
  assert.ok(elapsedMs < 500, `must not wait out a computed backoff sleep once the signal is already aborted (took ${elapsedMs}ms)`);
});

test("complete(): a signal that fires DURING backoff (between retries) cuts the wait short instead of sleeping out the full backoff", async () => {
  const controller = new AbortController();
  let calls = 0;
  const primary = fakeDriver("anthropic", {
    complete: async () => {
      calls += 1;
      // A deliberately long explicit wait so an uninterrupted sleep would
      // take seconds -- proves the abort actually cuts it short.
      throw createLlmError("transport", "still down", { retryAfterMs: 5000 });
    },
  });
  const request: LlmRequest = { ...BASE_REQUEST, fallback: undefined, signal: controller.signal };
  setTimeout(() => controller.abort(), 30);

  const start = Date.now();
  await assert.rejects(() => complete(request, CREDENTIALS, { drivers: { anthropic: primary } }));
  const elapsedMs = Date.now() - start;

  assert.equal(calls, 1, "the abort must land during the first backoff sleep, before a second attempt");
  assert.ok(elapsedMs < 1000, `expected the signal to cut the 5s backoff short, took ${elapsedMs}ms`);
});

test("stream(): once the caller's signal has fired before any delta, a retryable error stops immediately instead of retrying or failing over", async () => {
  const controller = new AbortController();
  const primary = fakeDriver("anthropic", {
    async *stream() {
      controller.abort();
      throw createLlmError("transport", "aborted mid-flight");
    },
  });
  const fallback = fakeDriver("openai", {
    async *stream() {
      throw new Error("fallback must never be attempted once the caller has cancelled");
    },
  });
  const request: LlmRequest = { ...BASE_REQUEST, signal: controller.signal };

  const start = Date.now();
  await assert.rejects(async () => {
    for await (const _delta of stream(request, CREDENTIALS, { drivers: { anthropic: primary, openai: fallback } })) {
      // never reached
    }
  });
  const elapsedMs = Date.now() - start;

  assert.equal(primary.calls, 1, "must not retry the primary hop once the caller's signal has fired");
  assert.equal(fallback.calls, 0, "must not fail over to another provider once the caller's signal has fired");
  assert.ok(elapsedMs < 500, `must not wait out a computed backoff sleep once the signal is already aborted (took ${elapsedMs}ms)`);
});

test("stream(): a signal that fires DURING backoff cuts the wait short (proves request.signal is actually threaded into the manual sleep() call)", async () => {
  const controller = new AbortController();
  let calls = 0;
  const primary = fakeDriver("anthropic", {
    async *stream() {
      calls += 1;
      throw createLlmError("transport", "still down", { retryAfterMs: 5000 });
    },
  });
  const request: LlmRequest = { ...BASE_REQUEST, fallback: undefined, signal: controller.signal };
  setTimeout(() => controller.abort(), 30);

  const start = Date.now();
  await assert.rejects(async () => {
    for await (const _delta of stream(request, CREDENTIALS, { drivers: { anthropic: primary } })) {
      // never reached
    }
  });
  const elapsedMs = Date.now() - start;

  assert.equal(calls, 1, "the abort must land during the first backoff sleep, before a second attempt");
  assert.ok(elapsedMs < 1000, `expected the signal to cut the 5s backoff short, took ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// Unregistered / uncredentialed providers are library-boundary errors, not
// silent fallthrough.
// ---------------------------------------------------------------------------

test("complete(): naming a provider with no registered driver is invalid_request, not a crash", async () => {
  const request: LlmRequest = { ...BASE_REQUEST, provider: "google", model: "whatever", fallback: undefined };
  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: fakeDriver("anthropic", {}) } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
});

test("complete(): a provider with no supplied credentials is invalid_request, not a silent default", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const request: LlmRequest = { ...BASE_REQUEST, fallback: undefined };
  await assert.rejects(
    () => complete(request, {}, { drivers: { anthropic: primary } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0);
});
