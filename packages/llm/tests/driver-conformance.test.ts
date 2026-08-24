// Cross-driver conformance suite: the behaviors every driver must implement
// identically, asserted once against a per-provider fixture record instead of
// being copy-pasted into all three driver test files.
//
// What belongs here: a behavior whose *assertions* are provider-independent
// and where only the wire fixture differs (auth refusal, error classification,
// raw connection failure). What does not: wire request/response mapping and
// streaming, which are genuinely different per provider and stay in
// <provider>-driver.test.ts.
//
// Extracting these also closed a real coverage gap -- the raw-connection-
// failure case existed only for OpenAI and Gemini, so the Anthropic driver's
// `fetch` rejecting outright had never been asserted to classify as a
// retryable transport error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicDriver } from "../src/drivers/anthropic.ts";
import { openaiDriver } from "../src/drivers/openai.ts";
import { geminiDriver } from "../src/drivers/gemini.ts";
import { complete } from "../src/complete.ts";
import { isLlmError } from "../src/errors.ts";
import { MAX_RETRIES } from "../src/retry.ts";
import type { LlmErrorClass, LlmRequest } from "../src/types.ts";
import type { LlmDriver } from "../src/drivers/types.ts";
import { jsonResponse, settleUnderFakeTimers, withPatchedFetch } from "./driver-harness.ts";

interface ClassificationCase {
  status: number;
  expectClass: LlmErrorClass;
  expectRetryable: boolean;
  /** Anthropic classifies on its wire `error.type`, not on status alone. */
  type?: string;
}

interface DriverContract {
  name: string;
  driver: LlmDriver;
  request: LlmRequest;
  /** Drives the retry/classification path through complete()'s registry. */
  run: () => Promise<unknown>;
  errorResponse: (testCase: ClassificationCase) => Response;
  classificationCases: ClassificationCase[];
}

function baseRequest(provider: LlmRequest["provider"], model: string): LlmRequest {
  return {
    provider,
    model,
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 256,
    metadata: { callerApp: "test-suite", purpose: "unit-test" },
    timeoutMs: 30_000,
  };
}

const ANTHROPIC_REQUEST = baseRequest("anthropic", "claude-request-alias");
const OPENAI_REQUEST = baseRequest("openai", "gpt-request-alias");
const GEMINI_REQUEST = baseRequest("google", "gemini-request-alias");

