import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateUsd, BLENDED_USD_PER_TOKEN } from "../src/pricing.ts";

test("estimateUsd: sums all three token classes at the blended rate", () => {
  assert.equal(estimateUsd(1_000_000, 0, 0), BLENDED_USD_PER_TOKEN * 1_000_000);
  assert.equal(estimateUsd(100, 50, 10), Math.round(160 * BLENDED_USD_PER_TOKEN * 1e6) / 1e6);
});

test("estimateUsd: zero tokens -> zero dollars, never negative or NaN", () => {
  assert.equal(estimateUsd(0, 0, 0), 0);
  assert.equal(estimateUsd(-5, 0, 0), 0, "negative input is clamped, never produces a negative estimate");
});

test("estimateUsd: BR-5's own 'non-null tokens and dollars' -- a real positive token count always yields a positive, finite number", () => {
  const usd = estimateUsd(1500, 0, 0);
  assert.equal(Number.isFinite(usd), true);
  assert.ok(usd > 0);
});
