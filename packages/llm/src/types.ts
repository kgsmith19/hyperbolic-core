/**
 * Provider-agnostic contract for `@hyperbolic/llm`.
 *
 * Verbatim from docs/planning/08-llm-handlers.md section 4 (Provider, LlmRequest,
 * LlmResponse, LlmDelta, LlmError) plus the `fallback` field called out in that
 * section's prose but not its type sample. `Message` / `ToolDef` / `ToolCall` /
 * `ToolCallDelta` are referenced there but not shown -- designed here to be
 * provider-agnostic while covering what Anthropic's Messages API needs
 * (system/user/assistant roles, tool_use/tool_result content blocks, JSON
 * Schema tool definitions). OpenAI and Gemini drivers (m4-02) implement
 * against these same types; nothing here is Anthropic-specific.
 *
 * This package never touches API keys. See Credentials below: every call
 * takes credentials in explicitly, and nothing in this file (or anywhere
 * else under src/) reads a provider key from the environment, defaults one,
 * or has a place to persist one.
 */

export type Provider = "anthropic" | "openai" | "gemini";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Plain text content. */
export interface TextPart {
  type: "text";
  text: string;
}

/** An assistant-issued request to call a tool. */
export interface ToolUsePart {
  type: "tool_use";
  /** Provider-issued call id; echoed back on the matching ToolResultPart. */
  id: string;
  name: string;
  /** Parsed tool-call arguments (already JSON-decoded). */
  input: unknown;
}

/** The caller's answer to a prior ToolUsePart, sent back to the model. */
export interface ToolResultPart {
  type: "tool_result";
  /** Matches the ToolUsePart.id this is answering. */
  toolUseId: string;
  content: string | TextPart[];
  isError?: boolean;
}

export type MessagePart = TextPart | ToolUsePart | ToolResultPart;

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string | MessagePart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | MessagePart[];
}

/**
 * A tool-result turn. Anthropic has no wire-level "tool" role -- tool
 * results ride inside a `user`-role message on that provider -- but modeling
 * it as its own role here keeps the contract provider-agnostic (OpenAI does
 * have a distinct tool role) and keeps that mapping the driver's job, not
 * every caller's.
 */
export interface ToolMessage {
  role: "tool";
  content: ToolResultPart[];
}

/** system/user/assistant/tool parts, per 08-llm-handlers.md section 4. */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A JSON Schema object. Not modeled further: the provider validates it. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

export type ToolChoice = "auto" | "none" | { name: string };

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Partial tool-call data as it streams in, keyed by content-block `index` so
 * concurrent tool calls in one response can be told apart. Consumers
 * accumulate `inputJsonDelta` fragments by index and `JSON.parse` once the
 * call is complete -- signaled by the response's "done" delta, which carries
 * the already-parsed `ToolCall.input` for every call.
 */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  inputJsonDelta?: string;
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

/** Logging spine (08-llm-handlers.md section 6). This package does not log;
 * it only carries the fields through so a caller-owned logger can. */
export interface LlmRequestMetadata {
  callerApp: string;
  purpose: string;
  runRef?: string;
}

export interface FallbackTarget {
  provider: Provider;
  model: string;
}

export interface LlmRequest {
  provider: Provider;
  model: string; // never defaulted silently
  messages: Message[]; // system/user/assistant/tool parts
  tools?: ToolDef[]; // JSON Schema per tool
  toolChoice?: ToolChoice;
  maxTokens: number;
  temperature?: number;
  stream?: boolean;
  metadata: LlmRequestMetadata; // logging spine
  timeoutMs: number; // hard wall per attempt
  /**
   * Explicit-only cross-provider fallback (08-llm-handlers.md section 4,
   * prose only -- not in the shown interface). The library fails over to
   * the next entry only on retryable-exhaustion of the previous one, and
   * never when `tools` is present: see assertNoFallbackWithTools in
   * complete.ts, which rejects that combination before the primary call is
   * even attempted.
   */
  fallback?: FallbackTarget[];
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  provider: Provider;
  model: string;
  latencyMs: number;
}

// Streaming contract: an async iterable of typed deltas. There is no
// "error" delta kind -- a mid-stream failure (including the 60s stall
// timeout) is communicated by throwing the LlmError out of the async
// iterator, not by yielding one. `for await` consumers should wrap
// iteration in try/catch.
export type LlmDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; partial: ToolCallDelta }
  | { kind: "usage"; usage: Usage }
  | { kind: "done"; response: LlmResponse };

export type LlmErrorClass =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "transport"
  | "invalid_request"
  | "content_policy"
  | "provider_bug";

export interface LlmError extends Error {
  class: LlmErrorClass;
  retryable: boolean; // true only for rate_limit | overloaded | transport
  retryAfterMs?: number; // honored when the provider sends it
}

// ---------------------------------------------------------------------------
// Credentials -- the ONLY place a key enters this package, per call.
// ---------------------------------------------------------------------------

export interface Credentials {
  apiKey: string;
  /** Optional override (proxy, test double). Never defaulted. */
  baseUrl?: string;
}

/** One credential per provider a request (or its fallback chain) might hit. */
export type CredentialsByProvider = Partial<Record<Provider, Credentials>>;
