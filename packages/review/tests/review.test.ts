import { test } from "node:test";
import assert from "node:assert/strict";
import type { CredentialsByProvider, LlmRequest, LlmResponse } from "@hyperbolic/llm";
import type { ReviewContext } from "../src/context.ts";
import { buildReviewRequest, ReviewInfrastructureError, runReview } from "../src/review.ts";
import { SUBMIT_REVIEW_TOOL_NAME } from "../src/schema.ts";
import type { ReviewConfig } from "../src/types.ts";

const config: ReviewConfig = {
  reviewerProvider: "openai",
  reviewerModel: "a-specific-model-id",
  builderProvider: "anthropic",
  builderModel: "a-specific-builder-model-id",
  maxTokens: 4096,
  timeoutMs: 60_000,
};

const context: ReviewContext = {
  baseSha: "base0000",
  headSha: "head1111",
  diff: "--- a/src/pricing.ts\n+++ b/src/pricing.ts\n+export const rate = 0.1;\n",
  changedFiles: ["src/pricing.ts", "tests/pricing.test.ts"],
  testFiles: [{ path: "tests/pricing.test.ts", contents: "assert.equal(rate, 0.1);" }],
  issueBody: "Acceptance criterion 1: the rate is configurable.",
  prBody: "Made the discount rate configurable per the linked Issue.",
  agentsMd: "## Test quality\nEvery test must be able to fail.",
  conversation: "",
  truncated: false,
};

const credentials: CredentialsByProvider = { openai: { apiKey: "test-key" } };

function response(overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    text: null,
    toolCalls: [],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 },
    provider: "openai",
    model: "a-specific-model-id",
    latencyMs: 5,
    ...overrides,
  };
}

const validBlockingCall = {
  id: "call_1",
  name: SUBMIT_REVIEW_TOOL_NAME,
  input: {
    verdict: "block",
    summary: "The added test cannot fail.",
    findings: [
      {
        severity: "blocking",
        category: "test-quality",
        claim: "The assertion restates the value set two lines above it.",
        evidence: "const rate = 0.1; assert.equal(rate, 0.1);",
        requestedChange: "Assert the value produced by the code under test instead.",
        citation: "AGENTS.md > Test quality",
      },
    ],
  },
};

// Behavior protected: the reviewer is forced into the structured tool and given
// a deterministic temperature. Defect caught: a refactor that drops toolChoice
// (letting the model answer in prose, which then parses as malformed and passes
// everything) or raises temperature (making the same SHA produce different
// verdicts on re-run, which converts the gate into a lottery).
test("buildReviewRequest: forces submit_review at temperature 0", () => {
  const request: LlmRequest = buildReviewRequest(config, context);

  assert.equal(request.provider, "openai");
  assert.equal(request.model, "a-specific-model-id");
  assert.equal(request.temperature, 0);
  assert.deepEqual(request.toolChoice, { name: SUBMIT_REVIEW_TOOL_NAME });
  assert.equal(request.tools?.length, 1);
  assert.equal(request.tools?.[0]?.name, SUBMIT_REVIEW_TOOL_NAME);
  assert.deepEqual(request.metadata, {
    callerApp: "review-gate",
    purpose: "pr-review",
    provenance: { provider: "anthropic", model: "a-specific-builder-model-id" },
  });
  assert.equal(request.messages[0]?.role, "system");
  assert.equal(request.messages[1]?.role, "user");
});

