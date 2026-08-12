import type { Credentials, LlmDelta, LlmRequest, LlmResponse, Provider } from "../types.ts";

/**
 * What every provider driver implements. `packages/llm` ships only
 * `anthropicDriver` (this issue); m4-02 adds OpenAI and Gemini drivers
 * against this same interface -- nothing here is Anthropic-specific.
 *
 * A driver call is a single attempt: no retry, no fallback, no key
 * persistence. Retry/backoff/fallback live one layer up, in complete.ts,
 * which is what lets every driver share one retry engine instead of each
 * reimplementing it. `credentials` is a plain function argument -- it is
 * never stored on the driver object or any module-level state, so nothing
 * outlives the call.
 */
export interface LlmDriver {
  readonly provider: Provider;
  complete(request: LlmRequest, credentials: Credentials): Promise<LlmResponse>;
  stream(request: LlmRequest, credentials: Credentials): AsyncGenerator<LlmDelta, void, unknown>;
}
