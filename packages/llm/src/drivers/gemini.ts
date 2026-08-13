/**
 * Gemini driver: `models.generateContent`/`generateContentStream` support
 * (non-streaming, streaming, tool use in both directions). Uses the current
 * official `@google/genai` package -- the actively-maintained SDK (weekly
 * releases; version installed here published days before this driver was
 * written). The older `@google/generative-ai` package is deprecated
 * upstream and was deliberately not used.
 *
 * Zero key handling (same hard requirement as anthropic.ts): the only key
 * this file ever sees is `credentials.apiKey`, an explicit function
 * argument. Every call builds a fresh SDK client from it; nothing is cached
 * at module scope, logged, or read from an environment variable. If
 * `credentials.apiKey` is falsy, the driver rejects before constructing a
 * client. Verified in node_modules/@google/genai/dist/index.mjs's ApiClient
 * constructor: in plain Gemini API mode (this driver never sets `vertexai`),
 * a missing apiKey only logs `console.warn` and otherwise proceeds -- unlike
 * the OpenAI SDK, it never reads an environment variable as an ambient
 * fallback -- so this guard exists purely to fail fast and loud rather than
 * to close an ambient-credential leak the way it does for openai.ts.
 *
 * No SDK-level retry to disable, unlike Anthropic's/OpenAI's `maxRetries: 0`:
 * reading node_modules/@google/genai/dist/index.mjs's ApiClient.apiCall
 * shows internal retry only activates when the caller explicitly supplies
 * `httpOptions.retryOptions` (`if (!retryOptions) { return runFetch(); }` --
 * a single attempt, no retry loop, when it is omitted). This driver never
 * sets it, which is the equivalent of every other driver's `maxRetries: 0`.
 */
import { ApiError, FinishReason, FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import type { Content, FunctionCall, FunctionDeclaration, GenerateContentConfig, GenerateContentResponse, Part, ToolConfig } from "@google/genai";
import { createLlmError, isLlmError } from "../errors.ts";
import { createStallWatchdog, STREAM_STALL_MS } from "../retry.ts";
import { createAttemptController } from "./abort.ts";
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

const PROVIDER = "gemini" as const;

// ---------------------------------------------------------------------------
// Request mapping: our provider-agnostic shapes -> Gemini wire params.
// ---------------------------------------------------------------------------

function toPlainText(content: string | TextPart[]): string {
  return typeof content === "string" ? content : content.map((t) => t.text).join("");
}

function isTextPart(part: MessagePart): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text";
}

function toGeminiSystemInstruction(messages: Message[]): string | undefined {
  const parts = messages.filter((m): m is Extract<Message, { role: "system" }> => m.role === "system").map((m) => m.content);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Gemini's `FunctionResponse.name` is required on the wire, but our own
 * ToolResultPart -- modeled after Anthropic's tool_result, which needs no
 * name -- carries only `toolUseId`. So, unlike Anthropic/OpenAI's tool-result
 * mapping, this driver first scans the assistant turns for the ToolUsePart
 * that originally issued each id, to recover the name Gemini requires.
 */
function buildToolNameLookup(messages: Message[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") {
      continue;
    }
    for (const part of m.content) {
      if (part.type === "tool_use") {
        lookup.set(part.id, part.name);
      }
    }
  }
  return lookup;
}

/**
 * Gemini has no distinct wire-level "tool" role (same situation Anthropic is
 * in, per types.ts's own ToolMessage comment): function responses ride
 * inside a `role: "user"` Content, per the SDK's own Content.role doc
 * ("Must be either 'user' or 'model'").
 */
function toGeminiContents(messages: Message[]): Content[] {
  const toolNameByCallId = buildToolNameLookup(messages);
  const result: Content[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      continue;
    }
    if (m.role === "tool") {
      const parts: Part[] = m.content.map((part) => ({
        functionResponse: {
          id: part.toolUseId,
          name: toolNameByCallId.get(part.toolUseId) ?? part.toolUseId,
          response: part.isError ? { error: toPlainText(part.content) } : { output: toPlainText(part.content) },
        },
      }));
      result.push({ role: "user", parts });
      continue;
    }
    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        result.push({ role: "model", parts: [{ text: m.content }] });
        continue;
      }
      const parts: Part[] = m.content.map((part): Part => {
        if (part.type === "text") {
          return { text: part.text };
        }
        if (part.type === "tool_use") {
          // Tool-call arguments are always a JSON object by the
          // inputSchema:{type:"object",...} convention every ToolDef uses;
          // Gemini's FunctionCall.args is typed accordingly.
          return { functionCall: { id: part.id, name: part.name, args: part.input as Record<string, unknown> } };
        }
        // A tool_result inside an assistant-authored message is not a shape
        // this driver ever produces itself; represented as an empty text
        // part rather than silently dropping the turn.
        return { text: "" };
      });
      result.push({ role: "model", parts });
      continue;
    }
    // user
    if (typeof m.content === "string") {
      result.push({ role: "user", parts: [{ text: m.content }] });
      continue;
    }
    const textParts = m.content.filter(isTextPart);
    result.push({ role: "user", parts: textParts.length > 0 ? textParts.map((p) => ({ text: p.text })) : [{ text: "" }] });
  }
  return result;
}

