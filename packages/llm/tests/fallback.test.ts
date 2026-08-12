import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, stream } from "../src/complete.ts";
import { createLlmError } from "../src/errors.ts";
import type { LlmDriver } from "../src/drivers/types.ts";
import { MAX_RETRIES } from "../src/retry.ts";
import type { Credentials, LlmDelta, LlmRequest, LlmResponse, Provider } from "../src/types.ts";

/** A minimal fake driver whose complete()/stream() behavior and call count
 * are fully controlled by the test -- no real network, no real SDK. This
 * is what makes the fallback/retry-hop tests exact and fast: they exercise
 * complete.ts's own orchestration logic in isolation from any one driver's
 * wire format. */
function fakeDriver(
  provider: Provider,
  behavior: {
    complete?: (request: LlmRequest, credentials: Credentials) => Promise<LlmResponse>;
    stream?: (request: LlmRequest, credentials: Credentials) => AsyncGenerator<LlmDelta, void, unknown>;
  },
): LlmDriver & { calls: number } {
  const driver = {
    provider,
    calls: 0,
    async complete(request: LlmRequest, credentials: Credentials): Promise<LlmResponse> {
      driver.calls += 1;
      if (!behavior.complete) {
        throw new Error(`fakeDriver(${provider}): complete() not implemented for this test`);
      }
      return behavior.complete(request, credentials);
    },
    async *stream(request: LlmRequest, credentials: Credentials): AsyncGenerator<LlmDelta, void, unknown> {
      driver.calls += 1;
      if (!behavior.stream) {
        throw new Error(`fakeDriver(${provider}): stream() not implemented for this test`);
      }
      yield* behavior.stream(request, credentials);
    },
  };
  return driver;
}

/** Drives `run()` to completion under fake timers, so a test that forces a
 * real retry/backoff wait (via a genuinely retryable fake-driver error)
 * doesn't burn real wall-clock seconds. Re-throws a rejection so callers can
 * still use `assert.rejects(() => withFakeTimers(t, ...))`. */
async function withFakeTimers<T>(t: { mock: { timers: { enable(opts: { apis: string[] }): void; tick(ms: number): void } } }, run: () => Promise<T>): Promise<T> {
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
  t: { mock: { timers: { enable(opts: { apis: string[] }): void; tick(ms: number): void } } },
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

function fixtureResponse(provider: Provider, model: string): LlmResponse {
  return {
    text: `answered by ${provider}/${model}`,
    toolCalls: [],
    stopReason: "end",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
    provider,
    model,
    latencyMs: 1,
  };
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
// Unregistered / uncredentialed providers are library-boundary errors, not
// silent fallthrough.
// ---------------------------------------------------------------------------

test("complete(): naming a provider with no registered driver is invalid_request, not a crash", async () => {
  const request: LlmRequest = { ...BASE_REQUEST, provider: "gemini", model: "whatever", fallback: undefined };
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
