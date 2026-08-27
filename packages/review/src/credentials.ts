/**
 * Which environment variable holds the reviewer's API key, per provider.
 *
 * This lived inside bin/review.mjs, which contradicted that file's own stated
 * design -- "every decision lives in ../src/ so the whole gate is testable
 * without spawning a subprocess". It was also wrong: the table still keyed on
 * `gemini`, an identifier `Provider` stopped containing when the families were
 * canonicalized, so a `google` reviewer looked up `env[undefined]` and failed
 * naming no variable anyone could act on. Untestable and wrong is not a
 * coincidence -- the mapping had no oracle, so nothing noticed when the union
 * moved out from under it.
 *
 * `Record<Provider, string>` is what stops that recurring: the table is now
 * exhaustive by construction, and adding a provider family fails the build here
 * rather than at runtime, on the one path that needs a credential.
 */

import type { CredentialsByProvider, Provider } from "@hyperbolic/llm";
import type { ReviewEnv } from "./config.ts";

/**
 * The variable names are deliberately NOT derived from the provider id. They
 * name live Infisical secrets at `/review/`, and `google`'s is historically
 * `REVIEW_GEMINI_API_KEY`; renaming a provisioned secret is a separate,
 * operational change. The provider identifier is canonical, the variable name
 * is whatever the owner actually created.
 */
export const REVIEW_CREDENTIAL_ENV_VARS: Readonly<Record<Provider, string>> = {
  anthropic: "REVIEW_ANTHROPIC_API_KEY",
  openai: "REVIEW_OPENAI_API_KEY",
  google: "REVIEW_GEMINI_API_KEY",
};

/**
 * Read exactly one provider's key.
 *
 * Handing the client every key it could find would widen this process's blast
 * radius for no benefit: the review makes exactly one call. Blank is not a key
 * -- a CI expression that expands an unset secret to whitespace must fail here,
 * not become an empty Authorization header the provider rejects later.
 */
export function readCredentials(env: ReviewEnv, provider: Provider): CredentialsByProvider {
  const variable = REVIEW_CREDENTIAL_ENV_VARS[provider];
  const apiKey = (env[variable] ?? "").trim();
  if (apiKey === "") {
    throw new Error(
      `${variable} is unset or empty, but REVIEW_PROVIDER="${provider}" needs it. The review cannot run; failing closed.`
    );
  }
  return { [provider]: { apiKey } };
}
