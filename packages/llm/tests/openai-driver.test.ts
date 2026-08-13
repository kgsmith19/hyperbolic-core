import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiDriver } from "../src/drivers/openai.ts";
import { complete } from "../src/complete.ts";
import { MAX_RETRIES } from "../src/retry.ts";
import { isLlmError } from "../src/errors.ts";
import type { LlmDelta, LlmErrorClass, LlmRequest } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures and fake-transport helpers. Same idiom as anthropic-driver.test.ts:
// no real network call happens in this file -- every test patches
// globalThis.fetch for its duration and lets the real `openai` SDK run
// against that fake transport.
// ---------------------------------------------------------------------------

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function tickInSteps(t: { mock: { timers: { tick(ms: number): void } } }, totalMs: number, stepMs = 250): Promise<void> {
  for (let advanced = 0; advanced < totalMs; advanced += stepMs) {
    t.mock.timers.tick(Math.min(stepMs, totalMs - advanced));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

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

/** OpenAI's wire error shape: {"error": {"message", "type", "param", "code"}}. */
function openaiErrorResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: { message, type: null, param: null, code: null } }, status, headers);
}

function fixtureChatCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_fixture",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "gpt-fixture-resolved",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: "hello there", refusal: null },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } },
    ...overrides,
  };
}

function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Builds a fake SSE Response for Chat Completions' `data: {...}\n\n` /
 * `data: [DONE]\n\n` framing. When `holdOpen` is true the stream is left
 * open after emitting `events` and only terminates when the caller's
 * AbortSignal fires -- same idiom as anthropic-driver.test.ts's sseResponse. */
function sseResponse(events: unknown[], opts: { signal?: AbortSignal | null; holdOpen?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(sseLine(e)));
      }
      if (!opts.holdOpen) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const signal = opts.signal;
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
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const BASE_REQUEST: LlmRequest = {
  provider: "openai",
  model: "gpt-request-alias",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 256,
  metadata: { callerApp: "test-suite", purpose: "unit-test" },
  timeoutMs: 30_000,
};

async function collectStream(gen: AsyncGenerator<LlmDelta, void, unknown>): Promise<LlmDelta[]> {
  const collected: LlmDelta[] = [];
  for await (const delta of gen) {
    collected.push(delta);
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Zero key handling: defensive check, no network call
// ---------------------------------------------------------------------------

test("openaiDriver.complete: rejects with no API key before any network call", async () => {
  let fetchCalls = 0;
  await withPatchedFetch(
    async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
    async () => {
      await assert.rejects(
        () => openaiDriver.complete(BASE_REQUEST, { apiKey: "" }),
        (error: { class: string }) => error.class === "invalid_request",
      );
    },
  );
  assert.equal(fetchCalls, 0);
});

// ---------------------------------------------------------------------------
// Non-streaming: success, request mapping, response mapping
// ---------------------------------------------------------------------------

test("openaiDriver.complete: names the exact provider+model that answered (not the requested alias) and maps usage incl. cached tokens", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse(fixtureChatCompletion()),
    () => openaiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.provider, "openai");
  assert.equal(response.model, "gpt-fixture-resolved");
  assert.notEqual(response.model, BASE_REQUEST.model);
  assert.equal(response.text, "hello there");
  assert.deepEqual(response.toolCalls, []);
  assert.equal(response.stopReason, "end");
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
  assert.equal(typeof response.latencyMs, "number");
});

test("openaiDriver.complete: maps system/user/assistant/tool messages, tools, and toolChoice onto the wire request", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "What is the weather in Paris?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "call_1", content: "18C and sunny" }],
      },
    ],
    tools: [{ name: "get_weather", description: "Look up current weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
    toolChoice: { name: "get_weather" },
  };

  await withPatchedFetch(
    async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(fixtureChatCompletion());
    },
    () => openaiDriver.complete(request, { apiKey: "fixture-key" }),
  );

  assert.ok(capturedBody);
  assert.equal(capturedBody?.stream, false);
  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 4); // system stays its own turn (unlike Anthropic, which extracts it out)
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "Be terse.");
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[2]?.role, "assistant");
  assert.deepEqual(messages[2]?.tool_calls, [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }]);
  assert.equal(messages[3]?.role, "tool"); // our "tool" role maps onto OpenAI's own distinct "tool" role
  assert.equal(messages[3]?.tool_call_id, "call_1");
  assert.equal(messages[3]?.content, "18C and sunny");
  const tools = capturedBody?.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0], { type: "function", function: { name: "get_weather", description: "Look up current weather", parameters: { type: "object", properties: { city: { type: "string" } } } } });
  assert.deepEqual(capturedBody?.tool_choice, { type: "function", function: { name: "get_weather" } });
});

