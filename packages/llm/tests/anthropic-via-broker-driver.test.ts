import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { anthropicViaBrokerDriver } from "../src/drivers/anthropic-via-broker.ts";
import { isLlmError } from "../src/errors.ts";
import type { LlmRequest } from "../src/types.ts";
import { jsonResponse, withPatchedFetch } from "./driver-harness.ts";

// A real local HTTP server standing in for the broker, for the two cases
// below where a fetch-mocked in-memory Response cannot faithfully reproduce
// the bug (round-2 independent review's finding: every prior test in this
// file replaced globalThis.fetch with an in-memory stub, which silently
// masked a real timeout-enforcement bug -- a pre-buffered Response never
// exercises a stalled body read at all).
function withRealUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        await fn(port);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

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

test("anthropicViaBrokerDriver.complete: timeoutMs is enforced against the FULL response including the body read, not just until headers arrive -- a broker that stalls mid-body does not hang past timeoutMs", async () => {
  await withRealUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"id":"msg_'); // headers + partial body sent, then stalls forever
    },
    async (port) => {
      const request: LlmRequest = { ...BASE_REQUEST, timeoutMs: 200 };
      const startedAt = Date.now();
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(request, { apiKey: "t", baseUrl: `http://127.0.0.1:${port}` }),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "transport");
          return true;
        },
      );
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 3000, `expected rejection near timeoutMs (200ms); took ${elapsedMs}ms -- the body read was not actually bounded by the timer`);
    },
  );
});

test("anthropicViaBrokerDriver.complete: a broker-relayed 2xx response with an EMPTY body raises a clean LlmError (provider_bug), never a raw unclassified TypeError", async () => {
  await withRealUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(); // 2xx, genuinely zero-length body
    },
    async (port) => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, { apiKey: "t", baseUrl: `http://127.0.0.1:${port}` }),
        (err: unknown) => {
          assert.ok(isLlmError(err), `expected a classified LlmError, got ${err instanceof Error ? err.constructor.name : typeof err}: ${err}`);
          assert.equal(err.class, "provider_bug");
          return true;
        },
      );
    },
  );
});

test("anthropicViaBrokerDriver.complete: a broker-relayed 2xx response whose body is the JSON literal `null` raises a clean LlmError, never a raw TypeError", async () => {
  await withRealUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("null");
    },
    async (port) => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, { apiKey: "t", baseUrl: `http://127.0.0.1:${port}` }),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "provider_bug");
          return true;
        },
      );
    },
  );
});

test("anthropicViaBrokerDriver.complete: a non-JSON error body on a 5xx (e.g. an HTML page from a reverse proxy in front of the broker) classifies as transport (retryable), not hardcoded provider_bug", async () => {
  await withPatchedFetch(
    async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
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

test("anthropicViaBrokerDriver.complete: a malformed credentials.baseUrl is refused synchronously as invalid_request (non-retryable), before any fetch, not misclassified as a retryable transport failure", async () => {
  let fetchCalled = false;
  await withPatchedFetch(
    async () => {
      fetchCalled = true;
      return jsonResponse(fixtureMessage());
    },
    async () => {
      await assert.rejects(
        () => anthropicViaBrokerDriver.complete(BASE_REQUEST, { apiKey: "t", baseUrl: "not a url at all" }),
        (err: unknown) => {
          assert.ok(isLlmError(err));
          assert.equal(err.class, "invalid_request");
          assert.equal(err.retryable, false);
          return true;
        },
      );
    },
  );
  assert.equal(fetchCalled, false);
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