function toGeminiFunctionDeclaration(tool: ToolDef): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    // Caller-supplied JSON Schema passed through opaquely (the field the SDK
    // designates for this exact purpose, mutually exclusive with its own
    // `parameters` OpenAPI-subset field): the provider validates it, we
    // don't re-model JSON Schema's shape ourselves.
    parametersJsonSchema: tool.inputSchema,
  };
}

function toGeminiToolConfig(choice: ToolChoice): ToolConfig {
  if (choice === "auto") {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
  }
  if (choice === "none") {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
  }
  return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [choice.name] } };
}

function buildConfig(request: LlmRequest, abortSignal: AbortSignal): GenerateContentConfig {
  return {
    abortSignal,
    systemInstruction: toGeminiSystemInstruction(request.messages),
    maxOutputTokens: request.maxTokens,
    temperature: request.temperature,
    tools: request.tools && request.tools.length > 0 ? [{ functionDeclarations: request.tools.map(toGeminiFunctionDeclaration) }] : undefined,
    toolConfig: request.toolChoice ? toGeminiToolConfig(request.toolChoice) : undefined,
    // We only ever pass plain schemas (FunctionDeclaration), never JS
    // callables, so the SDK has nothing it could auto-invoke regardless --
    // disabled explicitly anyway so a caller-side history/round-trip
    // decision is never silently made for us.
    automaticFunctionCalling: { disable: true },
  };
}

/**
 * Finding #83's fix: `toGeminiContents`/`buildConfig` are deterministic,
 * local mapping code -- given the same malformed `LlmRequest` shape (one
 * that has slipped past types.ts's compile-time contract, e.g. a hand-built
 * or JSON-deserialized request), they fail identically on every call. Both
 * `completeImpl` and `streamImpl` therefore run this construction step
 * *before* their own timeout timer starts and *outside* the try block that
 * wraps the real SDK call, and wrap any failure here as a non-retryable
 * `invalid_request` LlmError instead of letting it fall into
 * `classifyGeminiError`'s catch-all (which defaults anything that isn't an
 * `ApiError` to `"transport"` -- retryable, and capable of triggering
 * cross-provider fallover -- exactly wrong for a bug that will reproduce on
 * every retry).
 */