test("openaiDriver.complete: splits a tool-role message with multiple ToolResultParts into separate wire tool messages", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [
      { role: "user", content: "go" },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolUseId: "call_1", content: "result one" },
          { type: "tool_result", toolUseId: "call_2", content: "result two", isError: true },
        ],
      },
    ],
  };
  await withPatchedFetch(
    async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(fixtureChatCompletion());
    },
    () => openaiDriver.complete(request, { apiKey: "fixture-key" }),
  );
  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 3);
  assert.deepEqual(
    messages.slice(1).map((m) => ({ role: m.role, tool_call_id: m.tool_call_id, content: m.content })),
    [
      { role: "tool", tool_call_id: "call_1", content: "result one" },
      { role: "tool", tool_call_id: "call_2", content: "result two" },
    ],
  );
});

test("openaiDriver.complete: parses tool_calls into toolCalls (JSON-decoding the wire's string arguments) and reports stopReason tool_use", async () => {
  const response = await withPatchedFetch(
    async () =>
      jsonResponse(
        fixtureChatCompletion({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              logprobs: null,
              message: {
                role: "assistant",
                content: null,
                refusal: null,
                tool_calls: [{ id: "call_9", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
              },
            },
          ],
        }),
      ),
    () => openaiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "tool_use");
  assert.deepEqual(response.toolCalls, [{ id: "call_9", name: "get_weather", input: { city: "Tokyo" } }]);
  assert.equal(response.text, null);
});

test("openaiDriver.complete: a tool call with an empty wire id is given a synthesized, non-empty id", async () => {
  const response = await withPatchedFetch(
    async () =>
      jsonResponse(
        fixtureChatCompletion({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              logprobs: null,
              message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
            },
          ],
        }),
      ),
    () => openaiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.toolCalls.length, 1);
  assert.ok(response.toolCalls[0]?.id && response.toolCalls[0].id.length > 0);
});

test("openaiDriver.complete: a refusal (message.refusal) is a normal response naming stopReason refusal, not a thrown error", async () => {
  const response = await withPatchedFetch(
    async () =>
      jsonResponse(
        fixtureChatCompletion({
          choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: null, refusal: "I can't help with that." } }],
        }),
      ),
    () => openaiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "refusal");
  assert.equal(response.text, "I can't help with that.");
});

test("openaiDriver.complete: finish_reason content_filter is also a normal refusal response", async () => {
  const response = await withPatchedFetch(
    async () =>
      jsonResponse(
        fixtureChatCompletion({
          choices: [{ index: 0, finish_reason: "content_filter", logprobs: null, message: { role: "assistant", content: null, refusal: null } }],
        }),
      ),
    () => openaiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "refusal");
});

test("openaiDriver.complete: finish_reason length maps to max_tokens", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse(fixtureChatCompletion({ choices: [{ index: 0, finish_reason: "length", logprobs: null, message: { role: "assistant", content: "partial", refusal: null } }] })),
    () => openaiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "max_tokens");
});

// ---------------------------------------------------------------------------
// Error taxonomy + retry, exercised through the real driver via complete()
// ---------------------------------------------------------------------------

const CLASSIFICATION_CASES: Array<{ status: number; expectClass: LlmErrorClass; expectRetryable: boolean }> = [
  { status: 400, expectClass: "invalid_request", expectRetryable: false },
  { status: 401, expectClass: "auth", expectRetryable: false },
  { status: 403, expectClass: "auth", expectRetryable: false },
  { status: 404, expectClass: "invalid_request", expectRetryable: false },
  { status: 409, expectClass: "invalid_request", expectRetryable: false },
  { status: 422, expectClass: "invalid_request", expectRetryable: false },
  { status: 429, expectClass: "rate_limit", expectRetryable: true },
  { status: 500, expectClass: "transport", expectRetryable: true },
  // No SDK-named subclass exists for 402/408: falls through to the generic
  // OpenAI.APIError branch's status-based classification.
  { status: 402, expectClass: "invalid_request", expectRetryable: false },
  { status: 408, expectClass: "transport", expectRetryable: true },
];

