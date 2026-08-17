import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicViaBrokerDriver } from "../src/drivers/anthropic-via-broker.ts";
import { isLlmError } from "../src/errors.ts";
import type { LlmRequest } from "../src/types.ts";
import { jsonResponse, withPatchedFetch } from "./driver-harness.ts";

// This driver never talks to a provider directly -- every fetch below is
// asserted to go to the BROKER's own /proxy endpoint, and the fake
// "upstream" response here stands in for what services/broker's own HTTP
// response looks like (proxy.ts mirrors the real Anthropic response's
// status/body onto its own response verbatim, per server.ts).

const BASE_REQUEST: LlmRequest = {
  provider: "anthropic",
  model: "claude-request-alias",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 256,
  metadata: { callerApp: "test-suite", purpose: "unit-test" },
  timeoutMs: 30_000,
};

const BROKER_CREDENTIALS = { apiKey: "broker-caller-token", baseUrl: "http://127.0.0.1:8300" };

function fixtureMessage(overrides: Record<string, unknown> = {}) {
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
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3,
      cache_creation: null,
      inference_geo: null,
    },
    ...overrides,
  };
}

test("anthropicViaBrokerDriver.complete: posts the broker's JSON envelope to <baseUrl>/proxy, naming api.anthropic.com and the anthropic vault key/header", async () => {
  let capturedUrl: string | undefined;
  let capturedEnvelope: Record<string, unknown> | undefined;
  await withPatchedFetch(
    async (input, init) => {
      capturedUrl = String(input);
      capturedEnvelope = JSON.parse(String(init?.body));
      return jsonResponse(fixtureMessage());
    },
    () => anthropicViaBrokerDriver.complete(BASE_REQUEST, BROKER_CREDENTIALS),
  );
  assert.equal(capturedUrl, "http://127.0.0.1:8300/proxy");
  assert.equal(capturedEnvelope?.caller, "llm-handler");
  assert.equal(capturedEnvelope?.token, "broker-caller-token");
  assert.equal(capturedEnvelope?.targetHost, "api.anthropic.com");
  assert.equal(capturedEnvelope?.protocol, "https");
  assert.equal(capturedEnvelope?.method, "POST");
  assert.equal(capturedEnvelope?.path, "/v1/messages");
  assert.equal(capturedEnvelope?.credential, "LLM_KEYS_ANTHROPIC");
  assert.equal(capturedEnvelope?.credentialHeader, "x-api-key");
  const headers = capturedEnvelope?.headers as Record<string, string>;
  assert.equal(headers["anthropic-version"], "2023-06-01");
  // The inner body is the exact same wire request buildParams() already
  // produces for the direct SDK driver -- reused, not re-derived.
  const innerBody = JSON.parse(capturedEnvelope?.body as string);
  assert.equal(innerBody.model, "claude-request-alias");
  assert.equal(innerBody.stream, false);
});

test("anthropicViaBrokerDriver.complete: maps a successful broker-relayed response through fromAnthropicMessage exactly like the direct driver", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse(fixtureMessage()),
    () => anthropicViaBrokerDriver.complete(BASE_REQUEST, BROKER_CREDENTIALS),
  );
  assert.equal(response.provider, "anthropic");
  assert.equal(response.model, "claude-fixture-resolved");
  assert.equal(response.text, "hello there");
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
});

test("anthropicViaBrokerDriver.complete: a broker-level credential refusal (403) is classified distinctly from a real provider error, never silently treated as success", async () => {
  await withPatchedFetch(
    async () => jsonResponse({ error: "credential request refused", reason: 'caller "llm-handler" is not authorized' }, 403),
    async () => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, BROKER_CREDENTIALS),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "provider_bug");
          assert.match(err.message, /credential request refused/);
          return true;
        },
      );
    },
  );
});

test("anthropicViaBrokerDriver.complete: a broker upstream failure (502, e.g. an unprovisioned credential or unreachable target) classifies as transport, not a provider auth failure", async () => {
  await withPatchedFetch(
    async () => jsonResponse({ error: "broker upstream request failed", message: "connect ECONNREFUSED" }, 502),
    async () => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, BROKER_CREDENTIALS),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "transport");
          assert.equal(err.retryable, true);
          return true;
        },
      );
    },
  );
});

test("anthropicViaBrokerDriver.complete: a genuine Anthropic error relayed through the broker unmodified (e.g. 429) classifies exactly like the direct driver would", async () => {
  await withPatchedFetch(
    async () => jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429),
    async () => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, BROKER_CREDENTIALS),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "rate_limit");
          assert.match(err.message, /slow down/);
          return true;
        },
      );
    },
  );
});

test("anthropicViaBrokerDriver.complete: Anthropic's 529 overloaded status is classified as overloaded, same quirk as the direct driver", async () => {
  await withPatchedFetch(
    async () => jsonResponse({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }, 529),
    async () => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, BROKER_CREDENTIALS),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "overloaded");
          return true;
        },
      );
    },
  );
});

test("anthropicViaBrokerDriver.complete: refuses synchronously (before any fetch) when credentials.baseUrl is missing -- there is no default broker address to fall back to", async () => {
  let fetchCalled = false;
  await withPatchedFetch(
    async () => {
      fetchCalled = true;
      return jsonResponse(fixtureMessage());
    },
    async () => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, { apiKey: "broker-token" }),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "invalid_request");
          return true;
        },
      );
    },
  );
  assert.equal(fetchCalled, false);
});

test("anthropicViaBrokerDriver.complete: refuses synchronously when credentials.apiKey (the broker caller-auth token) is missing", async () => {
  await assert.rejects(
    () => anthropicViaBrokerDriver.complete(BASE_REQUEST, { apiKey: "", baseUrl: "http://127.0.0.1:8300" }),
    (err: unknown) => {
      assert.ok(isLlmError(err));
      assert.equal(err.class, "invalid_request");
      return true;
    },
  );
});

test("anthropicViaBrokerDriver.complete: a network-level fetch failure (broker itself unreachable) classifies as transport", async () => {
  await withPatchedFetch(
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, BROKER_CREDENTIALS),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "transport");
          return true;
        },
      );
    },
  );
});

test("anthropicViaBrokerDriver.stream: throws a clear, disclosed 'not yet supported' error and never yields -- honest about the broker's own buffering limitation", async () => {
  const gen = anthropicViaBrokerDriver.stream(BASE_REQUEST, BROKER_CREDENTIALS);
  await assert.rejects(
    () => gen.next(),
    (err: unknown) => {
      assert.ok(isLlmError(err));
      assert.match(err.message, /streaming through the broker is not yet supported/);
      return true;
    },
  );
});
