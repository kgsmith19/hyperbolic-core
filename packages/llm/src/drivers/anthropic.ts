/**
 * Anthropic driver: complete Messages API support (non-streaming, streaming,
 * tool use in both directions, cache-read usage). Uses the official
 * `@anthropic-ai/sdk` package.
 *
 * Zero key handling (hard requirement, not a style choice): the only key
 * this file ever sees is `credentials.apiKey`, an explicit function
 * argument. Every call builds a fresh SDK client from it and lets that
 * client go out of scope when the call returns -- nothing is cached at
 * module scope, nothing is logged, and this file never reads any
 * environment variable for a credential. If `credentials.apiKey` is falsy,
 * the driver rejects the call itself, before constructing a client, so a
 * caller mistake can never silently fall through to whatever ambient
 * credential the SDK might otherwise resolve on its own.
 */
import Anthropic from "@anthropic-ai/sdk";
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
  ToolCall,
  ToolChoice,
  ToolDef,
  ToolResultPart,
} from "../types.ts";
import type { LlmDriver } from "./types.ts";

const PROVIDER = "anthropic" as const;

// ---------------------------------------------------------------------------
// Request mapping: our provider-agnostic shapes -> Anthropic wire params.
// ---------------------------------------------------------------------------

function toAnthropicSystem(messages: Message[]): string | undefined {
  const parts = messages.filter((m): m is Extract<Message, { role: "system" }> => m.role === "system").map((m) => m.content);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function toAnthropicToolResultBlock(part: ToolResultPart): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: part.toolUseId,
    content: typeof part.content === "string" ? part.content : part.content.map((t) => ({ type: "text" as const, text: t.text })),
    is_error: part.isError,
  };
}

function toAnthropicContentBlock(part: MessagePart): Anthropic.ContentBlockParam {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "tool_use") {
    return { type: "tool_use", id: part.id, name: part.name, input: part.input };
  }
  return toAnthropicToolResultBlock(part);
}

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      continue;
    }
    if (m.role === "tool") {
      result.push({ role: "user", content: m.content.map(toAnthropicToolResultBlock) });
      continue;
    }
    result.push({
      role: m.role,
      content: typeof m.content === "string" ? m.content : m.content.map(toAnthropicContentBlock),
    });
  }
  return result;
}

function toAnthropicTool(tool: ToolDef): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    // Caller-supplied JSON Schema is opaque data here: the provider
    // validates it, we don't re-model JSON Schema's shape ourselves.
    input_schema: tool.inputSchema as unknown as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicToolChoice(choice: ToolChoice): Anthropic.ToolChoice {
  if (choice === "auto") {
    return { type: "auto" };
  }
  if (choice === "none") {
    return { type: "none" };
  }
  return { type: "tool", name: choice.name };
}

interface AnthropicBaseParams {
  model: string;
  max_tokens: number;
  messages: Anthropic.MessageParam[];
  system?: string;
  tools?: Anthropic.Tool[];
  tool_choice?: Anthropic.ToolChoice;
  temperature?: number;
}

function buildParams(request: LlmRequest): AnthropicBaseParams {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    messages: toAnthropicMessages(request.messages),
    system: toAnthropicSystem(request.messages),
    tools: request.tools?.map(toAnthropicTool),
    tool_choice: request.toolChoice ? toAnthropicToolChoice(request.toolChoice) : undefined,
    temperature: request.temperature,
  };
}

// ---------------------------------------------------------------------------
// Response mapping: Anthropic wire shapes -> our provider-agnostic shapes.
// ---------------------------------------------------------------------------

function mapStopReason(stopReason: Anthropic.StopReason | null): StopReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    // "pause_turn" only occurs when Anthropic-hosted server tools (web
    // search, code execution, ...) pause a long-running turn. This driver
    // never sends server tools -- only the caller's own ToolDef[] -- so this
    // is unreachable in practice; treated as a normal end defensively.
    case "pause_turn":
    case null:
    default:
      return "end";
  }
}