test("complete(): classifies every documented OpenAI error status and retries only the retryable classes exactly MAX_RETRIES times", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const testCase of CLASSIFICATION_CASES) {
    let fetchCalls = 0;
    const promise = withPatchedFetch(
      async () => {
        fetchCalls += 1;
        return openaiErrorResponse(testCase.status, `status ${testCase.status} fixture`);
      },
      () => complete(BASE_REQUEST, { openai: { apiKey: "fixture-key" } }, { drivers: { openai: openaiDriver } }),
    );
    let settled: { ok: boolean; error?: { class: string; retryable: boolean } } | undefined;
    promise.then(
      () => (settled = { ok: true }),
      (error) => (settled = { ok: false, error }),
    );
    for (let i = 0; i < 20 && !settled; i++) {
      t.mock.timers.tick(1000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await promise.catch(() => undefined);
    assert.ok(settled, `case ${testCase.status} never settled`);
    assert.equal(settled?.ok, false, `case ${testCase.status} should reject`);
    assert.ok(isLlmError(settled?.error), `case ${testCase.status} must throw a genuinely typed LlmError`);
    assert.equal(settled?.error?.class, testCase.expectClass, `case ${testCase.status} class`);
    assert.equal(settled?.error?.retryable, testCase.expectRetryable, `case ${testCase.status} retryable`);
    assert.equal(fetchCalls, testCase.expectRetryable ? MAX_RETRIES + 1 : 1, `case ${testCase.status} attempt count`);
  }
});

test("complete(): a raw connection failure (fetch rejects) classifies as transport and retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchCalls = 0;
  const promise = withPatchedFetch(
    async () => {
      fetchCalls += 1;
      throw new TypeError("fetch failed");
    },
    () => complete(BASE_REQUEST, { openai: { apiKey: "fixture-key" } }, { drivers: { openai: openaiDriver } }),
  );
  let settled: { ok: boolean; error?: { class: string; retryable: boolean } } | undefined;
  promise.then(
    () => (settled = { ok: true }),
    (error) => (settled = { ok: false, error }),
  );
  for (let i = 0; i < 20 && !settled; i++) {
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await promise.catch(() => undefined);
  assert.equal(settled?.ok, false);
  assert.ok(isLlmError(settled?.error));
  assert.equal(settled?.error?.class, "transport");
  assert.equal(settled?.error?.retryable, true);
  assert.equal(fetchCalls, MAX_RETRIES + 1);
});

test("complete(): honors a 429 retry-after header verbatim, not the computed backoff, then recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchCalls = 0;
  const result = await withPatchedFetch(
    async () => {
      fetchCalls += 1;
      if (fetchCalls < 3) {
        return openaiErrorResponse(429, "slow down", { "retry-after": "5" });
      }
      return jsonResponse(fixtureChatCompletion());
    },
    async () => {
      const inner = complete(BASE_REQUEST, { openai: { apiKey: "fixture-key" } }, { drivers: { openai: openaiDriver } });
      let settled: { ok: boolean; value?: unknown } | undefined;
      inner.then(
        (value) => (settled = { ok: true, value }),
        () => (settled = { ok: false }),
      );
      await tickInSteps(t, 3000, 100);
      assert.equal(fetchCalls, 1, "must not retry within the computed-backoff window");
      await tickInSteps(t, 4000, 100);
      assert.equal(fetchCalls, 2, "must retry per the 5s retry-after, not the ~0-2s computed backoff");
      await tickInSteps(t, 7000, 100);
      assert.equal(fetchCalls, 3);
      assert.equal(settled?.ok, true);
      return settled?.value;
    },
  );
  assert.ok(result);
});

