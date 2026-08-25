// Request-shape validation for /v1/complete and /v1/stream (08-llm-handlers.md
// section 4's LlmRequest, "minus provider keys" per section 5's contract
// column -- credentials never come from the request body, only from this
// process's own config.llmCredentials). packages/llm's complete()/stream()
// already validate `messages` deeply (assertValidMessageParts) and reject a
// tools+cross-provider-fallback combination, but nothing in that package
// checks provider/model/maxTokens/timeoutMs/metadata presence or shape --
// those are HTTP-boundary concerns this route owns, so a malformed request
// fails with a clean 400 here rather than an obscure TypeError once it
// reaches a driver.

import type { FallbackTarget, LlmRequest, LlmRequestMetadata, Message, Provider, ToolDef } from "@hyperbolic/llm";

const PROVIDERS: ReadonlySet<Provider> = new Set(["anthropic", "openai", "google"]);

export type ParsedLlmRequest = { ok: true; request: LlmRequest } | { ok: false; error: string };

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && PROVIDERS.has(value as Provider);
}

function parseMetadata(value: unknown): LlmRequestMetadata | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const callerApp = (value as { callerApp?: unknown }).callerApp;
  const purpose = (value as { purpose?: unknown }).purpose;
  const runRef = (value as { runRef?: unknown }).runRef;
  if (typeof callerApp !== "string" || !callerApp || typeof purpose !== "string" || !purpose) {
    return null;
  }
  if (runRef !== undefined && typeof runRef !== "string") {
    return null;
  }
  return runRef === undefined ? { callerApp, purpose } : { callerApp, purpose, runRef };
}

function parseFallback(value: unknown): { ok: true; fallback: FallbackTarget[] | undefined } | { ok: false } {
  if (value === undefined) {
    return { ok: true, fallback: undefined };
  }
  if (!Array.isArray(value)) {
    return { ok: false };
  }
  const fallback: FallbackTarget[] = [];
  for (const hop of value) {
    if (!hop || typeof hop !== "object" || !isProvider((hop as { provider?: unknown }).provider)) {
      return { ok: false };
    }
    const model = (hop as { model?: unknown }).model;
    if (typeof model !== "string" || !model) {
      return { ok: false };
    }
    fallback.push({ provider: (hop as { provider: Provider }).provider, model });
  }
  return { ok: true, fallback };
}

/** Parses and validates the HTTP-boundary fields of an incoming /v1/complete
 * or /v1/stream body into a real LlmRequest. `messages`/`tools`/`toolChoice`
 * are passed through structurally as-is -- packages/llm validates their
 * contents itself (assertValidMessageParts) the moment complete()/stream()
 * is called, so this function does not duplicate that deeper check. */
export function parseLlmRequest(body: unknown): ParsedLlmRequest {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;

  if (!isProvider(raw.provider)) {
    return { ok: false, error: `provider must be one of ${[...PROVIDERS].join(", ")}` };
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return { ok: false, error: "model is required" };
  }
  if (!Array.isArray(raw.messages)) {
    return { ok: false, error: "messages must be an array" };
  }
  if (typeof raw.maxTokens !== "number" || !Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0) {
    return { ok: false, error: "maxTokens must be a positive integer" };
  }
  if (typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0) {
    return { ok: false, error: "timeoutMs must be a positive integer" };
  }
  const metadata = parseMetadata(raw.metadata);
  if (!metadata) {
    return { ok: false, error: "metadata.callerApp and metadata.purpose are required strings" };
  }
  if (raw.temperature !== undefined && typeof raw.temperature !== "number") {
    return { ok: false, error: "temperature must be a number" };
  }
  if (raw.toolChoice !== undefined) {
    const tc = raw.toolChoice;
    const validLiteral = tc === "auto" || tc === "none";
    const validNamed = !!tc && typeof tc === "object" && typeof (tc as { name?: unknown }).name === "string";
    if (!validLiteral && !validNamed) {
      return { ok: false, error: 'toolChoice must be "auto", "none", or {name: string}' };
    }
  }
  if (raw.tools !== undefined && !Array.isArray(raw.tools)) {
    return { ok: false, error: "tools must be an array" };
  }
  const fallbackResult = parseFallback(raw.fallback);
  if (!fallbackResult.ok) {
    return { ok: false, error: "fallback must be an array of {provider, model}" };
  }

  const request: LlmRequest = {
    provider: raw.provider,
    model: raw.model,
    messages: raw.messages as Message[],
    maxTokens: raw.maxTokens,
    timeoutMs: raw.timeoutMs,
    metadata,
    ...(raw.tools !== undefined ? { tools: raw.tools as ToolDef[] } : {}),
    ...(raw.toolChoice !== undefined ? { toolChoice: raw.toolChoice as LlmRequest["toolChoice"] } : {}),
    ...(raw.temperature !== undefined ? { temperature: raw.temperature as number } : {}),
    ...(fallbackResult.fallback !== undefined ? { fallback: fallbackResult.fallback } : {}),
  };
  return { ok: true, request };
}
