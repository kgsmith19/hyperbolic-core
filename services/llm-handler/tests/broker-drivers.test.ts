// Proves the additive integration seam (issue #186) actually works end to
// end through packages/llm's real complete() orchestration, not just that
// broker-drivers.ts's own helpers return plausible-looking values.

import assert from "node:assert/strict";
import { test } from "node:test";
import { complete } from "@hyperbolic/llm";
import type { LlmRequest } from "@hyperbolic/llm";
import { brokerCredentials, brokerRoutedDrivers, loadBrokerDriverConfig } from "../src/broker-drivers.ts";

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
