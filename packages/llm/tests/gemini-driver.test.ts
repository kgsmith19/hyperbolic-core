import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiDriver } from "../src/drivers/gemini.ts";
import { complete } from "../src/complete.ts";
import { isLlmError } from "../src/errors.ts";
import type { LlmDelta, LlmRequest } from "../src/types.ts";
import { collectStream, jsonResponse, pacedSseResponse as rawPacedSseResponse, sseLine, sseResponse as rawSseResponse, type SseOptions, withPatchedFetch } from "./driver-harness.ts";

// ---------------------------------------------------------------------------
// Gemini-specific wire fixtures. The transport plumbing (fetch patching,
// fake-clock stepping, SSE body construction) is shared -- see
// driver-harness.ts. Provider-agnostic behavior (auth refusal, error
// classification, connection failure) lives in driver-conformance.test.ts;
// this file covers only what is genuinely Gemini-shaped.
// ---------------------------------------------------------------------------

function fixtureGenerateContentResponse(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text: "hello there" }] }, finishReason: "STOP", index: 0 }],
    modelVersion: "gemini-fixture-resolved",
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 18, cachedContentTokenCount: 3 },
    ...overrides,
  };
}

/** Gemini's `alt=sse` format frames chunks as bare `data: {...}` and closes
 * when the body naturally ends -- no `[DONE]` sentinel the way OpenAI's has. */
function sseResponse(events: unknown[], opts: SseOptions = {}): Response {
  return rawSseResponse(events.map(sseLine), opts);
}

const BASE_REQUEST: LlmRequest = {
  provider: "google",
  model: "gemini-request-alias",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 256,
  metadata: { callerApp: "test-suite", purpose: "unit-test" },
  timeoutMs: 30_000,
};


// ---------------------------------------------------------------------------
// Zero key handling: defensive check, no network call
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Non-streaming: success, request mapping, response mapping
// ---------------------------------------------------------------------------

test("geminiDriver.complete: names the exact provider+model that answered (not the requested alias) and maps usage incl. cached tokens", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse(fixtureGenerateContentResponse()),
    () => geminiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.provider, "google");
  assert.equal(response.model, "gemini-fixture-resolved");
  assert.notEqual(response.model, BASE_REQUEST.model);
  assert.equal(response.text, "hello there");
  assert.deepEqual(response.toolCalls, []);
  assert.equal(response.stopReason, "end");
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
  assert.equal(typeof response.latencyMs, "number");
});

test("geminiDriver.complete: maps system/user/assistant/tool messages, tools, and toolChoice onto the wire request", async () => {
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
      return jsonResponse(fixtureGenerateContentResponse());
    },
    () => geminiDriver.complete(request, { apiKey: "fixture-key" }),
  );

  assert.ok(capturedBody);
  const systemInstruction = capturedBody?.systemInstruction as { parts: Array<{ text: string }> };
  assert.deepEqual(systemInstruction.parts, [{ text: "Be terse." }]);

  const contents = capturedBody?.contents as Array<Record<string, unknown>>;
  assert.equal(contents.length, 3); // system extracted out, not a contents turn
  assert.equal(contents[0]?.role, "user");
  assert.equal(contents[1]?.role, "model"); // our "assistant" maps onto Gemini's "model" role
  assert.deepEqual(contents[1]?.parts, [{ functionCall: { id: "call_1", name: "get_weather", args: { city: "Paris" } } }]);
  assert.equal(contents[2]?.role, "user"); // our "tool" role rides on Gemini's "user" role, same as Anthropic
  assert.deepEqual(contents[2]?.parts, [{ functionResponse: { id: "call_1", name: "get_weather", response: { output: "18C and sunny" } } }]);

  const tools = capturedBody?.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0]?.functionDeclarations, [{ name: "get_weather", description: "Look up current weather", parametersJsonSchema: { type: "object", properties: { city: { type: "string" } } } }]);

  assert.deepEqual(capturedBody?.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } });
});