test("openaiDriver.complete: malformed tool-call JSON arguments surface as a genuinely typed provider_bug LlmError, not a bare SyntaxError", async () => {
  await withPatchedFetch(
    async () =>
      jsonResponse(
        fixtureChatCompletion({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              logprobs: null,
              message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{not valid json" } }] },
            },
          ],
        }),
      ),
    async () => {
      await assert.rejects(
        () => openaiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
        (error: unknown) => {
          assert.ok(isLlmError(error));
          assert.equal((error as { class: string }).class, "provider_bug");
          assert.equal((error as { retryable: boolean }).retryable, false);
          return true;
        },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Streaming: success (text + tool_call deltas + usage + done), and the
// 60-second stall-aborts-as-transport case.
// ---------------------------------------------------------------------------

test("openaiDriver.stream: yields text and tool_call deltas, a usage delta, and a done delta naming provider+model", async () => {
  const chunks = [
    { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved", choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] },
    { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved", choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] },
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-fixture-resolved",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }],
    },
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-fixture-resolved",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }],
    },
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-fixture-resolved",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }],
    },
    { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved", choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 4 } } },
  ];

  const deltas = await withPatchedFetch(
    async () => sseResponse(chunks),
    () => collectStream(openaiDriver.stream({ ...BASE_REQUEST, stream: true }, { apiKey: "fixture-key" })),
  );

  const textDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "text" }> => d.kind === "text");
  assert.deepEqual(
    textDeltas.map((d) => d.text),
    ["Hello ", "world"],
  );

  const toolDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "tool_call" }> => d.kind === "tool_call");
  assert.equal(toolDeltas.length, 3);
  assert.equal(toolDeltas[0]?.partial.id, "call_1");
  assert.equal(toolDeltas[0]?.partial.name, "get_weather");
  assert.equal(
    toolDeltas.map((d) => d.partial.inputJsonDelta ?? "").join(""),
    '{"city":"Paris"}',
  );

  const usageDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "usage" }> => d.kind === "usage");
  assert.equal(usageDeltas.length, 1);
  assert.deepEqual(usageDeltas[0]?.usage, { inputTokens: 12, outputTokens: 8, cacheReadTokens: 4 });

  const done = deltas.find((d): d is Extract<LlmDelta, { kind: "done" }> => d.kind === "done");
  assert.ok(done);
  assert.equal(done?.response.provider, "openai");
  assert.equal(done?.response.model, "gpt-fixture-resolved");
  assert.equal(done?.response.stopReason, "tool_use");
  assert.deepEqual(done?.response.toolCalls, [{ id: "call_1", name: "get_weather", input: { city: "Paris" } }]);
  assert.equal(deltas.at(-1)?.kind, "done");
});

test("openaiDriver.stream: aborts as transport when no delta arrives for 60 seconds (the SDK's raw Stream swallows this abort; the higher-level runner used by this driver must not)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const startChunk = { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };

  const outcome = await withPatchedFetch(
    async (_input, init) => sseResponse([startChunk], { signal: init?.signal ?? undefined, holdOpen: true }),
    async () => {
      const gen = openaiDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
      const drain = (async () => {
        try {
          for await (const _delta of gen) {
            // draining only; the stall happens before any further delta.
          }
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      })();

      let settled: Awaited<typeof drain> | undefined;
      drain.then((value) => (settled = value));

      for (let i = 0; i < 65 && !settled; i++) {
        t.mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      return settled;
    },
  );

  assert.ok(outcome, "the stream must have aborted by 65s of fake time");
  assert.equal(outcome?.ok, false);
  const error = (outcome as { ok: false; error: unknown }).error;
  assert.ok(isLlmError(error));
  assert.equal((error as { class: string }).class, "transport");
  assert.equal((error as { retryable: boolean }).retryable, true);
});

// ---------------------------------------------------------------------------
// Watchdog-reset-source regression: the stall clock must reset only on an
// actual LlmDelta yield, never on raw chunk transport activity. Unlike
// sseResponse (which enqueues every chunk synchronously at stream start,
// collapsing "reset on any chunk" and "reset on LlmDelta" into the same
// instant), pacedSseResponse schedules chunks at specific fake-clock offsets
// via setTimeout so the two behaviors are actually distinguishable.
// ---------------------------------------------------------------------------

/** Like sseResponse, but chunks are enqueued at scheduled fake-clock offsets
 * (via global setTimeout, driven by t.mock.timers) instead of all at once at
 * stream start. */
function pacedSseResponse(scheduled: Array<{ atMs: number; data: unknown }>, opts: { signal?: AbortSignal | null; closeAfterMs?: number } = {}): Response {
  const encoder = new TextEncoder();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of scheduled) {
        timers.push(
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode(sseLine(item.data)));
            } catch {
              // stream already closed/errored -- nothing left to enqueue into.
            }
          }, item.atMs),
        );
      }
      if (opts.closeAfterMs !== undefined) {
        timers.push(
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch {
              // already closed/errored
            }
          }, opts.closeAfterMs),
        );
      }
      const signal = opts.signal;
      if (!signal) {
        return; // no close scheduled and no signal: held open until the test ends
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
    },
    cancel() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A chunk carrying no content, no tool_calls, and no usage -- a real,
 * documented OpenAI streaming shape (empty/role-only "heartbeat" chunks) --
 * so `delta?.content` is falsy, `delta?.tool_calls` is absent, and
 * `chunk.usage` is absent: nothing in this driver's loop body yields for it. */
