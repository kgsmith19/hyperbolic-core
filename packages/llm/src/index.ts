/**
 * `@hyperbolic/llm` -- the single provider abstraction library (08 section
 * 3, forced decision 5). Contracts, retry/backoff, and the Anthropic,
 * OpenAI, and Gemini drivers live here. This package never stores, reads,
 * or defaults an API key -- credentials are a plain argument on every call,
 * supplied by the host process (Handler A or the Brain), never by this
 * package.
 */

export type {
  AssistantContentPart,
  AssistantMessage,
  Credentials,
  CredentialsByProvider,
  FallbackTarget,
  JsonSchema,
  LlmDelta,
  LlmError,
  LlmErrorClass,
  LlmRequest,
  LlmRequestMetadata,
  LlmResponse,
  Message,
  MessagePart,
  Provider,
  StopReason,
  SystemMessage,
  TextPart,
  ToolCall,
  ToolCallDelta,
  ToolChoice,
  ToolDef,
  ToolMessage,
  ToolResultPart,
  ToolUsePart,
  Usage,
  UserContentPart,
  UserMessage,
} from "./types.ts";

export { ALL_ERROR_CLASSES, createLlmError, isLlmError, RETRYABLE_CLASSES } from "./errors.ts";
export type { CreateLlmErrorOptions } from "./errors.ts";

export { MAX_RETRIES, RETRY_BASE_MS, RETRY_CAP_MS, STREAM_STALL_MS, computeBackoffMs, withRetry } from "./retry.ts";

export type { LlmDriver } from "./drivers/types.ts";
export { anthropicDriver } from "./drivers/anthropic.ts";
export { geminiDriver } from "./drivers/gemini.ts";
export { openaiDriver } from "./drivers/openai.ts";

export { complete, stream } from "./complete.ts";
export type { OrchestrationOptions } from "./complete.ts";

export { createPromptClient, MissingVariablesError, PromptNotFoundError } from "./prompt-client.ts";
export type { GetPromptOptions, PromptClient, PromptClientOptions, RenderedPrompt } from "./prompt-client.ts";
