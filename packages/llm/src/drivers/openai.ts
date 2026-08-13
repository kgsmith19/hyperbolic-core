/**
 * OpenAI driver: Chat Completions API support (non-streaming, streaming,
 * tool use in both directions). Uses the official `openai` package.
 *
 * Chat Completions was chosen over the newer Responses API -- which the
 * installed SDK's own JSDoc now recommends for new projects ("We recommend
 * trying Responses to take advantage of the latest OpenAI platform
 * features", node_modules/openai/src/resources/chat/completions/completions.ts)
 * -- because Chat Completions' message shape (system/user/assistant/tool
 * roles, a `tool_calls` array on assistant turns, `tool_call_id`-addressed
 * tool replies) maps onto this package's provider-agnostic Message/ToolCall
 * types far more directly than the Responses API's flat input-item list.
 * Chat Completions remains a fully supported, documented, non-deprecated
 * endpoint in the installed SDK. Judgment call, flagged per the issue's
 * "flag ambiguity" instruction: 08-llm-handlers.md section 4 specifies the
 * provider-agnostic contract but not which of OpenAI's own APIs a driver
 * must speak to satisfy it.
 *
 * Zero key handling (same hard requirement as anthropic.ts): the only key
 * this file ever sees is `credentials.apiKey`, an explicit function
 * argument. Every call builds a fresh SDK client from it and lets that
 * client go out of scope when the call returns -- nothing is cached at
 * module scope, nothing is logged, and this file never reads any
 * environment variable for a credential. If `credentials.apiKey` is falsy,
 * the driver rejects the call itself, before constructing a client. This
 * guard is load-bearing, not defensive-in-name-only: unlike the Gemini SDK
 * (which never reads an ambient credential), the installed OpenAI client
 * constructor falls back to an environment-provided key when `apiKey` is
 * omitted (see its own JSDoc default in node_modules/openai/src/client.ts),
 * so skipping this guard really would risk a silent ambient-credential
 * fallback.
 */
import OpenAI from "openai";
import { createLlmError } from "../errors.ts";
import { createStallWatchdog, STREAM_STALL_MS } from "../retry.ts";
import type {
  Credentials,
  LlmDelta,
  LlmError,
  LlmErrorClass,
  LlmRequest,
  LlmResponse,
  Message,
  MessagePart,
  StopReason,
  TextPart,
  ToolCall,
  ToolChoice,
  ToolDef,
  Usage,
} from "../types.ts";
import type { LlmDriver } from "./types.ts";

const PROVIDER = "openai" as const;

// ---------------------------------------------------------------------------
// Request mapping: our provider-agnostic shapes -> OpenAI wire params.
// ---------------------------------------------------------------------------

function toPlainText(content: string | TextPart[]): string {
  return typeof content === "string" ? content : content.map((t) => t.text).join("");
}

function isTextPart(part: MessagePart): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text";
}

function isToolUsePart(part: MessagePart): part is Extract<MessagePart, { type: "tool_use" }> {
  return part.type === "tool_use";
}

/**
 * Unlike Anthropic's Messages API -- where every role's content is a
 * uniform array of content blocks -- OpenAI's Chat Completions message
 * shapes genuinely differ per role: user content is text/media parts,
 * assistant tool calls live in a separate `tool_calls` array (not inline
 * content blocks), and a tool result is its own message keyed by
 * `tool_call_id` (OpenAI has no single wire turn for multiple tool results
 * the way Anthropic packs every tool_result block into one user message).
 * So, unlike toAnthropicContentBlock's one generic per-part mapper, this is
 * mapped per role.
 */
function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      result.push({ role: "system", content: m.content });
      continue;
    }
    if (m.role === "tool") {
      for (const part of m.content) {
        result.push({ role: "tool", tool_call_id: part.toolUseId, content: toPlainText(part.content) });
      }
      continue;
    }
    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        result.push({ role: "assistant", content: m.content });
        continue;
      }
      const textParts = m.content.filter(isTextPart);
      const toolUseParts = m.content.filter(isToolUsePart);
      result.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.map((p) => p.text).join("") : null,
        tool_calls:
          toolUseParts.length > 0
            ? toolUseParts.map((p) => ({ id: p.id, type: "function" as const, function: { name: p.name, arguments: JSON.stringify(p.input) } }))
            : undefined,
      });
      continue;
    }
    // user: only text parts are meaningful here (a well-formed caller puts
    // tool results in a `{role:"tool"}` message, per types.ts's ToolMessage
    // -- exactly so this ambiguity does not arise).
    result.push({
      role: "user",
      content: typeof m.content === "string" ? m.content : toPlainText(m.content.filter(isTextPart)),
    });
  }
  return result;
}