test("geminiDriver.complete: recovers the required functionResponse.name via the toolUseId->name lookup even with multiple tool results", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
          { type: "tool_use", id: "call_2", name: "get_time", input: { city: "Paris" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolUseId: "call_2", content: "14:00" },
          { type: "tool_result", toolUseId: "call_1", content: "failed", isError: true },
        ],
      },
    ],
  };
  await withPatchedFetch(
    async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(fixtureGenerateContentResponse());
    },
    () => geminiDriver.complete(request, { apiKey: "fixture-key" }),
  );
  const contents = capturedBody?.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  const toolResultContent = contents[2];
  assert.deepEqual(toolResultContent?.parts, [
    { functionResponse: { id: "call_2", name: "get_time", response: { output: "14:00" } } },
    { functionResponse: { id: "call_1", name: "get_weather", response: { error: "failed" } } },
  ]);
});

test("geminiDriver.complete: parses functionCall parts into toolCalls and reports stopReason tool_use even though finishReason is STOP", async () => {
  const response = await withPatchedFetch(
    async () =>
      jsonResponse(
        fixtureGenerateContentResponse({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Let me check. " }, { functionCall: { id: "call_9", name: "get_weather", args: { city: "Tokyo" } } }] },
              finishReason: "STOP",
              index: 0,
            },
          ],
        }),
      ),
    () => geminiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "tool_use");
  assert.deepEqual(response.toolCalls, [{ id: "call_9", name: "get_weather", input: { city: "Tokyo" } }]);
  assert.equal(response.text, "Let me check. ");
});

test("geminiDriver.complete: a functionCall with no id is given a synthesized, non-empty id", async () => {
  const response = await withPatchedFetch(
    async () =>
      jsonResponse(
        fixtureGenerateContentResponse({
          candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "get_weather", args: {} } }] }, finishReason: "STOP", index: 0 }],
        }),
      ),
    () => geminiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.toolCalls.length, 1);
  assert.ok(response.toolCalls[0]?.id && response.toolCalls[0].id.length > 0);
});

test("geminiDriver.complete: a blocked prompt (promptFeedback.blockReason, no candidates) is a normal response naming stopReason refusal, not a thrown error", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } }),
    () => geminiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "refusal");
  assert.equal(response.text, null);
  assert.deepEqual(response.toolCalls, []);
});

test("geminiDriver.complete: a safety-blocked candidate (finishReason SAFETY, no tool calls) also maps to refusal", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse(fixtureGenerateContentResponse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY", index: 0 }] })),
    () => geminiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "refusal");
});

