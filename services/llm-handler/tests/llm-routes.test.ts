import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.ts";
import type { HandlerConfig } from "../src/types.ts";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Same idiom as server.test.ts's own withPatchedFetch: only the server's
// OUTBOUND calls (Supabase, the provider) are mocked; a request to the
// loopback server under test falls through to the real fetch.
async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("127.0.0.1") || url.includes("localhost")) {
      return original(input as RequestInfo, init);
    }
    return impl(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A minimal-but-complete non-streaming Anthropic Message fixture -- same
 * shape as packages/llm/tests/anthropic-driver.test.ts's own fixtureMessage,
 * duplicated here rather than imported (separate npm workspace, no
 * cross-package test import convention in this repo). */
function anthropicMessageFixture(overrides: Record<string, unknown> = {}) {
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

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(sseEvent(e.event, e.data)));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const CONFIG: HandlerConfig = {
  port: 0,
  supabaseUrl: "https://proj.supabase.co",
  supabasePublishableKey: "anon-key",
  githubIntakePat: "ghp_fixture",
  llmCredentials: { anthropic: { apiKey: "fixture-anthropic-key" } },
  llmMaxConcurrencyPerCaller: 2,
};
const SERVICE_ROLE_KEY = "service-role-key";

const REQUEST_BODY = {
  provider: "anthropic",
  model: "claude-fixture",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
  timeoutMs: 30_000,
  metadata: { callerApp: "fixture-app", purpose: "test" },
};

async function withServer<T>(config: HandlerConfig, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await startServer(config, SERVICE_ROLE_KEY);
  try {
    const { port } = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function ownerAndLogMock(onLog?: (body: Record<string, unknown>) => void): FetchImpl {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("is_platform_owner")) return jsonResponse(true);
    if (url.includes("rpc/log_llm_call")) {
      onLog?.(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({});
    }
    if (url.includes("anthropic.com")) return jsonResponse(anthropicMessageFixture());
    throw new Error(`unexpected call: ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Auth gate (m4-05 acceptance criterion: 401 without a valid owner session)
// ---------------------------------------------------------------------------

for (const route of ["/api/v1/complete", "/api/v1/stream", "/api/v1/count"]) {
  test(`POST ${route} with no Authorization header returns 401, no network call`, async () => {
    let networkCalled = false;
    await withPatchedFetch(
      async () => {
        networkCalled = true;
        return jsonResponse({});
      },
      () =>
        withServer(CONFIG, async (baseUrl) => {
          const res = await fetch(`${baseUrl}${route}`, { method: "POST", body: JSON.stringify(REQUEST_BODY) });
          assert.equal(res.status, 401);
        })
    );
    assert.equal(networkCalled, false, "a missing token must never reach the owner-session RPC");
  });

  test(`POST ${route} with a non-owner session returns 401`, async () => {
    await withPatchedFetch(
      async (input) => {
        assert.match(String(input), /is_platform_owner/);
        return jsonResponse(false);
      },
      () =>
        withServer(CONFIG, async (baseUrl) => {
          const res = await fetch(`${baseUrl}${route}`, {
            method: "POST",
            headers: { authorization: "Bearer non-owner-token" },
            body: JSON.stringify(REQUEST_BODY),
          });
          assert.equal(res.status, 401);
        })
    );
  });
}

// ---------------------------------------------------------------------------
// /v1/complete
// ---------------------------------------------------------------------------

test("POST /v1/complete with a malformed body (missing provider) returns 400 after a valid owner session", async () => {
  await withPatchedFetch(
    async (input) => {
      if (String(input).includes("is_platform_owner")) return jsonResponse(true);
      throw new Error(`unexpected call: ${input}`);
    },
    () =>
      withServer(CONFIG, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/v1/complete`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify({ model: "x" }),
        });
        assert.equal(res.status, 400);
      })
  );
});