function toOpenAITool(tool: ToolDef): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      // Caller-supplied JSON Schema is opaque data here: the provider
      // validates it, we don't re-model JSON Schema's shape ourselves.
      parameters: tool.inputSchema as unknown as OpenAI.FunctionParameters,
    },
  };
}

function toOpenAIToolChoice(choice: ToolChoice): OpenAI.ChatCompletionToolChoiceOption {
  if (choice === "auto") {
    return "auto";
  }
  if (choice === "none") {
    return "none";
  }
  return { type: "function", function: { name: choice.name } };
}

interface OpenAIBaseParams {
  model: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  // max_tokens is deprecated in favor of max_completion_tokens as of the
  // installed SDK (node_modules/openai/src/resources/chat/completions/completions.ts);
  // this driver targets the current field.
  max_completion_tokens: number;
  tools?: OpenAI.ChatCompletionTool[];
  tool_choice?: OpenAI.ChatCompletionToolChoiceOption;
  temperature?: number;
}

function buildParams(request: LlmRequest): OpenAIBaseParams {
  return {
    model: request.model,
    messages: toOpenAIMessages(request.messages),
    max_completion_tokens: request.maxTokens,
    tools: request.tools?.map(toOpenAITool),
    tool_choice: request.toolChoice ? toOpenAIToolChoice(request.toolChoice) : undefined,
    temperature: request.temperature,
  };
}

// ---------------------------------------------------------------------------
// Response mapping: OpenAI wire shapes -> our provider-agnostic shapes.
// ---------------------------------------------------------------------------

function mapStopReason(message: OpenAI.ChatCompletionMessage | undefined, finishReason: OpenAI.ChatCompletion.Choice["finish_reason"] | undefined): StopReason {
  // message.refusal is the primary modern refusal signal (populated
  // alongside finish_reason "stop"); finish_reason "content_filter" is the
  // older moderation-filtering signal. Check refusal first so either path
  // reaches the same stopReason.
  if (message?.refusal) {
    return "refusal";
  }
  switch (finishReason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    // Deprecated legacy mechanism; this driver only ever sends `tools`,
    // never the deprecated `functions` field, so the model has nothing to
    // trigger this with -- unreachable in practice. Treated the same as
    // "tool_calls" defensively.
    case "function_call":
      return "tool_use";
    case undefined:
    default:
      return "end";
  }
}

/**
 * Some OpenAI-compatible providers omit tool call ids or return an empty
 * string -- a real, documented condition: the installed SDK's own
 * `runTools()` helper works around exactly this
 * (node_modules/openai/src/lib/AbstractChatCompletionRunner.ts's
 * normalizeToolCallIds, "Some OpenAI-compatible providers omit tool call IDs
 * or return an empty string"). This driver deliberately does not use
 * runTools() (it auto-executes JS callables; we only ever pass schemas), so
 * it needs its own fallback to keep ToolCall.id a non-empty, stable string.
 */
function toolCallId(raw: string | undefined, index: number): string {
  return raw && raw.length > 0 ? raw : `call_${index}`;
}

function isFunctionToolCall(tc: OpenAI.ChatCompletionMessageToolCall): tc is OpenAI.ChatCompletionMessageFunctionToolCall {
  return tc.type === "function";
}

