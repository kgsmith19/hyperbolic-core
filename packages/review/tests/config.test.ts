import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, VALID_PROVIDERS } from "../src/config.ts";

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
  // These are the raw identifiers shared by both role-specific enums. The
  // Google family uses distinct raw values and has its own control below.
  for (const provider of ["anthropic", "openai"] as const) {
    assert.throws(
      () =>
        resolveConfig({
          REVIEW_PROVIDER: provider,
          REVIEW_MODEL: "some-model-id",
          REVIEW_BUILDER_PROVIDER: provider,
          DEV_MODEL: "claude-opus-5",
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

// Behavior protected: same-company families are rejected. Both dev (harness)
// and review (API) now use the canonicalized "google" identifier, so a google
// builder and google reviewer from the same company must still be rejected.
test("resolveConfig: google builder and google reviewer are the same company family", () => {
  assert.throws(
    () =>
      resolveConfig({
        REVIEW_PROVIDER: "google",
        REVIEW_MODEL: "gemini-2.5-pro",
        REVIEW_BUILDER_PROVIDER: "google",
        DEV_MODEL: "claude-opus-5",
      }),
    /same provider family.*google/i
  );
});

// Positive control: `google` is a valid raw dev provider when the reviewer
// belongs to another company, and the raw role identifier must be preserved.
test("resolveConfig: google builder is valid with a non-google reviewer", () => {
  const config = resolveConfig({
    REVIEW_PROVIDER: "openai",
    REVIEW_MODEL: "gpt-5-mini",
    REVIEW_BUILDER_PROVIDER: "google",
    DEV_MODEL: "claude-opus-5",
  });

  assert.equal(config.reviewerProvider, "openai");
  assert.equal(config.builderProvider, "google");
});

// Behavior protected: an absent builder provider fails closed, naming the
// variable, rather than resolving through an assumed default (Issue #354).
//
// This test replaces one that asserted the OPPOSITE arrangement: that an
// anthropic reviewer with no explicit builder was caught by the separation
// guard, because the unset builder defaulted to anthropic. That accident of
// agreement is exactly the hazard -- the guard only fired because the guessed
// default happened to collide. The `doesNotMatch` is the load-bearing half:
// it proves the refusal happens at the missing-variable boundary, not one
// step later by coincidence, so the same absence is caught for every reviewer
// family rather than only for anthropic.
test("resolveConfig: an absent REVIEW_BUILDER_PROVIDER fails closed instead of defaulting", () => {
  assert.throws(
    () => resolveConfig({ REVIEW_PROVIDER: "anthropic", REVIEW_MODEL: "some-model-id" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /REVIEW_BUILDER_PROVIDER is unset or empty/);
      assert.doesNotMatch(
        error.message,
        /[Pp]rovider separation is required/,
        "the refusal must come from the missing variable itself, not from a defaulted value that happened to collide"
      );
      return true;
    }
  );
});

// The companion control, and the one the removed test could never express: a
// reviewer family that does NOT collide with the old anthropic default. Under
// the default this configuration resolved successfully and reviewed a change
// whose author was never stated, which is the silent degradation Issue #354
// closes.
test("resolveConfig: an absent REVIEW_BUILDER_PROVIDER fails closed even when no collision would result", () => {
  assert.throws(
    () => resolveConfig({ REVIEW_PROVIDER: "openai", REVIEW_MODEL: "some-model-id" }),
    /REVIEW_BUILDER_PROVIDER is unset or empty/
  );
});

// Behavior protected: whitespace is not a value here either. Defect caught: an
// unset `vars.DEV_PROVIDER` expanding to "" or " " in the workflow expression
// and sailing past a bare truthiness check into an unstated builder identity.
test("resolveConfig: whitespace-only REVIEW_BUILDER_PROVIDER is treated as unset", () => {
  assert.throws(
    () =>
      resolveConfig({
        REVIEW_PROVIDER: "openai",
        REVIEW_MODEL: "some-model-id",
        REVIEW_BUILDER_PROVIDER: "   ",
        DEV_MODEL: "claude-opus-5",
      }),
    /REVIEW_BUILDER_PROVIDER is unset or empty/
  );
});

// Behavior protected: the builder MODEL is required too, not only the family.
// Defect caught: recording provider separation while leaving the exact model
// that wrote the code unstated -- the review's own record of what it judged
// would then be half-anonymous, and no later reader could tell which model's
// output the reviewer actually graded.
test("resolveConfig: unset DEV_MODEL throws an error naming DEV_MODEL", () => {
  assert.throws(
    () =>
      resolveConfig({
        REVIEW_PROVIDER: "openai",
        REVIEW_MODEL: "some-model-id",
        REVIEW_BUILDER_PROVIDER: "anthropic",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DEV_MODEL/);
      assert.match(error.message, /unset or empty/);
      return true;
    }
  );
});

// Same whitespace hazard as every other required variable, for the same
// reason: `vars.DEV_MODEL` reaches this process through a CI expression.
//
// Every blank shape is exercised, not just a run of spaces: the builder model
// is the one required variable this package does NOT trim (see the byte-for-
// byte test below), so "is it blank" and "what is stored" are decided by two
// different rules. A tab- or newline-only value must still be rejected even
// though nothing downstream will strip it.
test("resolveConfig: a whitespace-only DEV_MODEL of any shape is treated as unset", () => {
  for (const blank of ["  ", "\t", "\n", " \t\n "]) {
    assert.throws(
      () =>
        resolveConfig({
          REVIEW_PROVIDER: "openai",
          REVIEW_MODEL: "some-model-id",
          REVIEW_BUILDER_PROVIDER: "anthropic",
          DEV_MODEL: blank,
        }),
      /DEV_MODEL is unset or empty/,
      `DEV_MODEL=${JSON.stringify(blank)} must be rejected`
    );
  }
});

// Behavior protected: a nonblank builder model is OPAQUE provenance, recorded
// byte for byte. Defect caught: routing it through the shared `required()`
// helper, which TRIMS -- right for identifiers this package normalizes anyway,
// wrong for a value whose whole job is to say exactly what the owner set --
// or lowercasing it alongside the provider identifiers.
//
// The sentinel is deliberately hostile on both axes at once: surrounding
// whitespace catches a trim, interior capitals catch a normalization, and the
// same case asserts the provider IS still canonicalized. A single-axis
// sentinel would let one of the two defects through.
test("resolveConfig: a nonblank builder model is recorded byte for byte", () => {
  const exactModelId = "  Claude-OPUS-5.1_Preview@2026-08\t";
  const config = resolveConfig({
    REVIEW_PROVIDER: "openai",
    REVIEW_MODEL: "gpt-5-mini",
    REVIEW_BUILDER_PROVIDER: "ANTHROPIC",
    DEV_MODEL: exactModelId,
  });

  assert.equal(config.builderProvider, "anthropic", "the provider IS normalized");
  assert.equal(
    config.builderModel,
    exactModelId,
    "the model is NOT -- neither trimmed nor lowercased"
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
    DEV_MODEL: "claude-opus-5",
  });

  assert.equal(config.reviewerProvider, "openai");
  assert.equal(config.reviewerModel, "a-specific-model-id");
  assert.equal(config.builderProvider, "anthropic");
  assert.ok(config.maxTokens > 0);
  assert.ok(config.timeoutMs > 0);
});

// Behavior protected: provider identifiers are case-insensitive at the
// configuration boundary, canonicalized to lowercase. Defect caught: the
// live failure from Issue #227 -- REVIEW_PROVIDER=OPENAI set as a repository
// variable failed an exact-match check even though the owner's intent was
// unambiguous. Any casing of a valid family must resolve, and must resolve
// to the lowercase canonical form (bin/review.mjs keys the credential
// variable name off config.reviewerProvider, so a mixed-case passthrough
// would fail credential lookup instead).
test("resolveConfig: REVIEW_PROVIDER casing is normalized to the lowercase canonical form", () => {
  for (const spelling of ["OPENAI", "OpenAI", "openai"]) {
    const config = resolveConfig({
      REVIEW_PROVIDER: spelling,
      REVIEW_MODEL: "a-specific-model-id",
      REVIEW_BUILDER_PROVIDER: "anthropic",
      DEV_MODEL: "claude-opus-5",
    });
    assert.equal(
      config.reviewerProvider,
      "openai",
      `REVIEW_PROVIDER="${spelling}" must canonicalize to "openai"`
    );
  }
});

// Behavior protected: case cannot smuggle a same-family pairing past the
// separation guard. Defect caught: normalizing the reviewer but comparing
// against a raw mixed-case builder (or vice versa), which would let
// REVIEW_PROVIDER=Anthropic / REVIEW_BUILDER_PROVIDER=ANTHROPIC run a
// same-family review that string inequality made look separated.
test("resolveConfig: separation guard compares normalized values, so casing cannot bypass it", () => {
  assert.throws(
    () =>
      resolveConfig({
        REVIEW_PROVIDER: "Anthropic",
        REVIEW_MODEL: "a-specific-model-id",
        REVIEW_BUILDER_PROVIDER: "ANTHROPIC",
        DEV_MODEL: "claude-opus-5",
      }),
    /[Pp]rovider separation is required/
  );
});

// Behavior protected: the builder identifier gets the same normalization as
// the reviewer -- one canonical representation, applied at one boundary.
test("resolveConfig: REVIEW_BUILDER_PROVIDER casing is normalized too", () => {
  const config = resolveConfig({
    REVIEW_PROVIDER: "openai",
    REVIEW_MODEL: "a-specific-model-id",
    REVIEW_BUILDER_PROVIDER: "Anthropic",
    DEV_MODEL: "claude-opus-5",
  });
  assert.equal(config.builderProvider, "anthropic");
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
        DEV_MODEL: "claude-opus-5",
      }),
    /REVIEW_BUILDER_PROVIDER="claude" is not a supported provider/
  );
});
