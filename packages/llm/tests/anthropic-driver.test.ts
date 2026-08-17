import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicDriver } from "../src/drivers/anthropic.ts";
import { complete } from "../src/complete.ts";
import { isLlmError } from "../src/errors.ts";
import type { LlmDelta, LlmRequest } from "../src/types.ts";
import {
  collectStream,
  jsonResponse,
  pacedSseResponse as rawPacedSseResponse,
  sseResponse as rawSseResponse,
  tickInSteps,
  withPatchedFetch,
  type SseOptions,
} from "./driver-harness.ts";

// ---------------------------------------------------------------------------
// Anthropic-specific wire fixtures. The transport plumbing (fetch patching,
// fake-clock stepping, SSE body construction) is shared -- see
// driver-harness.ts. Provider-agnostic behavior (auth refusal, error
// classification, connection failure) lives in driver-conformance.test.ts;
// this file covers only what is genuinely Anthropic-shaped.
// ---------------------------------------------------------------------------

function anthropicErrorResponse(status: number, type: string, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ type: "error", error: { type, message }, request_id: "req_fixture" }, status, headers);
}

/** A minimal-but-complete non-streaming Message fixture. */
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

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Anthropic's SSE framing is `event: <name>\ndata: {...}`, and the body
 * simply ends -- there is no `[DONE]` sentinel the way OpenAI's has. */
function sseResponse(events: Array<{ event: string; data: unknown }>, opts: SseOptions = {}): Response {
  return rawSseResponse(
    events.map((e) => sseEvent(e.event, e.data)),
    opts,
  );
}

const BASE_REQUEST: LlmRequest = {
  provider: "anthropic",
  model: "claude-request-alias",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 256,
  metadata: { callerApp: "test-suite", purpose: "unit-test" },
  timeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Non-streaming: success, request mapping, response mapping
// ---------------------------------------------------------------------------

test("anthropicDriver.complete: names the exact provider+model that answered (not the requested alias) and maps usage incl. cache-read tokens", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse(fixtureMessage()),
    () => anthropicDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.provider, "anthropic");
  assert.equal(response.model, "claude-fixture-resolved");
  assert.notEqual(response.model, BASE_REQUEST.model);
  assert.equal(response.text, "hello there");
  assert.deepEqual(response.toolCalls, []);
  assert.equal(response.stopReason, "end");
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
  assert.equal(typeof response.latencyMs, "number");
});

test("anthropicDriver.complete: maps system/user/assistant/tool messages, tools, and toolChoice onto the wire request", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "What is the weather in Paris?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "toolu_1", content: "18C and sunny" }],
      },
    ],
    tools: [{ name: "get_weather", description: "Look up current weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
    toolChoice: { name: "get_weather" },
  };

  await withPatchedFetch(
    async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(fixtureMessage());
    },
    () => anthropicDriver.complete(request, { apiKey: "fixture-key" }),
  );

  assert.ok(capturedBody);
  assert.equal(capturedBody?.system, "Be terse.");
  assert.equal(capturedBody?.stream, false);
  const messages = capturedBody?.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 3); // system message extracted out, not a wire turn
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.role, "assistant");
  assert.deepEqual(messages[1]?.content, [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }]);
  assert.equal(messages[2]?.role, "user"); // our "tool" role rides on Anthropic's "user" role
  // JSON.stringify drops the `is_error: undefined` key entirely, so the
  // round-tripped wire body has no such key when the caller didn't set one.
  assert.deepEqual(messages[2]?.content, [{ type: "tool_result", tool_use_id: "toolu_1", content: "18C and sunny" }]);
  const tools = capturedBody?.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "get_weather");
  assert.deepEqual(tools[0]?.input_schema, { type: "object", properties: { city: { type: "string" } } });
  assert.deepEqual(capturedBody?.tool_choice, { type: "tool", name: "get_weather" });
});

test("anthropicDriver.complete: parses tool_use content blocks into toolCalls and reports stopReason tool_use", async () => {
  const response = await withPatchedFetch(
    async () =>
      jsonResponse(
        fixtureMessage({
          content: [
            { type: "text", text: "Let me check.", citations: null },
            { type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "Tokyo" }, caller: { type: "direct" } },
          ],
          stop_reason: "tool_use",
        }),
      ),
    () => anthropicDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "tool_use");
  assert.deepEqual(response.toolCalls, [{ id: "toolu_9", name: "get_weather", input: { city: "Tokyo" } }]);
  assert.equal(response.text, "Let me check.");
});

test("anthropicDriver.complete: a refusal is a normal response naming stopReason refusal, not a thrown error", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse(fixtureMessage({ content: [], stop_reason: "refusal" })),
    () => anthropicDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "refusal");
  assert.equal(response.text, null);
});

test("anthropicDriver.complete: a malformed successful response is a non-retryable provider_bug", async () => {
  await withPatchedFetch(
    async () => jsonResponse(fixtureMessage({ model: undefined })),
    async () => {
      await assert.rejects(
        () => anthropicDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
        (error: unknown) => {
          assert.ok(isLlmError(error));
          assert.equal(error.class, "provider_bug");
          assert.equal(error.retryable, false);
          return true;
        },
      );
    },
  );
});

