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
import type { LlmDriver } from "./drivers/types.ts";
import { createLlmError, isLlmError } from "./errors.ts";
import { MAX_RETRIES, computeBackoffMs, sleep, withRetry } from "./retry.ts";
import type { Credentials, CredentialsByProvider, LlmDelta, LlmRequest, LlmResponse, Provider } from "./types.ts";

const DEFAULT_DRIVERS: Partial<Record<Provider, LlmDriver>> = {
  anthropic: anthropicDriver,
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

function assertNoFallbackWithTools(request: LlmRequest): void {
  const hasFallback = (request.fallback?.length ?? 0) > 0;
  const hasTools = (request.tools?.length ?? 0) > 0;
  if (hasFallback && hasTools) {
    throw createLlmError(
      "invalid_request",
      "fallback routing is not permitted when tools are attached: a fallback across providers with tool schemas is rejected at the library boundary",
    );
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
  assertNoFallbackWithTools(request);
  const drivers = options.drivers ?? DEFAULT_DRIVERS;
  const hops = hopsFor(request);
  let lastError: unknown;
  for (const [hopIndex, hop] of hops.entries()) {
    const driver = getDriver(drivers, hop.provider);
    const creds = getCredentials(credentials, hop.provider);
    const hopRequest = requestForHop(request, hop);
    try {
      return await withRetry(() => driver.complete(hopRequest, creds));
    } catch (err) {
      lastError = err;
      const isLastHop = hopIndex === hops.length - 1;
      if (isLastHop || !(isLlmError(err) && err.retryable)) {
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
  assertNoFallbackWithTools(request);
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
        const retryable = isLlmError(err) && err.retryable;
        const isLastAttemptOfHop = attemptIndex === MAX_RETRIES;
        const isLastHop = hopIndex === hops.length - 1;
        if (sawFirstDelta || !retryable || (isLastAttemptOfHop && isLastHop)) {
          throw err;
        }
        if (!isLastAttemptOfHop) {
          const waitMs = isLlmError(err) && err.retryAfterMs !== undefined ? err.retryAfterMs : computeBackoffMs(attemptIndex);
          await sleep(waitMs);
          continue; // retry the same hop
        }
        break; // hop's retries exhausted; outer loop advances to the next hop
      }
    }
  }
  throw lastError;
}
