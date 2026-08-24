import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, stream } from "../src/complete.ts";
import type { LlmRequest, Message } from "../src/types.ts";
import { fakeDriver, fixtureResponse } from "./driver-harness.ts";

/**
 * Finding #81: complete.ts's assertValidMessageParts is the one central
 * guard, run before any driver is ever dispatched, that rejects a message
 * whose parts don't belong to its role -- e.g. a ToolResultPart on a
 * UserMessage/AssistantMessage, which the three drivers used to handle
 * divergently and silently (openai.ts filtered it out, gemini.ts blanked
 * the whole turn to `{text: ""}`, anthropic.ts routed it through
 * unconditionally). Same fakeDriver idiom as fallback.test.ts: no real
 * network call happens in this file, and `driver.calls` proves whether
 * dispatch was ever reached.
 */

const BASE_REQUEST: LlmRequest = {
  provider: "anthropic",
  model: "primary-model",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 128,
  metadata: { callerApp: "test-suite", purpose: "unit-test" },
  timeoutMs: 5000,
};

const CREDENTIALS = { anthropic: { apiKey: "key" }, openai: { apiKey: "key" }, gemini: { apiKey: "key" } };

/** Builds a deliberately malformed Message -- the exact kind of
 * untyped/JSON-built payload that can bypass types.ts's UserContentPart /
 * AssistantContentPart narrowing entirely (finding #81's own motivation for
 * a *runtime* guard, not just a type-level one). */
function malformedMessage(shape: unknown): Message {
  return shape as Message;
}

// ---------------------------------------------------------------------------
// Rejected: parts that don't belong on their role
// ---------------------------------------------------------------------------

test("complete(): a ToolResultPart on a UserMessage is rejected as invalid_request before any driver is dispatched", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [malformedMessage({ role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "x" }] })],
  };
  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: primary } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0, "the driver must never be dispatched for a malformed request");
});

test("complete(): a ToolResultPart on an AssistantMessage is rejected as invalid_request before any driver is dispatched", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [
      { role: "user", content: "go" },
      malformedMessage({ role: "assistant", content: [{ type: "tool_result", toolUseId: "call_1", content: "x" }] }),
    ],
  };
  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: primary } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0);
});

test("complete(): a ToolUsePart on a UserMessage is rejected as invalid_request (tool_use is assistant-issued, never user-authored)", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [malformedMessage({ role: "user", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: {} }] })],
  };
  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: primary } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0);
});

test("complete(): a text part on a ToolMessage (wrong part type for the tool role) is rejected as invalid_request", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [{ role: "user", content: "go" }, malformedMessage({ role: "tool", content: [{ type: "text", text: "not a tool result" }] })],
  };
  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: primary } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0);
});

test("complete(): a non-array, non-string content (e.g. null) fails as a clean invalid_request, not a raw TypeError", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [malformedMessage({ role: "assistant", content: null })],
  };
  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: primary } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0);
});

test("stream(): a ToolResultPart on a UserMessage is rejected as invalid_request before the primary stream is dispatched", async () => {
  const primary = fakeDriver("anthropic", {
    async *stream() {
      throw new Error("must never be called");
    },
  });
  const request: LlmRequest = {
    ...BASE_REQUEST,
    messages: [malformedMessage({ role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "x" }] })],
  };
  await assert.rejects(async () => {
    for await (const _delta of stream(request, CREDENTIALS, { drivers: { anthropic: primary } })) {
      // never reached
    }
  }, (error: { class: string }) => error.class === "invalid_request");
  assert.equal(primary.calls, 0);
});

test("complete(): malformed system/tool roles and unknown roles are rejected before dispatch", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const malformedCases = [
    { role: "system", content: [{ type: "text", text: "system content must be a string" }] },
    { role: "tool", content: "tool content must be structured" },
    { role: "unknown", content: "unsupported role" },
  ];

  for (const message of malformedCases) {
    await assert.rejects(
      () => complete({ ...BASE_REQUEST, messages: [malformedMessage(message)] }, CREDENTIALS, { drivers: { anthropic: primary } }),
      (error: { class: string }) => error.class === "invalid_request",
    );
  }
  assert.equal(primary.calls, 0);
});

