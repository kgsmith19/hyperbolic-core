import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterMs } from "../src/drivers/retry-after.ts";

/**
 * Finding #86: Retry-After parsing, hoisted out of anthropic.ts/openai.ts's
 * previously-duplicated, numeric-only implementation into this one shared
 * helper -- now also handling RFC 7231's other valid form, an HTTP-date.
 * See openai-driver.test.ts's "honors an HTTP-date retry-after header" for
 * the end-to-end driver-level regression test.
 */

function headersWith(retryAfter: string): Headers {
  return new Headers({ "retry-after": retryAfter });
}

// ---------------------------------------------------------------------------
// Delta-seconds form (regression guard: unchanged by this hoist)
// ---------------------------------------------------------------------------

test("parseRetryAfterMs: a numeric delta-seconds value is parsed to milliseconds (regression guard)", () => {
  assert.equal(parseRetryAfterMs(headersWith("5")), 5000);
  assert.equal(parseRetryAfterMs(headersWith("0")), 0);
  assert.equal(parseRetryAfterMs(headersWith("120")), 120_000);
});

test("parseRetryAfterMs: a negative delta-seconds value is discarded (falls back to undefined, i.e. computed backoff)", () => {
  assert.equal(parseRetryAfterMs(headersWith("-1")), undefined);
});

test("parseRetryAfterMs: no header at all is undefined", () => {
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(new Headers()), undefined);
});

// ---------------------------------------------------------------------------
// HTTP-date form (the actual fix)
// ---------------------------------------------------------------------------

test("parseRetryAfterMs: a valid future HTTP-date is parsed into the correct delta-ms", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const nowMs = Date.now(); // frozen by MockTimers
  const futureDate = new Date(nowMs + 5000).toUTCString();
  assert.equal(parseRetryAfterMs(headersWith(futureDate)), 5000);
});

test("parseRetryAfterMs: the exact RFC 7231 example date format is parsed", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const nowMs = Date.now();
  // Fixed a full day before a known instant, using the RFC 7231 example's
  // own IMF-fixdate format ("Wed, 21 Oct 2015 07:28:00 GMT").
  const target = new Date(nowMs + 24 * 60 * 60 * 1000);
  const httpDate = target.toUTCString();
  assert.match(httpDate, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  assert.equal(parseRetryAfterMs(headersWith(httpDate)), 24 * 60 * 60 * 1000);
});

test("parseRetryAfterMs: an HTTP-date already in the past is bounded to 0, not discarded and not negative", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const nowMs = Date.now();
  const pastDate = new Date(nowMs - 10_000).toUTCString();
  assert.equal(parseRetryAfterMs(headersWith(pastDate)), 0);
});

test("parseRetryAfterMs: an HTTP-date well above this package's own RETRY_CAP_MS is still honored verbatim, not clamped to the cap", (t) => {
  // Consistent with retry.test.ts's own "honors retryAfterMs verbatim...
  // even above the 30s cap" test for the numeric form -- an identical
  // requested wait must not behave differently just because the provider
  // happened to use the HTTP-date form instead of delta-seconds.
  t.mock.timers.enable({ apis: ["Date"] });
  const nowMs = Date.now();
  const farFutureDate = new Date(nowMs + 45_000).toUTCString();
  assert.equal(parseRetryAfterMs(headersWith(farFutureDate)), 45_000);
});

// ---------------------------------------------------------------------------
// Garbage input: falls back to undefined (computed backoff), never NaN or negative
// ---------------------------------------------------------------------------

test("parseRetryAfterMs: a garbage/unparseable string in either form safely falls back to undefined", () => {
  const result = parseRetryAfterMs(headersWith("not-a-number-and-not-a-date"));
  assert.equal(result, undefined);
  assert.notEqual(result, Number.NaN); // explicit: must never be NaN
});

test("parseRetryAfterMs: an empty string header value is undefined", () => {
  assert.equal(parseRetryAfterMs(headersWith("")), undefined);
});
