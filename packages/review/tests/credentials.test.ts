import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "@hyperbolic/llm";
import { readCredentials, REVIEW_CREDENTIAL_ENV_VARS } from "../src/credentials.ts";
import { VALID_PROVIDERS } from "../src/config.ts";

// THE reason this moved out of bin/review.mjs. The mapping used to name a
// `gemini` key that `Provider` has not contained since the identifiers were
// canonicalized, so `readCredentials(env, "google")` looked up `env[undefined]`
// and failed with "undefined is unset or empty" -- naming no variable the owner
// could act on, for the one provider family Issue #354 explicitly requires to
// keep working. It failed closed, so nothing was ever exposed; it simply made
// the google reviewer path unusable and said nothing useful about why.
//
// Every canonical provider is asserted, not just the repaired one: a table with
// one entry per provider is exactly the kind of thing that goes stale silently
// when the provider union changes, and this is the oracle that notices.
test("readCredentials: every canonical provider selects its own credential variable", () => {
  const expected: Record<Provider, string> = {
    anthropic: "REVIEW_ANTHROPIC_API_KEY",
    openai: "REVIEW_OPENAI_API_KEY",
    // The variable keeps its historical GEMINI name -- it is the live Infisical
    // secret at /review/, and renaming a provisioned secret is not this
    // change's business. Only the PROVIDER identifier is canonical.
    google: "REVIEW_GEMINI_API_KEY",
  };

  for (const provider of VALID_PROVIDERS) {
    const variable = expected[provider];
    const credentials = readCredentials({ [variable]: "a-key" }, provider);

    assert.deepEqual(
      credentials,
      { [provider]: { apiKey: "a-key" } },
      `${provider} must read ${variable}`
    );
  }
});

// The table must cover the provider union exactly -- no gap that would
// resurface the undefined lookup, and no leftover identifier for a family the
// gate can no longer dispatch to.
test("readCredentials: the credential table covers every valid provider and nothing else", () => {
  assert.deepEqual(Object.keys(REVIEW_CREDENTIAL_ENV_VARS).sort(), [...VALID_PROVIDERS].sort());
});

// Behavior protected: a missing key names the variable the owner has to set.
// Defect caught: the pre-repair google path, which reported the literal string
// "undefined" as the variable name -- an error that told the reader nothing.
test("readCredentials: a missing key names the exact variable, for google too", () => {
  assert.throws(
    () => readCredentials({}, "google"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /REVIEW_GEMINI_API_KEY is unset or empty/);
      assert.doesNotMatch(error.message, /undefined/, "the variable name must never render as undefined");
      return true;
    }
  );
});

// Whitespace is not a key, for the same reason it is not a model id: a CI
// expression that expands an unset secret to " " must fail closed here rather
// than send a blank Authorization header to the provider.
test("readCredentials: a whitespace-only key is treated as unset", () => {
  assert.throws(() => readCredentials({ REVIEW_OPENAI_API_KEY: "   " }, "openai"), /unset or empty/);
});

// Blast radius: the review makes exactly one call, so the client is handed
// exactly one provider's key even when every key is present.
test("readCredentials: only the reviewer's own key is handed out", () => {
  const credentials = readCredentials(
    {
      REVIEW_ANTHROPIC_API_KEY: "anthropic-key",
      REVIEW_OPENAI_API_KEY: "openai-key",
      REVIEW_GEMINI_API_KEY: "google-key",
    },
    "openai"
  );

  assert.deepEqual(credentials, { openai: { apiKey: "openai-key" } });
});
