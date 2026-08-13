/**
 * Orchestration: retry (via retry.ts's withRetry, shared by every driver),
 * explicit-only fallback routing, and driver dispatch. This is the only
 * place that knows about more than one provider at a time.
 *
 * Fallback routing (08-llm-handlers.md section 4): a request may carry
 * `fallback: [{provider, model}]`. The library fails over to the next entry
 * only on retryable-exhaustion of the previous one (all of *that* entry's
 * retries used up on a retryable error class), and never when `tools` is
 * present -- rejected as invalid_request before the primary call is even
 * attempted. No silent cross-provider fallback happens outside this
 * mechanism, and every response/done-delta still names the exact
 * provider+model that answered (never the one originally requested).
 */
import { anthropicDriver } from "./drivers/anthropic.ts";
import { geminiDriver } from "./drivers/gemini.ts";
import { openaiDriver } from "./drivers/openai.ts";
import type { LlmDriver } from "./drivers/types.ts";
import { createLlmError, isLlmError, RETRYABLE_CLASSES } from "./errors.ts";
import { MAX_RETRIES, computeBackoffMs, sleep, withRetry } from "./retry.ts";
import type { Credentials, CredentialsByProvider, LlmDelta, LlmRequest, LlmResponse, MessagePart, Provider } from "./types.ts";

// m4-02 judgment call (flagged per that issue's own instructions, since
// neither it nor 08-llm-handlers.md section 4 mandates this wiring
// explicitly): all three shipped drivers are registered here so a real
// caller's fallback chain works out of the box without also having to pass
// a custom `drivers` registry. `OrchestrationOptions.drivers` below still
// lets a caller (or a test) substitute a different registry entirely.
const DEFAULT_DRIVERS: Partial<Record<Provider, LlmDriver>> = {
  anthropic: anthropicDriver,
  gemini: geminiDriver,
  openai: openaiDriver,
};

/** Injectable for tests (a fake multi-provider registry); real callers omit this. */
export interface OrchestrationOptions {
  drivers?: Partial<Record<Provider, LlmDriver>>;
}

interface Hop {
  provider: Provider;
  model: string;
}

function hopsFor(request: LlmRequest): Hop[] {
  return [{ provider: request.provider, model: request.model }, ...(request.fallback ?? [])];
}

/**
 * ADR-05 / 08-llm-handlers.md section 4 only prohibits fallback *across
 * providers* when tools are attached -- a same-provider fallback (e.g.
 * anthropic/claude-a -> anthropic/claude-b) is legal, since it's the same
 * tool-calling wire contract on both ends. Only a hop naming a different
 * provider than the primary request triggers the rejection.
 */
function assertNoFallbackWithTools(request: LlmRequest): void {
  const hasCrossProviderFallback = (request.fallback ?? []).some((hop) => hop.provider !== request.provider);
  const hasTools = (request.tools?.length ?? 0) > 0;
  if (hasCrossProviderFallback && hasTools) {
    throw createLlmError(
      "invalid_request",
      "fallback routing is not permitted across providers when tools are attached: a fallback to a different provider with tool schemas is rejected at the library boundary (a same-provider fallback with tools is fine)",
    );
  }
}

// ---------------------------------------------------------------------------
// Role/part validation (finding #81): types.ts's UserMessage/AssistantMessage
// content types are narrowed at the type level (UserContentPart /
// AssistantContentPart), but a caller can still hand this package an
// untyped or JSON-built LlmRequest that bypasses the compiler entirely --
// e.g. a ToolResultPart placed on a UserMessage, or a ToolUsePart placed on
// a UserMessage. Left unchecked, the three drivers diverge on what happens
// to an out-of-place part (openai.ts silently filters it out, gemini.ts
// silently blanks the whole turn to `{text: ""}`, anthropic.ts routes it
// through unconditionally and lets the wire API reject it) -- so this one
// guard, run before any driver is ever dispatched, is the single place that
// turns "silently wrong" into "loudly rejected", for all three drivers and
// every hop of a fallback chain at once (the messages array is identical
// across hops; requestForHop only ever overrides provider/model).
// ---------------------------------------------------------------------------