const CONTRACTS: DriverContract[] = [
  {
    name: "anthropic",
    driver: anthropicDriver,
    request: ANTHROPIC_REQUEST,
    run: () => complete(ANTHROPIC_REQUEST, { anthropic: { apiKey: "fixture-key" } }),
    errorResponse: (c) => jsonResponse({ type: "error", error: { type: c.type, message: `${c.type} fixture` }, request_id: "req_fixture" }, c.status),
    classificationCases: [
      { status: 400, type: "invalid_request_error", expectClass: "invalid_request", expectRetryable: false },
      { status: 401, type: "authentication_error", expectClass: "auth", expectRetryable: false },
      { status: 403, type: "permission_error", expectClass: "auth", expectRetryable: false },
      { status: 404, type: "not_found_error", expectClass: "invalid_request", expectRetryable: false },
      { status: 429, type: "rate_limit_error", expectClass: "rate_limit", expectRetryable: true },
      { status: 500, type: "api_error", expectClass: "transport", expectRetryable: true },
      { status: 529, type: "overloaded_error", expectClass: "overloaded", expectRetryable: true },
    ],
  },
  {
    name: "openai",
    driver: openaiDriver,
    request: OPENAI_REQUEST,
    run: () => complete(OPENAI_REQUEST, { openai: { apiKey: "fixture-key" } }, { drivers: { openai: openaiDriver } }),
    errorResponse: (c) => jsonResponse({ error: { message: `status ${c.status} fixture`, type: null, param: null, code: null } }, c.status),
    classificationCases: [
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
    ],
  },
  {
    name: "google",
    driver: geminiDriver,
    request: GEMINI_REQUEST,
    run: () => complete(GEMINI_REQUEST, { google: { apiKey: "fixture-key" } }, { drivers: { google: geminiDriver } }),
    errorResponse: (c) => jsonResponse({ error: { code: c.status, message: `status ${c.status} fixture`, status: "FIXTURE" } }, c.status),
    classificationCases: [
      { status: 400, expectClass: "invalid_request", expectRetryable: false },
      { status: 401, expectClass: "auth", expectRetryable: false },
      { status: 403, expectClass: "auth", expectRetryable: false },
      { status: 404, expectClass: "invalid_request", expectRetryable: false },
      // Regression test for a mutation-testing finding: this case was a real bug
      // fixed during m4-02's own review (classifyByStatus originally had no 408
      // branch at all, falling through to the >= 400 invalid_request bucket) but
      // shipped with no test proving the fix -- confirmed by mutating it back out
      // and observing the full suite stayed green. 408 is retry-worthy by HTTP
      // semantics and the installed SDK's own DEFAULT_RETRY_HTTP_STATUS_CODES
      // agrees (see classifyByStatus's own comment).
      { status: 408, expectClass: "transport", expectRetryable: true },
      { status: 429, expectClass: "rate_limit", expectRetryable: true },
      { status: 500, expectClass: "transport", expectRetryable: true },
      { status: 502, expectClass: "transport", expectRetryable: true },
      { status: 503, expectClass: "transport", expectRetryable: true },
      { status: 504, expectClass: "transport", expectRetryable: true },
    ],
  },
];

for (const contract of CONTRACTS) {
  test(`${contract.name}: complete() rejects with no API key before any network call`, async () => {
    let fetchCalls = 0;
    await withPatchedFetch(
      async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      },
      async () => {
        await assert.rejects(
          () => contract.driver.complete(contract.request, { apiKey: "" }),
          (error: { class: string }) => error.class === "invalid_request",
        );
      },
    );
    assert.equal(fetchCalls, 0);
  });

  // Attempt counts matching ours exactly (never more) also proves each SDK's
  // own internal retry is disabled: only our retry loop is counting.
  test(`${contract.name}: complete() classifies every documented error status and retries only the retryable classes exactly MAX_RETRIES times`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const testCase of contract.classificationCases) {
      let fetchCalls = 0;
      const label = `case ${testCase.status}`;
      const settled = await settleUnderFakeTimers(
        t,
        withPatchedFetch(async () => {
          fetchCalls += 1;
          return contract.errorResponse(testCase);
        }, contract.run),
        label,
      );
      assert.equal(settled.ok, false, `${label} should reject`);
      assert.ok(isLlmError(settled.error), `${label} must throw a genuinely typed LlmError`);
      assert.equal(settled.error?.class, testCase.expectClass, `${label} class`);
      assert.equal(settled.error?.retryable, testCase.expectRetryable, `${label} retryable`);
      assert.equal(fetchCalls, testCase.expectRetryable ? MAX_RETRIES + 1 : 1, `${label} attempt count`);
    }
  });

  // No SDK exposes a uniform connection-error type, so this pins down each
  // driver's own default for a fetch that never produced a response at all.
  test(`${contract.name}: complete() classifies a raw connection failure (fetch rejects) as transport and retries`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fetchCalls = 0;
    const settled = await settleUnderFakeTimers(
      t,
      withPatchedFetch(async () => {
        fetchCalls += 1;
        throw new TypeError("fetch failed");
      }, contract.run),
    );
    assert.equal(settled.ok, false);
    assert.ok(isLlmError(settled.error));
    assert.equal(settled.error?.class, "transport");
    assert.equal(settled.error?.retryable, true);
    assert.equal(fetchCalls, MAX_RETRIES + 1);
  });
}