function buildRequestShape(request: LlmRequest, abortSignal: AbortSignal): { contents: Content[]; config: GenerateContentConfig } {
  try {
    return { contents: toGeminiContents(request.messages), config: buildConfig(request, abortSignal) };
  } catch (err) {
    throw createLlmError(
      "invalid_request",
      `gemini driver: failed to construct the request from LlmRequest -- this is a local mapping bug (malformed message/tool shape), not a transport failure: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Response mapping: Gemini wire shapes -> our provider-agnostic shapes.
// ---------------------------------------------------------------------------

/**
 * Gemini function calls are optionally id-carrying (unlike Anthropic/OpenAI,
 * where a call id is always present) -- "If populated, the client [uses it]
 * to execute the function_call and return the response with the matching
 * id." When absent, this driver synthesizes one so ToolCall.id stays a
 * stable, non-empty string a caller can round-trip via ToolResultPart.
 */
function toToolCall(call: FunctionCall, index: number): ToolCall {
  return {
    id: call.id && call.id.length > 0 ? call.id : `toolcall_${index}`,
    name: call.name ?? "",
    input: call.args ?? {},
  };
}

/**
 * Gemini's function-call responses arrive with `finishReason: "STOP"`, not a
 * dedicated tool-use reason the way Anthropic (`stop_reason: "tool_use"`) or
 * OpenAI (`finish_reason: "tool_calls"`) signal it -- so tool-call presence
 * is checked before finishReason at all, not derived from it.
 *
 * `blocked` covers Gemini's normal (HTTP 200, not thrown) prompt-blocked
 * response shape: `promptFeedback.blockReason` set with no candidates, its
 * exact analog of Anthropic's `stop_reason: "refusal"` and OpenAI's
 * `finish_reason: "content_filter"`/`message.refusal`. All three drivers
 * therefore share the property that "content_policy" (the LlmErrorClass) is
 * never thrown -- it is modeled in types.ts for provider-agnostic
 * completeness, not because any of the three real drivers produce it.
 *
 * MALFORMED_FUNCTION_CALL / UNEXPECTED_TOOL_CALL / TOO_MANY_TOOL_CALLS are a
 * judgment call, flagged per the issue's "flag ambiguity" instruction (no
 * source in 08-llm-handlers.md enumerates Gemini-specific finish reasons):
 * bucketed under "refusal" as the closest fit in a 4-value taxonomy for "did
 * not complete normally for a policy/behavior reason", not because they are
 * safety-flagged content.
 */
function mapStopReason(opts: { hasToolCalls: boolean; blocked: boolean; finishReason: FinishReason | undefined }): StopReason {
  if (opts.hasToolCalls) {
    return "tool_use";
  }
  if (opts.blocked) {
    return "refusal";
  }
  switch (opts.finishReason) {
    case FinishReason.STOP:
      return "end";
    case FinishReason.MAX_TOKENS:
      return "max_tokens";
    case FinishReason.SAFETY:
    case FinishReason.RECITATION:
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case FinishReason.UNEXPECTED_TOOL_CALL:
    case FinishReason.TOO_MANY_TOOL_CALLS:
      return "refusal";
    // LANGUAGE / OTHER / NO_IMAGE / IMAGE_RECITATION / IMAGE_OTHER /
    // FINISH_REASON_UNSPECIFIED / absent (still generating, or an empty
    // final chunk): no closer bucket in a 4-value taxonomy than a plain end,
    // mirroring anthropic.ts's own defensive default for its one
    // unreachable-in-practice case (pause_turn).
    default:
      return "end";
  }
}

function usageFromMetadata(usage: GenerateContentResponse["usageMetadata"]): Usage {
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
  };
}

function fromGeminiResponse(response: GenerateContentResponse, requestedModel: string, latencyMs: number): LlmResponse {
  const candidate = response.candidates?.[0];
  const blocked = (response.candidates?.length ?? 0) === 0 && response.promptFeedback?.blockReason !== undefined;
  if (!candidate && !blocked) {
    // A genuinely malformed 2xx (finding #84): Gemini's own documented
    // blocked-prompt shape (no candidates, promptFeedback.blockReason set)
    // is excluded above and left to the existing `blocked` handling below,
    // untouched -- this branch only catches the case that is neither a real
    // candidate nor a documented block, which this driver cannot interpret
    // as an empty-but-valid success. Thrown as a properly classified
    // LlmError so classifyGeminiError's isLlmError passthrough (finding #83)
    // keeps it provider_bug rather than falling into that function's own
    // "transport" default for non-ApiError exceptions.
    throw createLlmError("provider_bug", "gemini driver: response has no candidates and no promptFeedback.blockReason -- cannot be interpreted as a valid completion", { cause: response });
  }
  const parts = candidate?.content?.parts ?? [];
  const textParts = parts.filter((p) => p.text !== undefined && !p.thought);
  const functionCallParts = parts.filter((p) => p.functionCall !== undefined);
  const toolCalls = functionCallParts.map((p, index) => toToolCall(p.functionCall as FunctionCall, index));
  const text = textParts.length > 0 ? textParts.map((p) => p.text).join("") : null;
  return {
    text: blocked ? null : text,
    toolCalls,
    stopReason: mapStopReason({ hasToolCalls: toolCalls.length > 0, blocked, finishReason: candidate?.finishReason }),
    usage: usageFromMetadata(response.usageMetadata),
    provider: PROVIDER,
    model: response.modelVersion ?? requestedModel,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy: Gemini SDK exceptions -> LlmError.
// ---------------------------------------------------------------------------

function classifyByStatus(status: number): LlmErrorClass {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 408) {
    // Request Timeout: retry-worthy by HTTP semantics, and the installed
    // SDK's own retry allowlist agrees -- DEFAULT_RETRY_HTTP_STATUS_CODES in
    // dist/index.mjs lists 408 alongside 429/500/502/503/504.
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

/**
 * The installed SDK's `ApiError` (node_modules/@google/genai/dist/genai.d.ts)
 * carries only `{status: number, message: string}` -- no `type`/`code`
 * field at all, unlike Anthropic's literal-typed ErrorType or even OpenAI's
 * untyped-but-present `code`/`type` strings. So classification here is
 * status-code-only; there is no finer signal to key off of.
 *
 * A deliberate divergence from anthropic.ts's fallback default
 * ("provider_bug" for anything not a recognized SDK exception): this
 * driver's own default is "transport", not "provider_bug". Reason, verified
 * in source, not guessed: unlike Anthropic's `APIConnectionError` and
 * OpenAI's `APIConnectionError`/`APIConnectionTimeoutError`, `@google/genai`
 * has no dedicated wrapper class for a genuine network-layer failure (DNS,
 * connection refused/reset, TLS) -- its own fetch wrapper re-throws such
 * failures unwrapped (dist/index.mjs's apiCall/runFetch:
 * `catch (e) { attempt.dispose(); throw e; }`). Falling through to
 * "provider_bug" here -- as would exactly mirror anthropic.ts's structure --
 * would misclassify the single most common transient failure mode as
 * non-retryable and silently break fail-over for it. "transport" and
 * "provider_bug" only carry identical retry semantics for the other two
 * drivers because each of *their* SDKs already wraps real network failures
 * into a dedicated, matchable class before ever reaching that default.
 *
 * This driver never produces "overloaded": Gemini's ApiError exposes no
 * status/type distinct from a generic 5xx the way Anthropic's dedicated 529
 * overloaded_error is (the SDK's own retry-status allowlist --
 * DEFAULT_RETRY_HTTP_STATUS_CODES in dist/index.mjs -- lists 500/502/503/504
 * unified, drawing no such line), so every 5xx here maps to "transport".
 * Flagged per the issue's "flag ambiguity" instruction: Gemini is
 * well-known, informally, to return 503 for "model overloaded", which would
 * arguably fit "overloaded" better -- but nothing in the installed types
 * grounds that distinction, and since both classes retry identically, the
 * conservative status-only mapping was chosen instead of guessing.
 */
function classifyGeminiError(err: unknown, wasAborted: boolean): LlmError {
  // A local construction/serialization guard (buildRequestShape, or the
  // stream loop's own JSON.stringify guard below) has already produced a
  // correctly-classed, non-retryable LlmError -- trust it verbatim rather
  // than re-wrapping it here, which would otherwise fall through to the
  // "transport" default below and undo the whole point of classifying it
  // early (see finding #83).
  if (isLlmError(err)) {
    return err;
  }
  if (wasAborted) {
    // Same controller now also fires on a caller-supplied LlmRequest.signal
    // (finding #87, see createAttemptController) as well as the pre-existing
    // timeoutMs/stream-stall triggers -- see anthropic.ts's identical note.
    return createLlmError("transport", "gemini driver: attempt aborted (timeoutMs exceeded, stream stalled, or a caller-supplied AbortSignal fired)", { cause: err });
  }
  if (err instanceof ApiError) {
    return createLlmError(classifyByStatus(err.status), err.message, { cause: err });
  }
  return createLlmError("transport", err instanceof Error ? err.message : String(err), { cause: err });
}

// ---------------------------------------------------------------------------
// Client construction -- see the zero-key-handling note at the top of file.
// ---------------------------------------------------------------------------

function buildClient(credentials: Credentials): GoogleGenAI {
  if (!credentials.apiKey) {
    throw createLlmError("invalid_request", "gemini driver: no API key supplied in credentials");
  }
  return new GoogleGenAI({
    apiKey: credentials.apiKey,
    httpOptions: credentials.baseUrl ? { baseUrl: credentials.baseUrl } : undefined,
  });
}

// ---------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------

async function completeImpl(request: LlmRequest, credentials: Credentials): Promise<LlmResponse> {
  const client = buildClient(credentials);
  const { controller, hardTimer, cleanup } = createAttemptController(request);
  const startedAt = Date.now();
  try {
    const { contents, config } = buildRequestShape(request, controller.signal);
    const response = await client.models.generateContent({ model: request.model, contents, config });
    return fromGeminiResponse(response, request.model, Date.now() - startedAt);
  } catch (err) {
    throw classifyGeminiError(err, controller.signal.aborted);
  } finally {
    clearTimeout(hardTimer);
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

/**
 * Unlike Anthropic's `.finalMessage()` or OpenAI's `.finalChatCompletion()`,
 * the installed SDK's bare `models.generateContentStream()` has no
 * aggregation helper of its own (its only built-in accumulator lives on the
 * higher-level `Chat` class, which this driver does not use). So this driver
 * hand-accumulates the final LlmResponse from the stream's own chunks. Each
 * chunk carries new content only, not a cumulative snapshot -- verified from
 * the SDK's own Chat.recordHistory, which pushes every chunk's `.content`
 * onto a growing history array rather than replacing a running one
 * (dist/index.mjs's Chat.processStreamResponse/recordHistory). Function-call
 * arguments are never split across chunks either: `streamFunctionCallArguments`
 * on FunctionCallingConfig is explicitly "not supported in Gemini API" per
 * its own doc comment, so each functionCall Part arrives whole in one chunk.
 */
async function* streamImpl(request: LlmRequest, credentials: Credentials): AsyncGenerator<LlmDelta, void, unknown> {
  const client = buildClient(credentials);
  const startedAt = Date.now();
  const { controller, hardTimer, cleanup } = createAttemptController(request);
  // Correctness fix (see 08-llm-handlers.md's stall-detection requirement):
  // the watchdog must reset only on an actual LlmDelta yield, never on raw
  // transport activity. It used to reset unconditionally once per chunk at
  // the top of the `for await` loop below, before `candidate.content?.parts`
  // was even iterated -- so a provider emitting a steady stream of
  // metadata-only chunks (a real, documented Gemini shape: a bare
  // `{modelVersion}` heartbeat, or a candidate whose `content.parts` is
  // empty) could hold the watchdog open forever without ever producing real
  // output, defeating the "no LlmDelta for 60s -> abort" contract entirely.
  // `watchdog.reset()` now sits immediately before each of the three actual
  // `yield` sites (usage delta, tool-call delta, text delta) and before the
  // terminal `done` yield, so only genuine content resets the clock.
  const watchdog = createStallWatchdog(STREAM_STALL_MS, () => controller.abort());

  let text = "";
  const toolCalls: ToolCall[] = [];
  let finishReason: FinishReason | undefined;
  let blocked = false;
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let modelVersion: string | undefined;
  let toolCallIndex = 0;
  let sawCandidate = false;

  try {
    const { contents, config } = buildRequestShape(request, controller.signal);
    const stream = await client.models.generateContentStream({ model: request.model, contents, config });
    for await (const chunk of stream) {
      if (chunk.modelVersion) {
        modelVersion = chunk.modelVersion;
      }
      if (chunk.usageMetadata) {
        usage = usageFromMetadata(chunk.usageMetadata);
        watchdog.reset();
        yield { kind: "usage", usage };
      }
      if (chunk.promptFeedback?.blockReason) {
        blocked = true;
      }
      const candidate = chunk.candidates?.[0];
      if (!candidate) {
        continue;
      }
      sawCandidate = true;
      if (candidate.finishReason) {
        finishReason = candidate.finishReason;
      }
      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall) {
          const call = toToolCall(part.functionCall, toolCallIndex);
          toolCalls.push(call);
          // Serialization, like buildRequestShape above, is local mapping
          // work, not a transport concern -- a failure here (e.g. a
          // non-JSON-serializable value slipping through as `call.input`)
          // must not be classified/retried as transport noise either (see
          // finding #83). Guarded independently of the outer try/catch's
          // classifyGeminiError so it gets its own non-retryable class
          // rather than falling into the catch-all default.
          let inputJsonDelta: string;
          try {
            inputJsonDelta = JSON.stringify(call.input);
          } catch (err) {
            throw createLlmError(
              "invalid_request",
              `gemini driver: failed to serialize a tool call's arguments to JSON -- this is a local mapping bug, not a transport failure: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
          watchdog.reset();
          yield { kind: "tool_call", partial: { index: toolCallIndex, id: call.id, name: call.name, inputJsonDelta } };
          toolCallIndex++;
        } else if (part.text !== undefined && !part.thought) {
          text += part.text;
          watchdog.reset();
          yield { kind: "text", text: part.text };
        }
      }
    }
    if (!sawCandidate && !blocked) {
      throw createLlmError("provider_bug", "gemini driver: stream ended with no candidates and no promptFeedback.blockReason", {
        cause: { modelVersion, usage },
      });
    }
    const response: LlmResponse = {
      text: blocked ? null : text.length > 0 ? text : null,
      toolCalls,
      stopReason: mapStopReason({ hasToolCalls: toolCalls.length > 0, blocked, finishReason }),
      usage,
      provider: PROVIDER,
      model: modelVersion ?? request.model,
      latencyMs: Date.now() - startedAt,
    };
    watchdog.reset();
    yield { kind: "done", response };
  } catch (err) {
    throw classifyGeminiError(err, controller.signal.aborted);
  } finally {
    clearTimeout(hardTimer);
    cleanup();
    watchdog.clear();
  }
}

export const geminiDriver: LlmDriver = {
  provider: PROVIDER,
  complete: completeImpl,
  stream: streamImpl,
};