// Round-2 independent review's finding (issue #186, NEW-6): a content
// array with a malformed entry (e.g. `null`) must raise provider_bug, not
// silently filter the entry out and report a normal-looking success -- a
// caller cannot tell "the completion was genuinely just empty" apart from
// "part of the response was silently dropped" if both look identical.
test("anthropicDriver.complete: a content array containing a malformed entry (null) is a provider_bug, never silently filtered into an emptier-looking success", async () => {
  await withPatchedFetch(
    async () => jsonResponse(fixtureMessage({ content: [null, { type: "text", text: "partial", citations: null }] })),
    async () => {
      await assert.rejects(
        () => anthropicDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
        (error: unknown) => {
          assert.ok(isLlmError(error));
          assert.equal(error.class, "provider_bug");
          return true;
        },
      );
    },
  );
});

test("complete(): honors a 429 retry-after header verbatim, not the computed backoff, then recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchCalls = 0;
  const result = await withPatchedFetch(
    async () => {
      fetchCalls += 1;
      if (fetchCalls < 3) {
        return anthropicErrorResponse(429, "rate_limit_error", "slow down", { "retry-after": "5" });
      }
      return jsonResponse(fixtureMessage());
    },
    async () => {
      const inner = complete(BASE_REQUEST, { anthropic: { apiKey: "fixture-key" } });
      let settled: { ok: boolean; value?: unknown } | undefined;
      inner.then(
        (value) => (settled = { ok: true, value }),
        () => (settled = { ok: false }),
      );

      // Small stepped ticks (with a flush after each) so the real SDK's own
      // internal promise chain -- resolving auth, building the request,
      // awaiting the fake fetch, parsing the error body -- gets as many
      // microtask turns as it needs between clock advances, the same way
      // the classification-cases test above drives it. Comfortably past
      // anything a computed backoff could produce (<= 2s) but comfortably
      // short of the 5s retry-after: proves it isn't using the computed
      // backoff.
      await tickInSteps(t, 3000, 100);
      assert.equal(fetchCalls, 1, "must not retry within the computed-backoff window");

      // Cross the 5s retry-after mark with margin.
      await tickInSteps(t, 4000, 100);
      assert.equal(fetchCalls, 2, "must retry per the 5s retry-after, not the ~0-2s computed backoff");

      // Second 429 carries its own 5s retry-after before the third (successful) attempt.
      await tickInSteps(t, 7000, 100);
      assert.equal(fetchCalls, 3);
      assert.equal(settled?.ok, true);
      return settled?.value;
    },
  );
  assert.ok(result);
});

// ---------------------------------------------------------------------------
// Streaming: success (text + tool_call deltas + usage + done), and the
// 60-second stall-aborts-as-transport case.
// ---------------------------------------------------------------------------

test("anthropicDriver.stream: yields text and tool_call deltas, a usage delta, and a done delta naming provider+model", async () => {
  const events = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: fixtureMessage({ content: [], usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, cache_creation: null, inference_geo: null } }),
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {}, caller: { type: "direct" } } },
    },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null, container: null, stop_details: null },
        usage: { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, output_tokens_details: null, server_tool_use: null },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];

  const deltas = await withPatchedFetch(
    async () => sseResponse(events),
    () => collectStream(anthropicDriver.stream({ ...BASE_REQUEST, stream: true }, { apiKey: "fixture-key" })),
  );

  const textDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "text" }> => d.kind === "text");
  assert.deepEqual(
    textDeltas.map((d) => d.text),
    ["Hello ", "world"],
  );

  const toolDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "tool_call" }> => d.kind === "tool_call");
  assert.equal(toolDeltas.length, 3); // one start (id+name) + two input_json_delta fragments
  assert.equal(toolDeltas[0]?.partial.id, "toolu_1");
  assert.equal(toolDeltas[0]?.partial.name, "get_weather");
  assert.equal(
    toolDeltas
      .slice(1)
      .map((d) => d.partial.inputJsonDelta)
      .join(""),
    '{"city":"Paris"}',
  );

  const usageDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "usage" }> => d.kind === "usage");
  assert.ok(usageDeltas.length >= 1);
  assert.deepEqual(usageDeltas.at(-1)?.usage, { inputTokens: 12, outputTokens: 8, cacheReadTokens: 4 });

  const done = deltas.find((d): d is Extract<LlmDelta, { kind: "done" }> => d.kind === "done");
  assert.ok(done);
  assert.equal(done?.response.provider, "anthropic");
  assert.equal(done?.response.model, "claude-fixture-resolved");
  assert.equal(done?.response.stopReason, "tool_use");
  assert.deepEqual(done?.response.toolCalls, [{ id: "toolu_1", name: "get_weather", input: { city: "Paris" } }]);
  assert.equal(deltas.at(-1)?.kind, "done"); // done is always last
});

