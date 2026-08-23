/**
 * Run configuration for the review gate, resolved from the environment.
 *
 * Everything here fails CLOSED. A review gate that silently degrades -- picks
 * a default model, guesses a provider, or reviews with the same family that
 * wrote the code -- still reports green, and a green that means nothing is
 * worse than a red: it buys false confidence. So every ambiguity is an Error
 * naming the exact variable to set.
 */

import type { Provider } from "@hyperbolic/llm";
import type { BuilderProvider, ReviewConfig } from "./types.ts";

/** The review API provider identifiers `@hyperbolic/llm` can dispatch to. */
export const VALID_PROVIDERS: readonly Provider[] = ["anthropic", "openai", "gemini"];

/** The coding-agent harness companies accepted for the builder role. */
const VALID_BUILDER_PROVIDERS: readonly BuilderProvider[] = ["anthropic", "openai", "google"];

/** Assumed raw builder provider when the caller does not state one. */
export const DEFAULT_BUILDER_PROVIDER: BuilderProvider = "anthropic";

/**
 * Generous enough for a long verdict on a large diff; the tool schema, not
 * this number, is what keeps the answer structured.
 *
 * Sized for OpenAI reasoning models (o1/o3/o4/gpt-5), not just the visible
 * verdict: `max_completion_tokens` there is a shared budget that internal
 * reasoning tokens spend from before any output text or tool call is
 * emitted (see openai.ts's TEMPERATURE_LOCKED_MODEL_PREFIXES for the same
 * model family). Observed live on gpt-5-mini reviewing a real PR diff --
 * 8000 was tight enough that the model exhausted the whole budget on
 * reasoning and hit stopReason "max_tokens" with no submit_review call at
 * all (runReview's own ReviewInfrastructureError branch for exactly this).
 * Anthropic and Gemini pay only for tokens actually generated, so a higher
 * ceiling costs nothing extra when it's Claude or Gemini reviewing instead.
 */
export const DEFAULT_MAX_TOKENS = 32_000;

/** Hard wall per attempt. A review that hangs must fail, not stall CI. */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** A minimal, read-only view of `process.env`, so callers can pass a literal. */
export type ReviewEnv = Record<string, string | undefined>;

function required(env: ReviewEnv, name: string, hint: string): string {
  const raw = env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    throw new Error(`${name} is unset or empty. ${hint}`);
  }
  return value;
}

function isProvider(value: string): value is Provider {
  return (VALID_PROVIDERS as readonly string[]).includes(value);
}

function isBuilderProvider(value: string): value is BuilderProvider {
  return (VALID_BUILDER_PROVIDERS as readonly string[]).includes(value);
}

type ProviderFamily = "anthropic" | "openai" | "google";

function providerFamily(provider: Provider | BuilderProvider): ProviderFamily {
  return provider === "gemini" ? "google" : provider;
}

/**
 * One canonical representation: provider identifiers are lowercase. This is
 * the single place case is normalized -- "OPENAI" in a repository variable
 * must mean openai here at the configuration boundary, not surface as a
 * confusing exact-match failure downstream (Issue #227's failure mode).
 * Error messages still echo the caller's original spelling for diagnosis.
 */
function normalizeProvider(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Resolve `ReviewConfig` from environment variables.
 *
 * Reads `REVIEW_PROVIDER`, `REVIEW_MODEL`, and optionally
 * `REVIEW_BUILDER_PROVIDER` (default `"anthropic"`). Provider identifiers are
 * case-insensitive at this boundary and canonicalized to lowercase; nothing
 * downstream ever sees a mixed-case provider name.
 *
 * Throws -- never returns a partial or defaulted config -- when a required
 * variable is missing, when a provider name is not valid for its role, or
 * when the reviewer and builder resolve to the same company family.
 */
export function resolveConfig(env: ReviewEnv): ReviewConfig {
  const rawProvider = required(
    env,
    "REVIEW_PROVIDER",
    `Set it to the provider family that should REVIEW this change, one of: ${VALID_PROVIDERS.join(", ")}. It must differ from REVIEW_BUILDER_PROVIDER.`
  );
  const reviewerProvider = normalizeProvider(rawProvider);
  if (!isProvider(reviewerProvider)) {
    throw new Error(
      `REVIEW_PROVIDER="${rawProvider}" is not a supported provider. Valid providers are: ${VALID_PROVIDERS.join(", ")}.`
    );
  }

  // Deliberately after the provider check and never defaulted: a wrong model
  // id must surface as a provider error naming the id the owner chose, not be
  // papered over by a guess this package invented.
  const reviewerModel = required(
    env,
    "REVIEW_MODEL",
    `Set it to an exact model id served by REVIEW_PROVIDER="${rawProvider}". This package never defaults a model id.`
  );

  const rawBuilder = (env.REVIEW_BUILDER_PROVIDER ?? "").trim();
  const builderCandidate =
    rawBuilder === "" ? DEFAULT_BUILDER_PROVIDER : normalizeProvider(rawBuilder);
  if (!isBuilderProvider(builderCandidate)) {
    throw new Error(
      `REVIEW_BUILDER_PROVIDER="${rawBuilder}" is not a supported provider. Valid providers are: ${VALID_BUILDER_PROVIDERS.join(", ")}.`
    );
  }

  const reviewerFamily = providerFamily(reviewerProvider);
  const builderFamily = providerFamily(builderCandidate);
  if (reviewerFamily === builderFamily) {
    throw new Error(
      `Provider separation is required: REVIEW_PROVIDER and REVIEW_BUILDER_PROVIDER resolve to the same provider family "${reviewerFamily}". ` +
        `The reviewer must come from a different provider family than the one that wrote the code, so the review is not a model ` +
        `family grading its own work and re-deriving its own blind spots. Set REVIEW_PROVIDER to one of: ` +
        `${VALID_PROVIDERS.filter((provider) => providerFamily(provider) !== reviewerFamily).join(", ")}.`
    );
  }

  return {
    reviewerProvider,
    reviewerModel,
    builderProvider: builderCandidate,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