function emptyDeltaChunk(): unknown {
  return { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved", choices: [{ index: 0, delta: {}, finish_reason: null }] };
}

test("openaiDriver.stream: keepalive-only chunks (role-only / empty delta, no content, tool_calls, or usage) do not prevent the 60s stall abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const roleOnlyChunk = { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };
  const scheduled = [
    { atMs: 0, data: roleOnlyChunk },
    { atMs: 20_000, data: emptyDeltaChunk() },
    { atMs: 40_000, data: emptyDeltaChunk() },
    { atMs: 60_000, data: emptyDeltaChunk() },
  ];

  const outcome = await withPatchedFetch(
    async (_input, init) => pacedSseResponse(scheduled, { signal: init?.signal ?? undefined }),
    async () => {
      const gen = openaiDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
      const drain = (async () => {
        try {
          for await (const _delta of gen) {
            // draining only; no real content is ever yielded in this fixture.
          }
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      })();

      let settled: Awaited<typeof drain> | undefined;
      drain.then((value) => (settled = value));

      // 75s comfortably clears the true 60s stall threshold but stays well
      // short of 120s -- the point at which a driver that (buggily) resets
      // on every raw chunk would next fire, since its last reset landed on
      // the t=60s empty-delta chunk.
      for (let i = 0; i < 75 && !settled; i++) {
        t.mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      return settled;
    },
  );

  assert.ok(outcome, "the stream must abort by ~60s despite periodic empty-delta chunks every 20s -- they carry no LlmDelta and must not reset the stall watchdog");
  assert.equal(outcome?.ok, false);
  const error = (outcome as { ok: false; error: unknown }).error;
  assert.ok(isLlmError(error));
  assert.equal((error as { class: string }).class, "transport");
  assert.equal((error as { retryable: boolean }).retryable, true);
});

test("openaiDriver.stream: real text deltas spaced within the 60s budget, with keepalive empty-delta chunks interleaved, complete normally without spurious abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const base = { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_700_000_000, model: "gpt-fixture-resolved" };
  const scheduled = [
    { atMs: 0, data: { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] } },
    { atMs: 5_000, data: emptyDeltaChunk() },
    { atMs: 15_000, data: { ...base, choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] } },
    { atMs: 20_000, data: emptyDeltaChunk() },
    { atMs: 30_000, data: { ...base, choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] } },
    { atMs: 35_000, data: emptyDeltaChunk() },
    { atMs: 40_000, data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
    { atMs: 40_500, data: { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 4 } } } },
  ];

  const deltas = await withPatchedFetch(
    async () => pacedSseResponse(scheduled, { closeAfterMs: 41_000 }),
    async () => {
      const gen = openaiDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
      const collectPromise = collectStream(gen);
      let result: LlmDelta[] | undefined;
      collectPromise.then((value) => (result = value));
      for (let i = 0; i < 50 && !result; i++) {
        t.mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(result, "stream should complete normally, not stall, despite keepalive empty-delta chunks interleaved");
      return result;
    },
  );

  const textDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "text" }> => d.kind === "text");
  assert.deepEqual(
    textDeltas.map((d) => d.text),
    ["Hello ", "world"],
  );
  assert.equal(deltas.at(-1)?.kind, "done");
});
