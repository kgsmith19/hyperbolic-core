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

// m5-01/m5-02 tried exporting prompt-render.ts's pure functions here for
// apps/shell's Prompt Organizer surface to reuse, and reverted it: this
// package's index.ts barrel also re-exports complete/stream and the three
// provider drivers (anthropicDriver/geminiDriver/openaiDriver), which pull
// in @anthropic-ai/sdk, @google/genai, and openai transitively -- server-
// side-only dependencies with zero reason to reach a browser bundle. Vite
// could not tree-shake them back out through this barrel, and importing
// only { render, extractVariables, extractSections } from "@hyperbolic/llm"
// blew apps/shell's 250 KB gzipped bundle budget
// (docs/planning/09-design-system.md section 6) by ~33 KB. apps/shell now
// carries its own copy at src/lib/prompt-render.ts instead (the same
// "narrow, deliberate duplication" this file's own prompt-render.ts already
// documents for ITS relationship to web/render.mjs) -- see that file's own
// header comment.
