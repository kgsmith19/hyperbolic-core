/**
 * `@hyperbolic/review` -- the adversarial LLM PR-review gate.
 *
 * Sends a pull request's diff plus its Issue and AGENTS.md to a model from a
 * DIFFERENT provider family than the one that wrote the code (config.ts
 * refuses to run otherwise), forces a structured verdict through a single
 * tool, discards findings that carry no evidence or citation, and blocks only
 * on what survives. Runnable locally via bin/review.mjs and from CI.
 *
 * This package never reads an API key. Credentials are an argument on every
 * call, same contract as `@hyperbolic/llm`; only bin/review.mjs reads the
 * environment.
 */

export type { Finding, Provider, ReviewConfig, ReviewVerdict, Severity } from "./types.ts";

export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  VALID_PROVIDERS,
} from "./config.ts";
export type { ReviewEnv } from "./config.ts";

export { readCredentials } from "./credentials.ts";

export { SUBMIT_REVIEW_TOOL_NAME, submitReviewTool, submitReviewToolChoice } from "./schema.ts";

export { buildSystemPrompt, buildUserMessage, DATA_NOT_INSTRUCTIONS_RULE } from "./prompt.ts";

export {
  defaultRunGit,
  gatherContext,
  looksLikeTestPath,
  PER_INPUT_CHAR_CAP,
  TOTAL_CHAR_CAP,
  truncateWithMarker,
} from "./context.ts";
export type { ChangedTestFile, GatherContextOptions, ReviewContext, RunGit } from "./context.ts";

export { MALFORMED_SUMMARY_PREFIX, validateVerdict } from "./validate.ts";

export { buildReviewRequest, ReviewInfrastructureError, runReview } from "./review.ts";
export type { CompleteFn, RunReviewOptions } from "./review.ts";