const ALLOWED_PART_TYPES_BY_ROLE: Record<"user" | "assistant" | "tool", ReadonlySet<MessagePart["type"]>> = {
  user: new Set(["text"]),
  assistant: new Set(["text", "tool_use"]),
  tool: new Set(["tool_result"]),
};

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  ancestors.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function hasValidPartPayload(part: Record<string, unknown>): boolean {
  if (part.type === "text") {
    return typeof part.text === "string";
  }
  if (part.type === "tool_use") {
    return typeof part.id === "string" && typeof part.name === "string" && isJsonValue(part.input);
  }
  if (part.type === "tool_result") {
    const validContent =
      typeof part.content === "string" ||
      (Array.isArray(part.content) &&
        part.content.every(
          (nested) =>
            !!nested &&
            typeof nested === "object" &&
            (nested as { type?: unknown }).type === "text" &&
            typeof (nested as { text?: unknown }).text === "string",
        ));
    return typeof part.toolUseId === "string" && validContent && (part.isError === undefined || typeof part.isError === "boolean");
  }
  return false;
}

function assertValidMessageParts(request: LlmRequest): void {
  if (!Array.isArray(request.messages)) {
    throw createLlmError("invalid_request", "messages: expected an array");
  }
  for (const [messageIndex, message] of request.messages.entries()) {
    const rawMessage = message as unknown;
    if (!rawMessage || typeof rawMessage !== "object") {
      throw createLlmError("invalid_request", `messages[${messageIndex}]: expected a message object`);
    }
    const role = (rawMessage as { role?: unknown }).role;
    const content = (rawMessage as { content?: unknown }).content;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      throw createLlmError("invalid_request", `messages[${messageIndex}].role: unsupported role "${String(role)}"`);
    }
    if (role === "system") {
      if (typeof content !== "string") {
        throw createLlmError("invalid_request", `messages[${messageIndex}].content: a system message must contain a string`);
      }
      continue;
    }
    if (typeof content === "string") {
      if (role === "tool") {
        throw createLlmError("invalid_request", `messages[${messageIndex}].content: a tool message must contain an array of tool_result parts`);
      }
      continue;
    }
    // Defensive against genuinely untyped/JSON-built input (the exact
    // scenario this whole guard exists for): a `content` that is neither a
    // string nor an array at all must fail as a clean invalid_request here,
    // not as a bare "x.entries is not a function" TypeError a few lines
    // below.
    if (!Array.isArray(content)) {
      throw createLlmError(
        "invalid_request",
        `messages[${messageIndex}].content: expected a string or an array of parts for a "${role}" message, got ${content === null ? "null" : typeof content}`,
      );
    }
    const allowed = ALLOWED_PART_TYPES_BY_ROLE[role];
    for (const [partIndex, part] of content.entries()) {
      if (
        !part ||
        typeof part !== "object" ||
        typeof (part as { type?: unknown }).type !== "string" ||
        !allowed.has((part as MessagePart).type) ||
        !hasValidPartPayload(part as Record<string, unknown>)
      ) {
        const gotType = part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string" ? (part as MessagePart).type : typeof part;
        throw createLlmError(
          "invalid_request",
          `messages[${messageIndex}].content[${partIndex}]: a "${gotType}" part is not valid on a "${role}" message ` +
            `(user: text only; assistant: text/tool_use; tool: tool_result only -- see types.ts's UserContentPart/AssistantContentPart/ToolMessage)`,
        );
      }
    }
  }
}

function assertValidRequest(request: LlmRequest): void {
  assertNoFallbackWithTools(request);
  assertValidMessageParts(request);
  if (request.signal?.aborted) {
    throw request.signal.reason ?? createLlmError("transport", "request aborted before driver dispatch");
  }
}

function getDriver(drivers: Partial<Record<Provider, LlmDriver>>, provider: Provider): LlmDriver {
  const driver = drivers[provider];
  if (!driver) {
    throw createLlmError("invalid_request", `no driver registered for provider "${provider}"`);
  }
  return driver;
}

function getCredentials(credentials: CredentialsByProvider, provider: Provider): Credentials {
  const creds = credentials[provider];
  if (!creds) {
    throw createLlmError("invalid_request", `no credentials supplied for provider "${provider}"`);
  }
  return creds;
}

function requestForHop(request: LlmRequest, hop: Hop): LlmRequest {
  return { ...request, provider: hop.provider, model: hop.model };
}

// ---------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------