// FAIL-CLOSED ON INFRASTRUCTURE. Behavior protected: when the review call
// itself fails, runReview throws rather than returning a verdict. Defect
// caught: a try/catch that "gracefully degrades" to pass. That is the single
// most damaging possible bug here -- an expired key, a rate limit, or an outage
// would silently turn the gate into a green rubber stamp, and nothing
// downstream would ever notice, because a passing gate looks identical whether
// it reviewed the code or never called the model at all.
test("runReview: an infrastructure error propagates instead of passing", async () => {
  await assert.rejects(
    () =>
      runReview({
        config,
        context,
        credentials,
        completeFn: async () => {
          throw new Error("429 rate_limit_exceeded");
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewInfrastructureError);
      assert.match(error.message, /429 rate_limit_exceeded/);
      assert.match(error.message, /failing closed/);
      return true;
    }
  );
});

// Behavior protected: a missing reviewer credential fails before any call.
// Defect caught: relying on the provider to reject the empty key later, which
// on some drivers surfaces as a generic transport error and, in any case,
// wastes a CI minute to learn something knowable up front.
test("runReview: a missing reviewer credential fails closed before calling out", async () => {
  let called = false;
  await assert.rejects(
    () =>
      runReview({
        config,
        context,
        credentials: { anthropic: { apiKey: "wrong-provider-key" } },
        completeFn: async () => {
          called = true;
          return response();
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewInfrastructureError);
      assert.match(error.message, /openai/);
      return true;
    }
  );
  assert.equal(called, false, "no provider call may be made without a credential");
});

// Behavior protected: a response carrying no forced tool call is infrastructure
// failure, not a pass. Defect caught: treating "no findings returned" as "no
// findings exist". toolChoice made the call mandatory, so its absence means the
// reviewer never rendered a verdict -- there is nothing to pass on.
test("runReview: a response with no submit_review call fails closed", async () => {
  await assert.rejects(
    () => runReview({ config, context, credentials, completeFn: async () => response({ stopReason: "max_tokens" }) }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewInfrastructureError);
      assert.match(error.message, /max_tokens/);
      return true;
    }
  );
});

// Behavior protected: a weak or malformed ANSWER is not an infrastructure
// failure. Defect caught: collapsing the two cases, which would make every
// confused model response a red gate and quickly get the check disabled.
test("runReview: a malformed tool payload returns a non-blocking verdict rather than throwing", async () => {
  const verdict = await runReview({
    config,
    context,
    credentials,
    completeFn: async () =>
      response({ toolCalls: [{ id: "call_1", name: SUBMIT_REVIEW_TOOL_NAME, input: "I could not comply" }] }),
  });

  assert.equal(verdict.verdict, "pass");
  assert.equal(verdict.findings.length, 0);
});

// Issue #325 wiring test: the orchestrator must tell the validator whether
// prior dialogue exists -- validate.ts's own resolution-by-citation tests
// prove the demotion logic, but they would stay green if runReview forgot to
// pass the flag, and this seam is exactly where that bug would live. Defect
// caught: a runReview that always validates as if round one, which would let
// an unengaged re-asserted block keep blocking forever despite a green
// validate suite.
test("runReview: with prior dialogue in the context, a blocking finding without deliberation resolves instead of blocking", async () => {
  const withDialogue: ReviewContext = {
    ...context,
    conversation: "dev-agent (2026-08-26T00:00:00Z): Disagree — the alternate satisfies criterion 1; here is why.",
  };
  const verdict = await runReview({
    config,
    context: withDialogue,
    credentials,
    completeFn: async () => response({ toolCalls: [validBlockingCall] }),
  });

  assert.equal(verdict.verdict, "pass");
  assert.equal(verdict.findings[0]?.resolvedByDefault, true);
});

// End-to-end positive control through the orchestrator: a real, evidenced
// blocking finding survives the whole path and blocks. Defect caught: a
// validate/orchestrate seam that drops findings -- which would make every test
// above satisfiable while the gate could never actually fail a pull request.
test("runReview: a valid blocking finding survives orchestration and blocks", async () => {
  const verdict = await runReview({
    config,
    context,
    credentials,
    completeFn: async () => response({ toolCalls: [validBlockingCall] }),
  });

  assert.equal(verdict.verdict, "block");
  assert.equal(verdict.findings.length, 1);
  assert.equal(verdict.findings[0]?.citation, "AGENTS.md > Test quality");
});

// Issue #354 follow-up. Behavior protected: the builder identity the config
// resolved reaches the REQUEST -- the object actually handed to the client --
// rather than stopping at a log line and a workflow env block. Defect caught:
// a `resolveConfig` that validates provider separation and then discards the
// values, which leaves the gate unable to state after the fact whose work it
// judged. The fixture's builder pair is deliberately distinct from the
// reviewer pair on both axes, so a wiring bug that copies the reviewer's own
// provider/model into the provenance slot cannot pass.
//
// It rides on `metadata`, not in the prompt, on purpose: `metadata` is
// `@hyperbolic/llm`'s caller-side logging spine and is never transmitted, so
// this records provenance without telling an adversarial reviewer who wrote
// the code -- which would invite exactly the authorship-based reasoning the
// system prompt forbids.
test("buildReviewRequest: the request carries the builder identity as provenance", () => {
  const request: LlmRequest = buildReviewRequest(config, context);

  assert.deepEqual(request.metadata.provenance, {
    provider: "anthropic",
    model: "a-specific-builder-model-id",
  });
  assert.equal(request.provider, "openai", "the request still targets the REVIEWER");
  assert.equal(request.model, "a-specific-model-id");
});

// The same claim asserted where it actually matters: on the request the client
// receives. buildReviewRequest is pure and exported, so a test against it
// alone would stay green if runReview stopped calling it or rebuilt the
// request itself.
test("runReview: the request handed to the client carries the builder identity", async () => {
  let seen: LlmRequest | undefined;
  await runReview({
    config,
    context,
    credentials,
    completeFn: async (request) => {
      seen = request;
      return response({ toolCalls: [validBlockingCall] });
    },
  });

  assert.ok(seen !== undefined, "the client must have been called");
  assert.deepEqual((seen as LlmRequest).metadata.provenance, {
    provider: "anthropic",
    model: "a-specific-builder-model-id",
  });
});
