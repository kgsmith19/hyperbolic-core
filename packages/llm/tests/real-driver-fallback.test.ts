import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../src/complete.ts";
import { anthropicDriver } from "../src/drivers/anthropic.ts";
import { geminiDriver } from "../src/drivers/gemini.ts";
import { openaiDriver } from "../src/drivers/openai.ts";
import { MAX_RETRIES } from "../src/retry.ts";
import type { LlmRequest } from "../src/types.ts";

/**
 * Acceptance criteria 1 and 2 from m4-02, proven with REAL driver instances
 * (not fakeDriver()) and a fake HTTP transport shaped like each provider's
 * genuine wire format -- fallback.test.ts already proves the orchestration
 * logic itself in isolation using fakeDriver(); this file proves that the
 * same logic actually works when wired up to this issue's two new real
 * drivers (and, via DEFAULT_DRIVERS, the real Anthropic driver too), so a
 * genuine OpenAI or Gemini error shape drives the fail-over decision, not a
 * fake one asserting whatever the test wants.
 */

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function openaiErrorResponse(status: number, message: string): Response {
  return jsonResponse({ error: { message, type: null, param: null, code: null } }, status);
}

function fixtureGeminiGenerateContentResponse(): unknown {
  return {
    candidates: [{ content: { role: "model", parts: [{ text: "from gemini" }] }, finishReason: "STOP", index: 0 }],
    modelVersion: "gemini-fixture-resolved",
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
}

const BASE_REQUEST: LlmRequest = {
  provider: "openai",
  model: "gpt-primary",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 128,
  metadata: { callerApp: "test-suite", purpose: "unit-test" },
  timeoutMs: 5000,
  fallback: [{ provider: "google", model: "gemini-fallback" }],
};

const CREDENTIALS = { openai: { apiKey: "openai-fixture-key" }, google: { apiKey: "gemini-fixture-key" } };

/** Distinguishes which provider a given fetch call was aimed at, purely
 * from the request URL -- lets one fake transport serve two real SDKs
 * (each of which uses the global fetch directly, no bundled/shadowed
 * binding -- verified by reading both SDKs' source, same as the per-driver
 * test files' own fetch-patching idiom). */
function providerForUrl(input: RequestInfo | URL): "openai" | "google" | "unknown" {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("openai.com")) {
    return "openai";
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    return "google";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: fail over on retryable exhaustion, real drivers,
// real SDK error/success shapes; the answering provider is named.
// ---------------------------------------------------------------------------

test("complete(): with DEFAULT_DRIVERS (no explicit `drivers` override), a real OpenAI 500 exhausts retries and fails over to a real Gemini success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let openaiCalls = 0;
  let geminiCalls = 0;

  const promise = withPatchedFetch(async (input) => {
    const provider = providerForUrl(input);
    if (provider === "openai") {
      openaiCalls += 1;
      return openaiErrorResponse(500, "internal error fixture");
    }
    if (provider === "google") {
      geminiCalls += 1;
      return jsonResponse(fixtureGeminiGenerateContentResponse());
    }
    throw new Error(`unexpected fetch target: ${String(input)}`);
  }, () => complete(BASE_REQUEST, CREDENTIALS));

  let settled: { ok: boolean; value?: unknown; error?: unknown } | undefined;
  promise.then(
    (value) => (settled = { ok: true, value }),
    (error) => (settled = { ok: false, error }),
  );
  for (let i = 0; i < 40 && !settled; i++) {
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(settled, "did not settle within the fake-timer budget");
  assert.equal(settled?.ok, true, `expected success, got ${String((settled as { error?: unknown })?.error)}`);
  const response = (settled as { value: { provider: string; model: string; text: string | null } }).value;
  assert.equal(response.provider, "google", "the response must name the provider that actually answered");
  assert.equal(response.model, "gemini-fixture-resolved");
  assert.equal(response.text, "from gemini");
  assert.equal(openaiCalls, MAX_RETRIES + 1, "the primary (openai) must exhaust its own retry budget before failing over");
  assert.equal(geminiCalls, 1);
});

test("complete(): a non-retryable real OpenAI 400 does not fail over to Gemini -- it propagates immediately as a typed error", async () => {
  let openaiCalls = 0;
  let geminiCalls = 0;
  await assert.rejects(
    () =>
      withPatchedFetch(async (input) => {
        const provider = providerForUrl(input);
        if (provider === "openai") {
          openaiCalls += 1;
          return openaiErrorResponse(400, "bad request fixture");
        }
        geminiCalls += 1;
        throw new Error("gemini must never be called for a non-retryable primary error");
      }, () => complete(BASE_REQUEST, CREDENTIALS)),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(openaiCalls, 1);
  assert.equal(geminiCalls, 0);
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: fallback + tools is invalid_request before any
// network call, confirmed with real driver instances registered.
// ---------------------------------------------------------------------------

test("complete(): fallback+tools is rejected as invalid_request before any network call, with real Anthropic/OpenAI/Gemini driver instances registered", async () => {
  let fetchCalls = 0;
  const request: LlmRequest = { ...BASE_REQUEST, tools: [{ name: "noop", inputSchema: { type: "object" } }] };
  await withPatchedFetch(
    async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
    async () => {
      await assert.rejects(
        () => complete(request, CREDENTIALS, { drivers: { anthropic: anthropicDriver, openai: openaiDriver, gemini: geminiDriver } }),
        (error: { class: string }) => error.class === "invalid_request",
      );
    },
  );
  assert.equal(fetchCalls, 0, "the guard must fire before either driver is ever invoked");
});

test("complete(): fallback+tools is rejected the same way via DEFAULT_DRIVERS (no explicit `drivers` override)", async () => {
  let fetchCalls = 0;
  const request: LlmRequest = { ...BASE_REQUEST, tools: [{ name: "noop", inputSchema: { type: "object" } }] };
  await withPatchedFetch(
    async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
    async () => {
      await assert.rejects(
        () => complete(request, CREDENTIALS),
        (error: { class: string }) => error.class === "invalid_request",
      );
    },
  );
  assert.equal(fetchCalls, 0);
});
