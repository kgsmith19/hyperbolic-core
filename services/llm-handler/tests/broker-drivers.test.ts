// Proves the additive integration seam (issue #186) actually works end to
// end through packages/llm's real complete() orchestration, not just that
// broker-drivers.ts's own helpers return plausible-looking values.

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicViaBrokerDriver, complete, geminiDriver, openaiDriver } from "@hyperbolic/llm";
import type { LlmRequest } from "@hyperbolic/llm";
import { brokerCredentials, brokerMergedCredentials, brokerMergedDrivers, brokerRoutedDrivers, loadBrokerDriverConfig } from "../src/broker-drivers.ts";
import { loadConfig } from "../src/config.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function withPatchedFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const REQUEST: LlmRequest = {
  provider: "anthropic",
  model: "claude-request-alias",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 256,
  metadata: { callerApp: "test-suite", purpose: "unit-test" },
  timeoutMs: 30_000,
};

function fixtureMessage() {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-fixture-resolved",
    content: [{ type: "text", text: "hello there", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    container: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null },
  };
}

test("loadBrokerDriverConfig: undefined (not a thrown error) when BROKER_URL/BROKER_CALLER_TOKEN are unset -- this integration point never blocks Handler A's own startup", () => {
  assert.equal(loadBrokerDriverConfig({}), undefined);
  assert.equal(loadBrokerDriverConfig({ BROKER_URL: "http://127.0.0.1:8300" }), undefined);
  assert.equal(loadBrokerDriverConfig({ BROKER_CALLER_TOKEN: "t" }), undefined);
});

test("loadBrokerDriverConfig: reads both vars together when both are provisioned", () => {
  const config = loadBrokerDriverConfig({ BROKER_URL: "http://127.0.0.1:8300", BROKER_CALLER_TOKEN: "caller-token" });
  assert.deepEqual(config, { brokerBaseUrl: "http://127.0.0.1:8300", brokerCallerToken: "caller-token" });
});

test("integration: complete() with brokerRoutedDrivers() actually routes an anthropic call through the broker envelope, end to end", async () => {
  const config = loadBrokerDriverConfig({ BROKER_URL: "http://127.0.0.1:8300", BROKER_CALLER_TOKEN: "caller-token" });
  assert.ok(config);

  let capturedUrl: string | undefined;
  const response = await withPatchedFetch(
    (async (input: unknown) => {
      capturedUrl = String(input);
      return jsonResponse(fixtureMessage());
    }) as typeof fetch,
    () =>
      complete(REQUEST, { anthropic: brokerCredentials(config) }, { drivers: brokerRoutedDrivers() }),
  );

  assert.equal(capturedUrl, "http://127.0.0.1:8300/proxy");
  assert.equal(response.provider, "anthropic");
  assert.equal(response.text, "hello there");
});

// ---------------------------------------------------------------------------
// Phase 0 merge helpers (issue #187): complete()'s `options.drivers` REPLACES
// the whole registry (DEFAULT_DRIVERS is not exported and not merged), so a
// registry carrying ONLY the broker-routed anthropic driver would silently
// drop openai/google routing entirely. These helpers exist to prove the
// merged registry/credentials keep both providers on their direct paths.
// ---------------------------------------------------------------------------

test("brokerMergedDrivers: anthropic is broker-routed while openai/google keep the exact direct driver objects packages/llm exports", () => {
  const merged = brokerMergedDrivers();
  assert.equal(merged.anthropic, anthropicViaBrokerDriver);
  assert.equal(merged.openai, openaiDriver, "openai must stay on its direct driver -- the broker holds no OpenAI credential");
  assert.equal(merged.google, geminiDriver, "google must stay on its direct driver -- the broker holds no Google credential");
});

test("brokerMergedCredentials: anthropic's slot carries the broker caller token/baseUrl; openai/google keep their real keys", () => {
  const config = { brokerBaseUrl: "http://broker:8300", brokerCallerToken: "caller-token" };
  const merged = brokerMergedCredentials(
    { anthropic: { apiKey: "real-anthropic-key" }, openai: { apiKey: "real-openai-key" }, google: { apiKey: "real-google-key" } },
    config,
  );
  assert.deepEqual(merged.anthropic, { apiKey: "caller-token", baseUrl: "http://broker:8300" });
  assert.deepEqual(merged.openai, { apiKey: "real-openai-key" });
  assert.deepEqual(merged.google, { apiKey: "real-google-key" });
});

test("brokerMergedCredentials: does not mutate the input credentials object (the direct-credentials object stays usable for /api/v1/stream)", () => {
  const direct = { anthropic: { apiKey: "real-anthropic-key" } };
  brokerMergedCredentials(direct, { brokerBaseUrl: "http://broker:8300", brokerCallerToken: "t" });
  assert.deepEqual(direct.anthropic, { apiKey: "real-anthropic-key" });
});

const BASE_REQUIRED_ENV = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "anon-key",
  TOOLBELT_GITHUB_INTAKE_PAT: "ghp_fixture",
};

/** loadConfig(env) reads its optional keys from the passed env, but its
 * required() helper reads process.env directly (pre-existing behavior, not
 * changed by issue #187 Phase 0) -- so the three startup-required vars are
 * temporarily placed on process.env here, and restored after. */
function withRequiredProcessEnv<T>(run: () => T): T {
  const saved = new Map(Object.entries(BASE_REQUIRED_ENV).map(([key]) => [key, process.env[key]] as const));
  Object.assign(process.env, BASE_REQUIRED_ENV);
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadConfig: without BROKER_URL/BROKER_CALLER_TOKEN the config carries no broker entry -- exactly today's config, nothing required", () => {
  const config = withRequiredProcessEnv(() => loadConfig({ ...BASE_REQUIRED_ENV }));
  assert.equal(config.broker, undefined);
});

test("loadConfig: with BROKER_URL and BROKER_CALLER_TOKEN both set, the config carries the broker driver config", () => {
  const config = withRequiredProcessEnv(() =>
    loadConfig({ ...BASE_REQUIRED_ENV, BROKER_URL: "http://broker:8300", BROKER_CALLER_TOKEN: "caller-token" }),
  );
  assert.deepEqual(config.broker, { brokerBaseUrl: "http://broker:8300", brokerCallerToken: "caller-token" });
});