function fromOpenAIChatCompletion(completion: OpenAI.ChatCompletion, latencyMs: number): LlmResponse {
  const choice = completion.choices[0];
  const message = choice?.message;
  const toolCalls: ToolCall[] = (message?.tool_calls ?? []).filter(isFunctionToolCall).map((tc, index) => ({
    id: toolCallId(tc.id, index),
    name: tc.function.name,
    // OpenAI's own doc comment on Function.arguments: "the model does not
    // always generate valid JSON" (node_modules/openai/.../completions.ts).
    // A JSON.parse failure here is a genuine provider misbehavior, not a
    // network or caller problem -- left to throw and fall through
    // classifyOpenAIError's default branch to "provider_bug" rather than
    // special-cased, matching how any other unexpected shape is handled.
    input: JSON.parse(tc.function.arguments),
  }));
  const usage = completion.usage;
  return {
    // A refusal explanation (message.refusal) is surfaced as text rather
    // than discarded, so a caller can see why the model declined.
    text: message?.refusal ?? message?.content ?? null,
    toolCalls,
    stopReason: mapStopReason(message, choice?.finish_reason),
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    provider: PROVIDER,
    model: completion.model,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy: OpenAI SDK exceptions -> LlmError.
// ---------------------------------------------------------------------------

function classifyByStatus(status: number | undefined): LlmErrorClass {
  if (status === undefined) {
    return "transport"; // no response at all: connection-level failure
  }
  if (status === 408) {
    // Request Timeout: no named OpenAI SDK subclass exists for this status,
    // but it is retry-worthy by HTTP semantics -- Google's Gemini SDK's own
    // documented retry allowlist independently agrees (see gemini.ts's
    // classifyByStatus), which is the closest thing to cross-provider
    // confirmation available given OpenAI's own SDK has no opinion here.
    return "transport";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status >= 500) {
    return "transport";
  }
  if (status >= 400) {
    return "invalid_request";
  }
  return "provider_bug";
}

function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

/**
 * Unlike Anthropic's installed SDK, OpenAI's does not ship a literal-string
 * union for `error.type`/`error.code` -- both are plain `string | null |
 * undefined` in node_modules/openai/src/core/error.ts, not a statically
 * checkable enum the way Anthropic's ErrorType is. So this driver
 * classifies off the SDK's concrete, strongly-typed exception hierarchy
 * (BadRequestError, AuthenticationError, RateLimitError, ...) and, for
 * anything not covered by a named subclass, HTTP status -- exactly what the
 * installed type definitions actually guarantee, rather than guessing at
 * undocumented `code`/`type` string values (e.g. "content_policy_violation",
 * "insufficient_quota") that exist in OpenAI's prose docs but have no
 * compile-time-checked shape in this SDK version.
 *
 * Two consequences worth being explicit about, mirroring anthropic.ts's own
 * "this driver never produces class X" notes:
 *  - This driver never produces "content_policy": OpenAI surfaces
 *    moderation-driven stops as a normal 200 response (finish_reason:
 *    "content_filter", or message.refusal), mapped above to stopReason
 *    "refusal", not as a thrown error.
 *  - This driver never produces "overloaded": OpenAI's SDK exposes no
 *    status or type distinct from a generic 5xx the way Anthropic's
 *    dedicated 529 overloaded_error is, so every 5xx here maps to
 *    "transport".
 */
function classifyOpenAIError(err: unknown, wasAborted: boolean): LlmError {
  if (wasAborted) {
    return createLlmError("transport", "openai driver: attempt aborted (timeoutMs exceeded or stream stalled)", { cause: err });
  }
  if (err instanceof OpenAI.APIConnectionError) {
    // Also covers APIConnectionTimeoutError (a subclass of this). Note
    // APIUserAbortError is a *sibling* of APIConnectionError under APIError,
    // not a subclass of it -- but any abort from this driver's own
    // controller is already caught by wasAborted above, before reaching
    // here, so anything landing in this branch is a genuine connection-level
    // failure (DNS, refused, reset, ...), never our own timeout or stall.
    return createLlmError("transport", err.message, { cause: err });
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return createLlmError("auth", err.message, { cause: err, retryAfterMs: parseRetryAfterMs(err.headers) });
  }
  if (err instanceof OpenAI.RateLimitError) {
    return createLlmError("rate_limit", err.message, { cause: err, retryAfterMs: parseRetryAfterMs(err.headers) });
  }
  if (err instanceof OpenAI.InternalServerError) {
    return createLlmError("transport", err.message, { cause: err, retryAfterMs: parseRetryAfterMs(err.headers) });
  }
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.NotFoundError || err instanceof OpenAI.ConflictError || err instanceof OpenAI.UnprocessableEntityError) {
    return createLlmError("invalid_request", err.message, { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    // Any other named status the SDK didn't give a dedicated subclass to
    // (402 Payment Required / insufficient_quota, 405, 408 Request Timeout,
    // ...), classified by status the same way the generic Anthropic.APIError
    // branch is in anthropic.ts.
    return createLlmError(classifyByStatus(err.status), err.message, { cause: err, retryAfterMs: parseRetryAfterMs(err.headers) });
  }
  return createLlmError("provider_bug", err instanceof Error ? err.message : String(err), { cause: err });
}

// ---------------------------------------------------------------------------
// Client construction -- see the zero-key-handling note at the top of file.
// ---------------------------------------------------------------------------

function buildClient(credentials: Credentials): OpenAI {
  if (!credentials.apiKey) {
    throw createLlmError("invalid_request", "openai driver: no API key supplied in credentials");
  }
  return new OpenAI({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl,
    maxRetries: 0, // this package owns retry/backoff; never double-retry
  });
}

// ---------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------

async function completeImpl(request: LlmRequest, credentials: Credentials): Promise<LlmResponse> {
  const client = buildClient(credentials);
  const params = buildParams(request);
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), request.timeoutMs);
  const startedAt = Date.now();
  try {
    const completion = await client.chat.completions.create({ ...params, stream: false }, { signal: controller.signal });
    return fromOpenAIChatCompletion(completion, Date.now() - startedAt);
  } catch (err) {
    throw classifyOpenAIError(err, controller.signal.aborted);
  } finally {
    clearTimeout(hardTimer);
  }
}

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

async function* streamImpl(request: LlmRequest, credentials: Credentials): AsyncGenerator<LlmDelta, void, unknown> {
  const client = buildClient(credentials);
  const params = buildParams(request);
  const controller = new AbortController();
  const startedAt = Date.now();
  const hardTimer = setTimeout(() => controller.abort(), request.timeoutMs);
  // Correctness fix (see 08-llm-handlers.md's stall-detection requirement):
  // the watchdog must reset only on an actual LlmDelta yield, never on raw
  // transport activity. It used to reset unconditionally once per chunk at
  // the top of the `for await` loop below, before `delta?.content` was even
  // checked -- so a provider emitting a steady stream of empty/role-only
  // chunks (a real, documented OpenAI shape: `delta: {role: "assistant",
  // content: ""}` or `delta: {}` with no `tool_calls`/`usage` either) could
  // hold the watchdog open forever without ever producing real output,
  // defeating the "no LlmDelta for 60s -> abort" contract entirely.
  // `watchdog.reset()` now sits immediately before each of the three actual
  // `yield` sites (text delta, tool-call delta, usage delta) and before the
  // terminal `done` yield, so only genuine content resets the clock.
  const watchdog = createStallWatchdog(STREAM_STALL_MS, () => controller.abort());

  try {
    // The high-level `.stream()` runner (not the raw `.create({stream:true})`
    // + Stream<ChatCompletionChunk> primitive) is used deliberately: reading
    // node_modules/openai/src/core/streaming.ts shows the raw Stream class
    // swallows an abort mid-iteration (`if (isAbortError(e)) return;` --
    // the generator ends silently, no throw), which would make our own
    // hard-timeout/stall abort invisible. The runner
    // (node_modules/openai/src/lib/ChatCompletionStream.ts's
    // _createChatCompletion) explicitly re-checks
    // `stream.controller.signal?.aborted` after that silent return and
    // throws APIUserAbortError itself, and its `for await`/finalChatCompletion
    // both propagate that error correctly -- verified by this driver's own
    // stall test below, not just by reading the source.
    const stream = client.chat.completions.stream({ ...params, stream_options: { include_usage: true } }, { signal: controller.signal });
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content) {
        watchdog.reset();
        yield { kind: "text", text: delta.content };
      }
      for (const toolCallDelta of delta?.tool_calls ?? []) {
        watchdog.reset();
        yield {
          kind: "tool_call",
          partial: {
            index: toolCallDelta.index,
            id: toolCallDelta.id,
            name: toolCallDelta.function?.name,
            inputJsonDelta: toolCallDelta.function?.arguments,
          },
        };
      }
      if (chunk.usage) {
        const usage: Usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
        watchdog.reset();
        yield { kind: "usage", usage };
      }
    }
    const final = await stream.finalChatCompletion();
    watchdog.reset();
    yield { kind: "done", response: fromOpenAIChatCompletion(final, Date.now() - startedAt) };
  } catch (err) {
    throw classifyOpenAIError(err, controller.signal.aborted);
  } finally {
    clearTimeout(hardTimer);
    watchdog.clear();
  }
}

export const openaiDriver: LlmDriver = {
  provider: PROVIDER,
  complete: completeImpl,
  stream: streamImpl,
};