export async function complete(request: LlmRequest, credentials: CredentialsByProvider, options: OrchestrationOptions = {}): Promise<LlmResponse> {
  assertValidRequest(request);
  const drivers = options.drivers ?? DEFAULT_DRIVERS;
  const hops = hopsFor(request);
  let lastError: unknown;
  for (const [hopIndex, hop] of hops.entries()) {
    const driver = getDriver(drivers, hop.provider);
    const creds = getCredentials(credentials, hop.provider);
    const hopRequest = requestForHop(request, hop);
    try {
      // request.signal (finding #87): threaded into withRetry's own
      // opts.signal, which already supported it internally (sleep(waitMs,
      // opts.signal)) but was never actually given one before this fix.
      return await withRetry(() => driver.complete(hopRequest, creds), { signal: request.signal });
    } catch (err) {
      lastError = err;
      const isLastHop = hopIndex === hops.length - 1;
      // Finding #87: a caller signal that has already fired stops fallover
      // to the next hop too -- otherwise a cancelled call whose driver error
      // still carries a retryable class (e.g. "transport", since the same
      // controller aborts for a timeout, a stream stall, *or* the caller's
      // own signal -- see drivers/abort.ts) would silently keep going on a
      // different provider instead of actually stopping.
      const callerAborted = request.signal?.aborted ?? false;
      // Derived fresh from `class` (finding #85), same as withRetry's own
      // decision, rather than trusting a possibly-forged error's stored
      // `.retryable` -- this fallover decision is the same kind of "should
      // this error be treated as retryable" call withRetry makes, just one
      // layer up.
      if (isLastHop || callerAborted || !(isLlmError(err) && RETRYABLE_CLASSES.has(err.class))) {
        throw err;
      }
      // Retryable exhaustion on a non-final hop: fail over to the next one.
    }
  }
  // Unreachable (hops always has >= 1 entry, so the loop above either
  // returns or throws), but keeps control flow explicit for the compiler.
  throw lastError;
}

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

/**
 * Streaming retry/fallover is deliberately narrower than complete()'s: once
 * any delta has been handed to the consumer, no further retry or fallover
 * happens for this call, on any hop -- there is no way to "un-yield" partial
 * output, and LlmDelta has no reset/restart signal a consumer could key off
 * of. Before the first delta, retry-then-fallover behaves exactly like
 * complete(). A failure after the first delta is thrown immediately.
 */
export async function* stream(request: LlmRequest, credentials: CredentialsByProvider, options: OrchestrationOptions = {}): AsyncGenerator<LlmDelta, void, unknown> {
  assertValidRequest(request);
  const drivers = options.drivers ?? DEFAULT_DRIVERS;
  const hops = hopsFor(request);
  let sawFirstDelta = false;
  let lastError: unknown;

  for (const [hopIndex, hop] of hops.entries()) {
    const driver = getDriver(drivers, hop.provider);
    const creds = getCredentials(credentials, hop.provider);
    const hopRequest = requestForHop(request, hop);

    for (let attemptIndex = 0; attemptIndex <= MAX_RETRIES; attemptIndex++) {
      try {
        for await (const delta of driver.stream(hopRequest, creds)) {
          sawFirstDelta = true;
          yield delta;
        }
        return;
      } catch (err) {
        lastError = err;
        // Derived fresh from `class` (finding #85), same reasoning as the
        // hop-fallover check in complete() above and withRetry's own.
        const retryable = isLlmError(err) && RETRYABLE_CLASSES.has(err.class);
        const isLastAttemptOfHop = attemptIndex === MAX_RETRIES;
        const isLastHop = hopIndex === hops.length - 1;
        // Finding #87: a caller signal that has already fired stops this
        // hand-rolled retry loop immediately too -- same reasoning as
        // complete()'s callerAborted check above.
        const callerAborted = request.signal?.aborted ?? false;
        if (sawFirstDelta || !retryable || callerAborted || (isLastAttemptOfHop && isLastHop)) {
          throw err;
        }
        if (!isLastAttemptOfHop) {
          const waitMs = isLlmError(err) && err.retryAfterMs !== undefined ? err.retryAfterMs : computeBackoffMs(attemptIndex);
          // request.signal (finding #87): this sleep previously took no
          // signal at all, so a cancellation during backoff would have sat
          // out the full wait before the next attempt even started.
          await sleep(waitMs, request.signal);
          continue; // retry the same hop
        }
        break; // hop's retries exhausted; outer loop advances to the next hop
      }
    }
  }
  throw lastError;
}
