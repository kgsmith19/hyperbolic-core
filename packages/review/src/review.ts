/**
 * Orchestration: build the request, call the model, validate the answer.
 *
 * The one distinction this file exists to draw:
 *
 *   INFRASTRUCTURE FAILURE -- missing credential, auth rejection, rate limit
 *   exhaustion, transport error, timeout, or a response that contains no
 *   submit_review call at all -- means the review DID NOT HAPPEN. It throws,
 *   the CLI exits 2, and the gate fails closed. A gate that reports "pass"
 *   because it could not reach the provider is worse than no gate: it is a
 *   green light nobody earned.
 *
 *   WEAK ANSWER -- the model called the tool but produced an unparseable or
 *   unsupported verdict -- means the review HAPPENED and found nothing usable.
 *   That is a `pass` with the problem stated in `summary` (see validate.ts).
 *   A confused model must not be able to block a pull request.
 */

import { complete } from "@hyperbolic/llm";
import type { CredentialsByProvider, LlmRequest, LlmResponse } from "@hyperbolic/llm";
import type { ReviewContext } from "./context.ts";
import { buildSystemPrompt, buildUserMessage } from "./prompt.ts";
import { submitReviewTool, submitReviewToolChoice, SUBMIT_REVIEW_TOOL_NAME } from "./schema.ts";
import type { ReviewConfig, ReviewVerdict } from "./types.ts";
import { validateVerdict } from "./validate.ts";

/** The subset of `complete`'s signature this package depends on. */
export type CompleteFn = (request: LlmRequest, credentials: CredentialsByProvider) => Promise<LlmResponse>;

export interface RunReviewOptions {
  config: ReviewConfig;
  context: ReviewContext;
  credentials: CredentialsByProvider;
  /** Injected in tests; defaults to the real `@hyperbolic/llm` client. */
  completeFn?: CompleteFn;
}

/** Thrown when the review could not be performed at all. Fails the gate. */
export class ReviewInfrastructureError extends Error {
  override readonly name = "ReviewInfrastructureError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Builds the exact request sent to the reviewer. Pure; exported for tests. */
export function buildReviewRequest(config: ReviewConfig, context: ReviewContext): LlmRequest {
  return {
    provider: config.reviewerProvider,
    model: config.reviewerModel,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserMessage(context) },
    ],
    tools: [submitReviewTool],
    toolChoice: submitReviewToolChoice,
    // Zero, not because it makes the model right, but because a gate whose
    // verdict changes between two runs of the same SHA is not a gate. Re-runs
    // must be boring.
    temperature: 0,
    maxTokens: config.maxTokens,
    // The builder identity travels ON the request, not in it: `metadata` is
    // the client's caller-side logging spine and is never transmitted, so the
    // run records whose work it judged without ever telling the reviewer who
    // wrote the code -- which would invite exactly the authorship-based
    // reasoning buildSystemPrompt forbids (Issue #354).
    metadata: {
      callerApp: "review-gate",
      purpose: "pr-review",
      provenance: { provider: config.builderProvider, model: config.builderModel },
    },
    timeoutMs: config.timeoutMs,
  };
}

/**
 * Run one adversarial review and return the validated verdict.
 *
 * Throws `ReviewInfrastructureError` when the review could not be performed.
 * Never throws because the model answered badly.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewVerdict> {
  const { config, context, credentials, completeFn = complete } = options;

  if (credentials[config.reviewerProvider] === undefined) {
    throw new ReviewInfrastructureError(
      `No credential supplied for the reviewer provider "${config.reviewerProvider}". The review did not run; failing closed.`
    );
  }

  const request = buildReviewRequest(config, context);

  let response: LlmResponse;
  try {
    response = await completeFn(request, credentials);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ReviewInfrastructureError(
      `The review call to ${config.reviewerProvider}/${config.reviewerModel} failed: ${detail}. The review did not run; failing closed.`,
      { cause }
    );
  }

  const toolCall = response.toolCalls.find((call) => call.name === SUBMIT_REVIEW_TOOL_NAME);
  if (toolCall === undefined) {
    // toolChoice forced this call. Its absence means the provider ignored the
    // constraint or the response was cut short -- either way the reviewer
    // never rendered a verdict, so there is nothing to pass on.
    throw new ReviewInfrastructureError(
      `The reviewer returned no ${SUBMIT_REVIEW_TOOL_NAME} call (stopReason="${response.stopReason}") despite toolChoice forcing one. The review did not run; failing closed.`
    );
  }

  // priorDialogue is derived from the exact conversation the model was shown
  // (Issue #325): prompt.ts renders an empty conversation as the first-round
  // placeholder, so "the payload had prior dialogue" and "the validator
  // requires deliberation on continued blocks" are the same fact, computed
  // from the same field, and cannot drift apart.
  return validateVerdict(toolCall.input, { priorDialogue: context.conversation.trim() !== "" });
}
