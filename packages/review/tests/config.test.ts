import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BUILDER_PROVIDER, resolveConfig, VALID_PROVIDERS } from "../src/config.ts";

// Behavior protected: resolveConfig fails closed on a missing model id.
// Defect caught: a future "sensible default" for REVIEW_MODEL. A defaulted
// model silently reviews with something the owner never chose -- possibly a
// weak or deprecated one -- while still reporting green, which is the exact
// false-confidence failure this gate exists to prevent.
test("resolveConfig: unset REVIEW_MODEL throws an error naming REVIEW_MODEL", () => {
  assert.throws(
    () => resolveConfig({ REVIEW_PROVIDER: "openai" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /REVIEW_MODEL/);
      assert.match(error.message, /unset or empty/);
      return true;
    }
  );
});

// Behavior protected: whitespace is not a value. Defect caught: a CI
// expression that expands an unset `vars.REVIEW_MODEL` to "" or " " would
// otherwise sail past a bare truthiness check and be sent to the provider as
// an empty model id.
test("resolveConfig: whitespace-only REVIEW_MODEL is treated as unset", () => {
  assert.throws(
    () => resolveConfig({ REVIEW_PROVIDER: "openai", REVIEW_MODEL: "   " }),
    /REVIEW_MODEL is unset or empty/
  );
});

// Behavior protected: resolveConfig fails closed on a missing provider.
// Defect caught: falling back to a hardcoded provider, which would quietly
// destroy provider separation by reviewing with whichever family the fallback
// named -- possibly the builder's own.
test("resolveConfig: unset REVIEW_PROVIDER throws an error naming REVIEW_PROVIDER", () => {
  assert.throws(
    () => resolveConfig({ REVIEW_MODEL: "some-model-id" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /REVIEW_PROVIDER/);
      assert.match(error.message, /unset or empty/);
      return true;
    }
  );
});

// Behavior protected: an unsupported provider name is rejected with the valid
// set named. Defect caught: a typo ("antropic") or a family @hyperbolic/llm has
// no driver for reaching the client, where it surfaces as an opaque
// "no driver registered" error mid-run instead of an actionable config error
// before any call is made.
test("resolveConfig: an invalid REVIEW_PROVIDER throws and names every valid provider", () => {
  assert.throws(
    () => resolveConfig({ REVIEW_PROVIDER: "antropic", REVIEW_MODEL: "some-model-id" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /antropic/);
      for (const provider of VALID_PROVIDERS) {
        assert.match(error.message, new RegExp(provider));
      }
      return true;
    }
  );
});

// THE provider-separation guard, and the highest-value test in this package.
//
// Behavior protected: the reviewer may never come from the same provider
// family as the builder. Defect caught: any change -- a refactor, a "simplify
// the config" cleanup, a CI variable set to the wrong value -- that lets the
// gate run same-family. That failure is invisible at runtime: the review still
// completes, still returns findings, still reports a verdict. It just quietly
// stops being an independent check, because the reviewer re-derives the same
// blind spots as the author. Without this test nothing in the system would
// notice.
test("resolveConfig: reviewer and builder from the same family is rejected", () => {
  for (const provider of VALID_PROVIDERS) {
    assert.throws(
      () =>
        resolveConfig({
          REVIEW_PROVIDER: provider,
          REVIEW_MODEL: "some-model-id",
          REVIEW_BUILDER_PROVIDER: provider,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /[Pp]rovider separation is required/);
        assert.match(error.message, new RegExp(provider));
        return true;
      },
      `same-family review must be rejected for provider "${provider}"`
    );
  }
});

// The default builder is anthropic, so an anthropic reviewer with NO explicit
// builder must still be rejected. Defect caught: implementing the separation
// check against the raw env var instead of the resolved value, which would let
// the most likely real-world misconfiguration -- forgetting to set
// REVIEW_BUILDER_PROVIDER at all -- slip straight through.
test("resolveConfig: same-family is caught through the default builder provider too", () => {
  assert.throws(
    () => resolveConfig({ REVIEW_PROVIDER: DEFAULT_BUILDER_PROVIDER, REVIEW_MODEL: "some-model-id" }),
    /[Pp]rovider separation is required/
  );
});

// Positive control for the guard above: it must not reject everything. A check
// that always throws would pass the rejection tests while making the gate
// unrunnable, so this proves the guard discriminates rather than refuses.
test("resolveConfig: differing reviewer and builder families resolve successfully", () => {
  const config = resolveConfig({
    REVIEW_PROVIDER: "openai",
    REVIEW_MODEL: "a-specific-model-id",
    REVIEW_BUILDER_PROVIDER: "anthropic",
  });

  assert.equal(config.reviewerProvider, "openai");
  assert.equal(config.reviewerModel, "a-specific-model-id");
  assert.equal(config.builderProvider, "anthropic");
  assert.ok(config.maxTokens > 0);
  assert.ok(config.timeoutMs > 0);
});

// Behavior protected: an invalid REVIEW_BUILDER_PROVIDER is rejected rather
// than silently coerced. Defect caught: treating an unrecognized builder name
// as "not equal to the reviewer, therefore fine" -- which would turn a typo in
// the builder variable into a bypass of the separation check.
test("resolveConfig: an invalid REVIEW_BUILDER_PROVIDER is rejected, not ignored", () => {
  assert.throws(
    () =>
      resolveConfig({
        REVIEW_PROVIDER: "openai",
        REVIEW_MODEL: "a-specific-model-id",
        REVIEW_BUILDER_PROVIDER: "claude",
      }),
    /REVIEW_BUILDER_PROVIDER="claude" is not a supported provider/
  );
});