test("geminiDriver.complete: finishReason MAX_TOKENS maps to max_tokens", async () => {
  const response = await withPatchedFetch(
    async () => jsonResponse(fixtureGenerateContentResponse({ candidates: [{ content: { role: "model", parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS", index: 0 }] })),
    () => geminiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
  );
  assert.equal(response.stopReason, "max_tokens");
});

// ---------------------------------------------------------------------------
// Error taxonomy + retry, exercised through the real driver via complete()
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Finding #83: a local mapping/construction bug (a malformed message shape
// this driver cannot map onto the wire) must fail immediately, once, as a
// non-retryable error -- never retried MAX_RETRIES times as if it were
// transport noise, since it will fail identically on every retry.
// ---------------------------------------------------------------------------

test("geminiDriver.complete: a request whose message shape trips a local TypeError during construction fails immediately, before any network call, as a non-retryable invalid_request", async () => {
  // `content: null` on a tool-role message trips `m.content.map(...)` inside
  // toGeminiContents with a genuine local TypeError -- this driver is called
  // directly (bypassing complete()'s own assertValidMessageParts guard,
  // finding #81), the same way "rejects with no API key" above does, since
  // this fix must hold even for a caller that uses the driver standalone.
  let fetchCalls = 0;
  const malformedRequest: LlmRequest = {
    ...BASE_REQUEST,
    messages: [{ role: "tool", content: null }] as unknown as LlmRequest["messages"],
  };
  await withPatchedFetch(
    async () => {
      fetchCalls += 1;
      throw new Error("must not be called: construction must fail before any network attempt");
    },
    async () => {
      await assert.rejects(
        () => geminiDriver.complete(malformedRequest, { apiKey: "fixture-key" }),
        (error: unknown) => {
          assert.ok(isLlmError(error));
          assert.equal((error as { class: string }).class, "invalid_request");
          assert.equal((error as { retryable: boolean }).retryable, false);
          return true;
        },
      );
    },
  );
  assert.equal(fetchCalls, 0, "a local construction bug must never reach the network layer at all");
});

test("complete(): malformed tool_result content is rejected centrally before the Gemini driver is dispatched", async () => {
  // The central role/part guard now validates each part's payload as well as
  // its discriminator, so a bare number cannot reach provider-specific
  // request construction. The direct-driver test above still pins Gemini's
  // standalone defensive classification.
  let fetchCalls = 0;
  let driverCalls = 0;
  const countingGeminiDriver = {
    provider: "google" as const,
    complete: (request: LlmRequest, credentials: { apiKey: string }) => {
      driverCalls += 1;
      return geminiDriver.complete(request, credentials);
    },
    stream: geminiDriver.stream,
  };
  const malformedRequest: LlmRequest = {
    ...BASE_REQUEST,
    messages: [
      { role: "user", content: "go" },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "call_1", content: 42 as unknown as string }] },
    ],
  };

  const promise = withPatchedFetch(
    async () => {
      fetchCalls += 1;
      throw new Error("must not be called: construction must fail before any network attempt");
    },
    () => complete(malformedRequest, { gemini: { apiKey: "fixture-key" } }, { drivers: { gemini: countingGeminiDriver } }),
  );
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isLlmError(error));
    assert.equal(error.class, "invalid_request");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(driverCalls, 0, "central validation must reject before driver dispatch");
  assert.equal(fetchCalls, 0, "must never reach the network layer at all");
});

// ---------------------------------------------------------------------------
// Finding #84: a malformed 2xx response (no candidates, and not the
// documented blocked-prompt shape either) must not be silently accepted as
// an empty-but-valid success.
// ---------------------------------------------------------------------------

test("geminiDriver.complete: a response with no candidates and no promptFeedback.blockReason is a provider_bug, not a silent empty success", async () => {
  await withPatchedFetch(
    async () => jsonResponse({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } }),
    async () => {
      await assert.rejects(
        () => geminiDriver.complete(BASE_REQUEST, { apiKey: "fixture-key" }),
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

test("geminiDriver.stream: yields text and tool_call deltas, a usage delta, and a done delta naming provider+model (accumulating additive per-chunk content, not cumulative snapshots)", async () => {
  const chunks = [
    { candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] }, index: 0 }], modelVersion: "gemini-fixture-resolved" },
    { candidates: [{ content: { role: "model", parts: [{ text: "world" }] }, index: 0 }], modelVersion: "gemini-fixture-resolved" },
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_1", name: "get_weather", args: { city: "Paris" } } }] }, finishReason: "STOP", index: 0 }], modelVersion: "gemini-fixture-resolved" },
    { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, cachedContentTokenCount: 4 }, modelVersion: "gemini-fixture-resolved" },
  ];

  const deltas = await withPatchedFetch(
    async () => sseResponse(chunks),
    () => collectStream(geminiDriver.stream({ ...BASE_REQUEST, stream: true }, { apiKey: "fixture-key" })),
  );

  const textDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "text" }> => d.kind === "text");
  assert.deepEqual(
    textDeltas.map((d) => d.text),
    ["Hello ", "world"],
  );

  const toolDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "tool_call" }> => d.kind === "tool_call");
  assert.equal(toolDeltas.length, 1); // Gemini never streams partial function-call args
  assert.equal(toolDeltas[0]?.partial.id, "call_1");
  assert.equal(toolDeltas[0]?.partial.name, "get_weather");
  assert.equal(toolDeltas[0]?.partial.inputJsonDelta, '{"city":"Paris"}');

  const usageDeltas = deltas.filter((d): d is Extract<LlmDelta, { kind: "usage" }> => d.kind === "usage");
  assert.equal(usageDeltas.length, 1);
  assert.deepEqual(usageDeltas[0]?.usage, { inputTokens: 12, outputTokens: 8, cacheReadTokens: 4 });

  const done = deltas.find((d): d is Extract<LlmDelta, { kind: "done" }> => d.kind === "done");
  assert.ok(done);
  assert.equal(done?.response.provider, "google");
  assert.equal(done?.response.model, "gemini-fixture-resolved");
  assert.equal(done?.response.text, "Hello world");
  assert.equal(done?.response.stopReason, "tool_use");
  assert.deepEqual(done?.response.toolCalls, [{ id: "call_1", name: "get_weather", input: { city: "Paris" } }]);
  assert.equal(deltas.at(-1)?.kind, "done");
});