test("POST /v1/complete: happy path returns 200 with an LlmResponse and logs exactly one core.llm_call row (status ok)", async () => {
  let logCalls = 0;
  let loggedEntry: Record<string, unknown> | undefined;
  await withPatchedFetch(
    ownerAndLogMock((body) => {
      logCalls += 1;
      loggedEntry = body;
    }),
    () =>
      withServer(CONFIG, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/v1/complete`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify(REQUEST_BODY),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { text: string; provider: string; usage: { inputTokens: number } };
        assert.equal(body.text, "hello there");
        assert.equal(body.provider, "anthropic");
        assert.equal(body.usage.inputTokens, 10);
      })
  );
  assert.equal(logCalls, 1, "exactly one core.llm_call row per completed call");
  assert.equal(loggedEntry?.p_caller_app, "fixture-app");
  assert.equal(loggedEntry?.p_purpose, "test");
  assert.equal(loggedEntry?.p_status, "ok");
});

test("POST /v1/complete: a provider error maps to a caller status and logs status=error", async () => {
  let loggedEntry: Record<string, unknown> | undefined;
  await withPatchedFetch(
    async (input, init) => {
      const url = String(input);
      if (url.includes("is_platform_owner")) return jsonResponse(true);
      if (url.includes("rpc/log_llm_call")) {
        loggedEntry = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({});
      }
      if (url.includes("anthropic.com")) {
        return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "bad request" }, request_id: "req_x" }, 400);
      }
      throw new Error(`unexpected call: ${url}`);
    },
    () =>
      withServer(CONFIG, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/v1/complete`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify(REQUEST_BODY),
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, "invalid_request");
      })
  );
  assert.equal(loggedEntry?.p_status, "error");
  assert.equal(loggedEntry?.p_error_class, "invalid_request");
});

test("POST /v1/complete: a caller at its concurrency cap gets 429, no provider call", async () => {
  const config: HandlerConfig = { ...CONFIG, llmMaxConcurrencyPerCaller: 1 };
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
  let providerCalls = 0;

  await withPatchedFetch(
    async (input) => {
      const url = String(input);
      if (url.includes("is_platform_owner")) return jsonResponse(true);
      if (url.includes("rpc/log_llm_call")) return jsonResponse({});
      if (url.includes("anthropic.com")) {
        providerCalls += 1;
        await providerGate;
        return jsonResponse(anthropicMessageFixture());
      }
      throw new Error(`unexpected call: ${url}`);
    },
    () =>
      withServer(config, async (baseUrl) => {
        const first = fetch(`${baseUrl}/api/v1/complete`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify(REQUEST_BODY),
        });
        // Give the first request's async chain a turn to reach (and hold)
        // the provider call before firing the second.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const second = await fetch(`${baseUrl}/api/v1/complete`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify(REQUEST_BODY),
        });
        assert.equal(second.status, 429);
        releaseProvider();
        const firstRes = await first;
        assert.equal(firstRes.status, 200);
      })
  );
  assert.equal(providerCalls, 1, "the capped second request must never reach the provider");
});

// ---------------------------------------------------------------------------
// /v1/stream
// ---------------------------------------------------------------------------

test("POST /v1/stream: happy path emits SSE text deltas and a done delta, and logs one core.llm_call row", async () => {
  const events = [
    {
      event: "message_start",
      data: { type: "message_start", message: anthropicMessageFixture({ content: [] }) },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null, stop_details: null },
        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens_details: null, server_tool_use: null },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  let logCalls = 0;
  await withPatchedFetch(
    async (input, init) => {
      const url = String(input);
      if (url.includes("is_platform_owner")) return jsonResponse(true);
      if (url.includes("rpc/log_llm_call")) {
        logCalls += 1;
        return jsonResponse({});
      }
      if (url.includes("anthropic.com")) return sseResponse(events);
      throw new Error(`unexpected call: ${url}`);
    },
    () =>
      withServer(CONFIG, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/v1/stream`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify(REQUEST_BODY),
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
        const text = await res.text();
        assert.match(text, /"kind":"text"/);
        assert.match(text, /"kind":"done"/);
      })
  );
  assert.equal(logCalls, 1);
});

// ---------------------------------------------------------------------------
// /v1/count
// ---------------------------------------------------------------------------

test("POST /v1/count returns a chars/4 token estimate with no provider call", async () => {
  let networkCalledBeyondAuth = false;
  await withPatchedFetch(
    async (input) => {
      const url = String(input);
      if (url.includes("is_platform_owner")) return jsonResponse(true);
      networkCalledBeyondAuth = true;
      return jsonResponse({});
    },
    () =>
      withServer(CONFIG, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/v1/count`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify({ model: "claude-fixture", messages: [{ role: "user", content: "12345678" }] }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { tokens: 2 });
      })
  );
  assert.equal(networkCalledBeyondAuth, false, "/v1/count must never make a provider or logging call");
});
