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
export const VALID_PROVIDERS: readonly Provider[] = ["anthropic", "openai", "google"];

/** The coding-agent harness companies accepted for the builder role. */
const VALID_BUILDER_PROVIDERS: readonly BuilderProvider[] = ["anthropic", "openai", "google"];

/**
 * Generous enough for a long verdict on a large diff; the tool schema, not
 * this number, is what keeps the answer structured.
 *
 * Kept below the Anthropic SDK's long-request threshold for non-streaming
 * calls; the structured verdict and evidence citations fit comfortably here.
 */
export const DEFAULT_MAX_TOKENS = 8_000;

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

/**
 * Same nonblank requirement as `required`, but the caller's exact bytes.
 *
 * Deliberately a second helper rather than a flag on the first: `required` is
 * for identifiers this package normalizes anyway, where trimming is free.
 * Opaque provenance is the opposite case -- its whole job is to say exactly
 * what the owner set, so trimming it would silently rewrite the record. Blank
 * is still not a value; "blank" is decided on the trimmed form, and the
 * untrimmed original is what gets stored.
 */
function requiredVerbatim(env: ReviewEnv, name: string, hint: string): string {
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${name} is unset or empty. ${hint}`);
  }
  return raw;
}

function isProvider(value: string): value is Provider {
  return (VALID_PROVIDERS as readonly string[]).includes(value);
}

function isBuilderProvider(value: string): value is BuilderProvider {
  return (VALID_BUILDER_PROVIDERS as readonly string[]).includes(value);
}

type ProviderFamily = "anthropic" | "openai" | "google";

function providerFamily(provider: Provider | BuilderProvider): ProviderFamily {
  return provider as ProviderFamily;
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
 * Reads `REVIEW_PROVIDER`, `REVIEW_MODEL`, `REVIEW_BUILDER_PROVIDER`, and
 * `DEV_MODEL`. All four are required and none is defaulted. Provider
 * identifiers are case-insensitive at this boundary and canonicalized to
 * lowercase; nothing downstream ever sees a mixed-case provider name. Model
 * ids are not: they are opaque vendor strings this package never interprets,
 * so they are carried exactly as the owner wrote them.
 *
 * The builder half used to default to `"anthropic"` when unstated. That made
 * the gate fail closed for an anthropic reviewer purely by collision, and
 * fail OPEN for every other reviewer family -- an unset `vars.DEV_PROVIDER`
 * silently became a claim about who wrote the code, and the review proceeded
 * to import a credential on the strength of it (Issue #354). There is now no
 * value this package will invent on the caller's behalf.
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

  const rawBuilder = required(
    env,
    "REVIEW_BUILDER_PROVIDER",
    `Set it to the coding-agent harness company that WROTE this change (vars.DEV_PROVIDER), one of: ${VALID_BUILDER_PROVIDERS.join(", ")}. It must differ from REVIEW_PROVIDER, and this package never assumes one.`
  );
  const builderProvider = normalizeProvider(rawBuilder);
  if (!isBuilderProvider(builderProvider)) {
    throw new Error(
      `REVIEW_BUILDER_PROVIDER="${rawBuilder}" is not a supported provider. Valid providers are: ${VALID_BUILDER_PROVIDERS.join(", ")}.`
    );
  }

  // Opaque on purpose, and deliberately NOT normalized alongside the provider
  // identifiers above -- not lowercased, not trimmed, not checked against a
  // list. A provider name is a closed enum this package dispatches on; a
  // builder model id is a vendor string it only records, and rewriting it in
  // any way would falsify the one durable statement the config makes about
  // whose work was reviewed.
  const builderModel = requiredVerbatim(
    env,
    "DEV_MODEL",
    `Set it to the exact model id the builder ran (vars.DEV_MODEL). This package records it verbatim and never infers it.`
  );

  const reviewerFamily = providerFamily(reviewerProvider);
  const builderFamily = providerFamily(builderProvider);
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
    builderProvider,
    builderModel,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