test("anthropicDriver.stream: aborts as transport when no delta arrives for 60 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const startEvent = {
    event: "message_start",
    data: { type: "message_start", message: fixtureMessage({ content: [] }) },
  };

  const outcome = await withPatchedFetch(
    async (_input, init) => sseResponse([startEvent], { signal: init?.signal ?? undefined, holdOpen: true }),
    async () => {
      const gen = anthropicDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
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
  const error = (outcome as { ok: false; error: { class: string; retryable: boolean } }).error;
  assert.equal(error.class, "transport");
  assert.equal(error.retryable, true);
});

// ---------------------------------------------------------------------------
// Watchdog-reset-source regression: the stall clock must reset only on an
// actual LlmDelta yield, never on raw SSE transport activity. Unlike
// sseResponse (which enqueues every event synchronously at stream start,
// collapsing "reset on any event" and "reset on LlmDelta" into the same
// instant), pacedSseResponse schedules events at specific fake-clock offsets
// via setTimeout so the two behaviors are actually distinguishable.
// ---------------------------------------------------------------------------

/** Like sseResponse, but events are enqueued at scheduled fake-clock offsets
 * (via global setTimeout, driven by t.mock.timers) instead of all at once at
 * stream start. */
function pacedSseResponse(scheduled: Array<{ atMs: number; event: string; data: unknown }>, opts: SseOptions & { closeAfterMs?: number } = {}): Response {
  return rawPacedSseResponse(
    scheduled.map((item) => ({ atMs: item.atMs, chunk: sseEvent(item.event, item.data) })),
    opts,
  );
}

test("anthropicDriver.stream: keepalive-only transport activity (message_start + periodic no-op content_block_start events, no real content) does not prevent the 60s stall abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // message_start yields no LlmDelta (only sets local usage bookkeeping).
  // For the periodic "keepalive" events, a *text*-typed content_block_start
  // is used rather than Anthropic's own "ping" SSE event: reading the
  // installed SDK's core/streaming.ts confirms `ping` is filtered out by the
  // SDK's own raw SSE decoder (`if (sse.event === 'ping') continue;`) before
  // it ever reaches this driver's `for await` loop, so it can't distinguish
  // "resets on any transport event" from "resets on LlmDelta" -- both would
  // pass identically since neither driver ever even sees a ping. A
  // content_block_start for a plain text block *does* reach the loop (it is
  // accumulated into the SDK's message snapshot) but produces no `yield` in
  // this driver's switch (only a tool_use content_block_start does), so it
  // is genuine raw transport activity with zero LlmDelta -- exactly the
  // repro shape for this bug.
  const scheduled = [
    { atMs: 0, event: "message_start", data: { type: "message_start", message: fixtureMessage({ content: [] }) } },
    { atMs: 20_000, event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "", citations: null } } },
    { atMs: 40_000, event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "text", text: "", citations: null } } },
    { atMs: 60_000, event: "content_block_start", data: { type: "content_block_start", index: 3, content_block: { type: "text", text: "", citations: null } } },
  ];

  const outcome = await withPatchedFetch(
    async (_input, init) => pacedSseResponse(scheduled, { signal: init?.signal ?? undefined }),
    async () => {
      const gen = anthropicDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
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
      // on every raw event would next fire, since its last reset landed on
      // the t=60s content_block_start.
      for (let i = 0; i < 75 && !settled; i++) {
        t.mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      return settled;
    },
  );

  assert.ok(outcome, "the stream must abort by ~60s despite periodic no-op content_block_start events every 20s -- they carry no LlmDelta and must not reset the stall watchdog");
  assert.equal(outcome?.ok, false);
  const error = (outcome as { ok: false; error: { class: string; retryable: boolean } }).error;
  assert.equal(error.class, "transport");
  assert.equal(error.retryable, true);
});

test("anthropicDriver.stream: real text deltas spaced within the 60s budget, with keepalive no-op content_block_start events interleaved, complete normally without spurious abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = [
    { atMs: 0, event: "message_start", data: { type: "message_start", message: fixtureMessage({ content: [] }) } },
    { atMs: 5_000, event: "content_block_start", data: { type: "content_block_start", index: 98, content_block: { type: "text", text: "", citations: null } } },
    { atMs: 10_000, event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } } },
    { atMs: 15_000, event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } },
    { atMs: 20_000, event: "content_block_start", data: { type: "content_block_start", index: 97, content_block: { type: "text", text: "", citations: null } } },
    { atMs: 30_000, event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } } },
    { atMs: 35_000, event: "content_block_start", data: { type: "content_block_start", index: 96, content_block: { type: "text", text: "", citations: null } } },
    { atMs: 40_000, event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      atMs: 45_000,
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null, stop_details: null },
        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens_details: null, server_tool_use: null },
      },
    },
    { atMs: 45_500, event: "message_stop", data: { type: "message_stop" } },
  ];

  const deltas = await withPatchedFetch(
    async () => pacedSseResponse(scheduled, { closeAfterMs: 46_000 }),
    async () => {
      const gen = anthropicDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
      const collectPromise = collectStream(gen);
      let result: LlmDelta[] | undefined;
      collectPromise.then((value) => (result = value));
      for (let i = 0; i < 50 && !result; i++) {
        t.mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(result, "stream should complete normally, not stall, despite keepalive no-op content_block_start events interleaved");
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