function fromAnthropicMessage(message: Anthropic.Message, latencyMs: number): LlmResponse {
  const textBlocks = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
  const toolCalls: ToolCall[] = message.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  return {
    text: textBlocks.length > 0 ? textBlocks.map((b) => b.text).join("") : null,
    toolCalls,
    stopReason: mapStopReason(message.stop_reason),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    },
    provider: PROVIDER,
    model: message.model,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy: Anthropic SDK exceptions -> LlmError.
// ---------------------------------------------------------------------------

/** From the installed SDK's ErrorType union (core/../resources/shared.d.ts). */
const KNOWN_TYPE_CLASS: Record<string, LlmErrorClass> = {
  authentication_error: "auth",
  permission_error: "auth",
  billing_error: "auth", // surfaces as 403, like permission_error
  not_found_error: "invalid_request",
  invalid_request_error: "invalid_request",
  rate_limit_error: "rate_limit",
  timeout_error: "transport",
  overloaded_error: "overloaded",
  api_error: "transport", // Anthropic's own guidance: retry with backoff
};

function classifyByStatus(status: number | undefined): LlmErrorClass {
  if (status === undefined) {
    return "transport"; // no response at all: connection-level failure
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status === 529) {
    return "overloaded";
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
 * `content_policy` is part of the shared taxonomy for provider-agnostic
 * completeness (a future driver may throw it), but Anthropic's own content
 * refusals are not thrown errors at all -- they come back as a normal HTTP
 * 200 with `stop_reason: "refusal"`, which fromAnthropicMessage/mapStopReason
 * above already surfaces as `LlmResponse.stopReason: "refusal"`. This driver
 * therefore never produces class "content_policy".
 */
function classifyAnthropicError(err: unknown, wasAborted: boolean): LlmError {
  if (wasAborted) {
    return createLlmError("transport", "anthropic driver: attempt aborted (timeoutMs exceeded or stream stalled)", { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    // Also covers APIConnectionTimeoutError (a subclass of this). Note
    // APIUserAbortError is a *sibling* of APIConnectionError under APIError,
    // not a subclass of it -- but any abort from this driver's own
    // controller is already caught by wasAborted above, before reaching
    // here, so anything landing in this branch is a genuine connection-level
    // failure (DNS, refused, reset, ...), never our own timeout or stall.
    return createLlmError("transport", err.message, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const byType = err.type !== null ? KNOWN_TYPE_CLASS[err.type] : undefined;
    const errClass = byType ?? classifyByStatus(err.status);
    return createLlmError(errClass, err.message, { cause: err, retryAfterMs: parseRetryAfterMs(err.headers) });
  }
  return createLlmError("provider_bug", err instanceof Error ? err.message : String(err), { cause: err });
}

// ---------------------------------------------------------------------------
// Client construction -- see the zero-key-handling note at the top of file.
// ---------------------------------------------------------------------------

function buildClient(credentials: Credentials): Anthropic {
  if (!credentials.apiKey) {
    throw createLlmError("invalid_request", "anthropic driver: no API key supplied in credentials");
  }
  return new Anthropic({
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
    const message = await client.messages.create({ ...params, stream: false }, { signal: controller.signal });
    return fromAnthropicMessage(message, Date.now() - startedAt);
  } catch (err) {
    throw classifyAnthropicError(err, controller.signal.aborted);
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
  // Any sign of life from the stream resets the stall clock; total silence
  // for STREAM_STALL_MS aborts the same controller the hard timeout uses,
  // so both paths converge on the same abort-handling below.
  const watchdog = createStallWatchdog(STREAM_STALL_MS, () => controller.abort());

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  try {
    const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: controller.signal });
    for await (const event of anthropicStream) {
      watchdog.reset();
      switch (event.type) {
        case "message_start": {
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens;
          cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          if (event.content_block.type === "tool_use") {
            yield {
              kind: "tool_call",
              partial: { index: event.index, id: event.content_block.id, name: event.content_block.name },
            };
          }
          break;
        }
        case "content_block_delta": {
          if (event.delta.type === "text_delta") {
            yield { kind: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            yield { kind: "tool_call", partial: { index: event.index, inputJsonDelta: event.delta.partial_json } };
          }
          break;
        }
        case "message_delta": {
          inputTokens = event.usage.input_tokens ?? inputTokens;
          outputTokens = event.usage.output_tokens;
          cacheReadTokens = event.usage.cache_read_input_tokens ?? cacheReadTokens;
          yield { kind: "usage", usage: { inputTokens, outputTokens, cacheReadTokens } };
          break;
        }
        default:
          break;
      }
    }
    const finalMessage = await anthropicStream.finalMessage();
    yield { kind: "done", response: fromAnthropicMessage(finalMessage, Date.now() - startedAt) };
  } catch (err) {
    throw classifyAnthropicError(err, controller.signal.aborted);
  } finally {
    clearTimeout(hardTimer);
    watchdog.clear();
  }
}

export const anthropicDriver: LlmDriver = {
  provider: PROVIDER,
  complete: completeImpl,
  stream: streamImpl,
};
