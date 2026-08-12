import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmError, isLlmError } from "../src/errors.ts";
import type { LlmErrorClass } from "../src/types.ts";

const RETRYABLE: LlmErrorClass[] = ["rate_limit", "overloaded", "transport"];
const NOT_RETRYABLE: LlmErrorClass[] = ["auth", "invalid_request", "content_policy", "provider_bug"];

test("createLlmError: retryable is derived from class, never independently settable -- exactly the three named classes are retryable", () => {
  for (const errClass of RETRYABLE) {
    const error = createLlmError(errClass, "boom");
    assert.equal(error.retryable, true, `${errClass} must be retryable`);
  }
  for (const errClass of NOT_RETRYABLE) {
    const error = createLlmError(errClass, "boom");
    assert.equal(error.retryable, false, `${errClass} must not be retryable`);
  }
});

test("createLlmError: produces a real Error (instanceof Error, has a stack, extends cleanly)", () => {
  const error = createLlmError("transport", "connection reset");
  assert.ok(error instanceof Error);
  assert.equal(error.message, "connection reset");
  assert.equal(typeof error.stack, "string");
});

test("createLlmError: retryAfterMs is attached only when supplied", () => {
  const withRetryAfter = createLlmError("rate_limit", "slow down", { retryAfterMs: 5000 });
  assert.equal(withRetryAfter.retryAfterMs, 5000);

  const withoutRetryAfter = createLlmError("rate_limit", "slow down");
  assert.equal(withoutRetryAfter.retryAfterMs, undefined);
});

test("createLlmError: keeps the underlying cause for debugging", () => {
  const cause = new Error("original SDK error");
  const error = createLlmError("provider_bug", "wrapped", { cause });
  assert.equal(error.cause, cause);
});

test("isLlmError: recognizes only LlmError-shaped errors", () => {
  assert.equal(isLlmError(createLlmError("auth", "no key")), true);
  assert.equal(isLlmError(new Error("plain error, no class/retryable")), false);
  assert.equal(isLlmError(null), false);
  assert.equal(isLlmError(undefined), false);
  assert.equal(isLlmError("not an error"), false);
  assert.equal(isLlmError({ class: "auth", retryable: false }), false); // not an Error instance
});

// Regression test for a mutation-testing finding: isLlmError checks THREE
// conditions (instanceof Error, class is a string, retryable is a boolean).
// Every other case above only ever varies the first two -- none pins down
// that the third is actually load-bearing. An Error instance carrying a
// `.class` string but a non-boolean (or absent) `.retryable` must still be
// rejected: withRetry's `isLlmError(err) && err.retryable` guard happens to
// degrade safely even without this check (a non-boolean retryable reads as
// falsy, so an unrecognized error still fails closed to "don't retry"), but
// isLlmError is a general-purpose type guard other m4-0x consumers will rely
// on too, and it should not silently accept a malformed shape just because
// today's one call site tolerates it.
test("isLlmError: rejects an Error with a class string but a non-boolean retryable", () => {
  const malformed = Object.assign(new Error("looks close but isn't"), { class: "transport", retryable: "yes" });
  assert.equal(isLlmError(malformed), false);

  const missingRetryable = Object.assign(new Error("no retryable at all"), { class: "transport" });
  assert.equal(isLlmError(missingRetryable), false);
});