test("geminiDriver.stream: a naturally closed response with no candidate or block reason is provider_bug", async () => {
  await withPatchedFetch(
    async () =>
      sseResponse([
        {
          modelVersion: "gemini-fixture-resolved",
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
        },
      ]),
    async () => {
      await assert.rejects(
        () => collectStream(geminiDriver.stream({ ...BASE_REQUEST, stream: true }, { apiKey: "fixture-key" })),
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

test("geminiDriver.stream: aborts as transport when no delta arrives for 60 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const startChunk = { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, index: 0 }], modelVersion: "gemini-fixture-resolved" };

  const outcome = await withPatchedFetch(
    async (_input, init) => sseResponse([startChunk], { signal: init?.signal ?? undefined, holdOpen: true }),
    async () => {
      const gen = geminiDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
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
function pacedSseResponse(scheduled: Array<{ atMs: number; data: unknown }>, opts: SseOptions & { closeAfterMs?: number } = {}): Response {
  return rawPacedSseResponse(
    scheduled.map((item) => ({ atMs: item.atMs, chunk: sseLine(item.data) })),
    opts,
  );
}

/** A chunk carrying only a modelVersion heartbeat -- no candidates, no
 * usageMetadata -- a real, documented Gemini streaming shape. Nothing in
 * this driver's loop body yields for it: `chunk.usageMetadata` is absent,
 * `chunk.candidates?.[0]` is undefined so the loop `continue`s immediately. */
function keepaliveChunk(): unknown {
  return { modelVersion: "gemini-fixture-resolved" };
}

test("geminiDriver.stream: keepalive-only chunks (modelVersion heartbeat, no candidates or usageMetadata) do not prevent the 60s stall abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The opening chunk carries a candidate with an empty parts array -- also
  // a real shape (metadata-only candidate) that never enters the functionCall
  // / text branches, so it never yields either.
  const openingChunk = { candidates: [{ content: { role: "model", parts: [] }, index: 0 }], modelVersion: "gemini-fixture-resolved" };
  const scheduled = [
    { atMs: 0, data: openingChunk },
    { atMs: 20_000, data: keepaliveChunk() },
    { atMs: 40_000, data: keepaliveChunk() },
    { atMs: 60_000, data: keepaliveChunk() },
  ];

  const outcome = await withPatchedFetch(
    async (_input, init) => pacedSseResponse(scheduled, { signal: init?.signal ?? undefined }),
    async () => {
      const gen = geminiDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
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
      // the t=60s keepalive chunk.
      for (let i = 0; i < 75 && !settled; i++) {
        t.mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      return settled;
    },
  );

  assert.ok(outcome, "the stream must abort by ~60s despite periodic modelVersion-only chunks every 20s -- they carry no LlmDelta and must not reset the stall watchdog");
  assert.equal(outcome?.ok, false);
  const error = (outcome as { ok: false; error: unknown }).error;
  assert.ok(isLlmError(error));
  assert.equal((error as { class: string }).class, "transport");
  assert.equal((error as { retryable: boolean }).retryable, true);
});

test("geminiDriver.stream: real text deltas spaced within the 60s budget, with keepalive chunks interleaved, complete normally without spurious abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = [
    { atMs: 0, data: keepaliveChunk() },
    { atMs: 5_000, data: keepaliveChunk() },
    { atMs: 15_000, data: { candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] }, index: 0 }], modelVersion: "gemini-fixture-resolved" } },
    { atMs: 20_000, data: keepaliveChunk() },
    { atMs: 30_000, data: { candidates: [{ content: { role: "model", parts: [{ text: "world" }] }, index: 0 }], modelVersion: "gemini-fixture-resolved" } },
    { atMs: 35_000, data: keepaliveChunk() },
    { atMs: 40_000, data: { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, cachedContentTokenCount: 4 }, modelVersion: "gemini-fixture-resolved" } },
  ];

  const deltas = await withPatchedFetch(
    async () => pacedSseResponse(scheduled, { closeAfterMs: 41_000 }),
    async () => {
      const gen = geminiDriver.stream({ ...BASE_REQUEST, stream: true, timeoutMs: 120_000 }, { apiKey: "fixture-key" });
      const collectPromise = collectStream(gen);
      let result: LlmDelta[] | undefined;
      collectPromise.then((value) => (result = value));
      for (let i = 0; i < 50 && !result; i++) {
        t.mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(result, "stream should complete normally, not stall, despite keepalive chunks interleaved");
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