test("complete(): malformed part payloads are rejected before dispatch", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const malformedCases = [
    { role: "user", content: [{ type: "text" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", input: {} }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: undefined }] },
    { role: "tool", content: [{ type: "tool_result", toolUseId: 1, content: "result" }] },
    { role: "tool", content: [{ type: "tool_result", toolUseId: "call_1", content: [{ type: "text" }] }] },
  ];

  for (const message of malformedCases) {
    await assert.rejects(
      () => complete({ ...BASE_REQUEST, messages: [malformedMessage(message)] }, CREDENTIALS, { drivers: { anthropic: primary } }),
      (error: { class: string }) => error.class === "invalid_request",
    );
  }
  assert.equal(primary.calls, 0);
});

test("complete(): a non-array messages value is a typed invalid_request before dispatch", async () => {
  const primary = fakeDriver("anthropic", { complete: async () => fixtureResponse("anthropic", "primary-model") });
  const request = { ...BASE_REQUEST, messages: null } as unknown as LlmRequest;
  await assert.rejects(
    () => complete(request, CREDENTIALS, { drivers: { anthropic: primary } }),
    (error: { class: string }) => error.class === "invalid_request",
  );
  assert.equal(primary.calls, 0);
});

// ---------------------------------------------------------------------------
// Positive control: every legal role/part combination, across all three
// providers, is accepted normally and actually reaches the driver. (No
// fast-check/property-testing dependency exists in this package's
// package.json, so this is a hand-written matrix rather than a generated
// one -- matching this package's own established convention.)
// ---------------------------------------------------------------------------

const VALID_MESSAGE_CASES: Array<{ name: string; messages: Message[] }> = [
  { name: "user: plain string content", messages: [{ role: "user", content: "hello" }] },
  { name: "user: array of a single text part", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
  {
    name: "user: array of multiple text parts",
    messages: [{ role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] }],
  },
  { name: "assistant: plain string content", messages: [{ role: "user", content: "go" }, { role: "assistant", content: "ok" }] },
  {
    name: "assistant: array of a single text part",
    messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: "ok" }] }],
  },
  {
    name: "assistant: array of a single tool_use part",
    messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: {} }] }],
  },
  {
    name: "assistant: mixed text + tool_use parts",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "checking..." }, { type: "tool_use", id: "call_1", name: "get_weather", input: {} }] },
    ],
  },
  {
    name: "tool: a single tool_result part",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "call_1", content: "sunny" }] },
    ],
  },
  {
    name: "tool: multiple tool_result parts",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "a", input: {} }, { type: "tool_use", id: "call_2", name: "b", input: {} }] },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolUseId: "call_1", content: "one" },
          { type: "tool_result", toolUseId: "call_2", content: "two", isError: true },
        ],
      },
    ],
  },
  {
    name: "system message alongside user/assistant/tool turns",
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "call_1", content: "sunny" }] },
    ],
  },
];

for (const provider of ["anthropic", "openai", "google"] as const) {
  for (const testCase of VALID_MESSAGE_CASES) {
    test(`complete(): ${provider} accepts a well-formed request (${testCase.name}) and actually dispatches to the driver`, async () => {
      const driver = fakeDriver(provider, { complete: async (request) => fixtureResponse(provider, request.model) });
      const request: LlmRequest = { ...BASE_REQUEST, provider, model: "m", messages: testCase.messages };
      const response = await complete(request, CREDENTIALS, { drivers: { [provider]: driver } });
      assert.equal(driver.calls, 1, `${provider}/${testCase.name} should have reached the driver`);
      assert.equal(response.provider, provider);
    });
  }
}
