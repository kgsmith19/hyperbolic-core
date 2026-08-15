/**
 * The HTTP-status half of error classification, shared by all three drivers.
 *
 * These four rules are plain HTTP semantics and were byte-identical in every
 * driver. What is NOT here is each provider's own quirks, which stay at the
 * top of that driver's own classifier because they genuinely differ:
 *
 *   anthropic  529 -> overloaded  (an Anthropic-specific status)
 *   gemini     401/403 -> auth    (the SDK surfaces auth failures this way)
 *   openai,
 *   gemini     408 -> transport
 *
 * 408 in particular must not move in here. Anthropic deliberately does not
 * special-case it, so under this table its 408 lands on invalid_request --
 * and a request timeout that reclassified itself as retryable transport for
 * one provider but not another would be a behavior change, not a cleanup.
 */
import type { LlmErrorClass } from "../types.ts";

export function classifyHttpStatus(status: number): LlmErrorClass {
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transport";
  if (status >= 400) return "invalid_request";
  return "provider_bug";
}
