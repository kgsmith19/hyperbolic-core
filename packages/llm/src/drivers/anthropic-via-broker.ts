/**
 * Anthropic-via-broker driver (issue #186): sends the exact same Anthropic
 * Messages API request `buildParams()` (anthropic.ts) already builds for the
 * direct SDK driver, but wrapped in services/broker's `/proxy` JSON envelope
 * and posted to the broker's own HTTP listener instead of api.anthropic.com
 * directly. The broker holds the real provider API key (Infisical
 * `/platform/broker/`) and injects it as the `x-api-key` header itself --
 * this driver never sees or handles that secret at all.
 *
 * Additive, not wired into any default (issue #186's owner-directed scope:
 * "Build code only, don't touch live deploy env"). Nothing about
 * `anthropicDriver`, `complete()`'s own fallback chain, or `types.ts` changes
 * -- a caller opts in per-call via the existing `OrchestrationOptions.drivers`
 * seam:
 *
 *   complete(request, credentials, { drivers: { anthropic: anthropicViaBrokerDriver } })
 *
 * `credentials.apiKey` here is repurposed as the broker's own caller-auth
 * token (services/broker's `ProxyRequestBody.token`) -- NOT a provider API
 * key; this driver never holds one. `credentials.baseUrl` is the broker's
 * own listen address (e.g. "http://127.0.0.1:8300") and is REQUIRED for this
 * driver: unlike the direct SDK driver's optional proxy override, there is
 * no provider default to fall back to when every request must go through
 * the broker.
 *
 * Streaming is not supported: services/broker's forward() buffers the full
 * upstream response before ever resolving (no SSE pass-through), so
 * `stream()` here throws a clear, disclosed error rather than faking it.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { createLlmError, isLlmError } from "../errors.ts";
import { createAttemptController } from "./abort.ts";
import { classifyByStatus, buildParams, fromAnthropicMessage } from "./anthropic.ts";
import type { Credentials, LlmDelta, LlmError, LlmErrorClass, LlmRequest, LlmResponse } from "../types.ts";
import type { LlmDriver } from "./types.ts";

const PROVIDER = "anthropic" as const;
const ANTHROPIC_TARGET_HOST = "api.anthropic.com";
const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
const ANTHROPIC_VERSION_HEADER = "2023-06-01";
const BROKER_PROXY_PATH = "/proxy";
const BROKER_CALLER = "llm-handler";
const BROKER_CREDENTIAL_NAME = "LLM_KEYS_ANTHROPIC";
const BROKER_CREDENTIAL_HEADER = "x-api-key";

// services/broker/src/proxy.ts's own literal `error` strings: a response
// carrying one of these came from the broker itself refusing or failing to
// reach the target, never from a genuine Anthropic response -- disambiguated
// by exact string match, since only proxy.ts ever produces these values.
const BROKER_OWN_ERROR_MESSAGES = new Set([
  "invalid broker request",
  "credential request refused",
  "broker upstream request failed",
  "broker upstream response failed",
]);

interface BrokerErrorBody {
  error?: string;
  reason?: string;
  message?: string;
}

interface AnthropicErrorBody {
  error?: { type?: string; message?: string };
}

function buildEnvelope(request: LlmRequest, brokerToken: string): Record<string, unknown> {
  return {
    caller: BROKER_CALLER,
    token: brokerToken,
    targetHost: ANTHROPIC_TARGET_HOST,
    protocol: "https",
    method: "POST",
    path: ANTHROPIC_MESSAGES_PATH,
    headers: { "anthropic-version": ANTHROPIC_VERSION_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ ...buildParams(request), stream: false }),
    credential: BROKER_CREDENTIAL_NAME,
    credentialHeader: BROKER_CREDENTIAL_HEADER,
  };
}

function brokerProxyUrl(baseUrl: string): string {
  return new URL(BROKER_PROXY_PATH, baseUrl).toString();
}

function classifyTransportError(err: unknown, wasAborted: boolean): LlmError {
  if (isLlmError(err)) {
    return err;
  }
  if (wasAborted) {
    return createLlmError(
      "transport",
      "anthropic-via-broker driver: attempt aborted (timeoutMs exceeded or a caller-supplied AbortSignal fired)",
      { cause: err },
    );
  }
  return createLlmError("transport", err instanceof Error ? err.message : String(err), { cause: err });
}

// A non-2xx broker response is either (a) the broker itself refusing before
// ever contacting Anthropic (400/403/502, proxy.ts's own error shape) or
// (b) a genuine Anthropic error response relayed through unmodified
// (Anthropic's own wire shape: { type: "error", error: { type, message } }).
// Misreading (a) as a provider error would misclassify a broker
// misconfiguration (e.g. an unprovisioned credential) as, say, an
// Anthropic-side auth failure -- distinguished by matching the broker's own
// literal error strings, which Anthropic's error responses never contain.
function classifyBrokerFailure(status: number, parsed: unknown): LlmError {
  const body = parsed && typeof parsed === "object" ? (parsed as BrokerErrorBody) : {};
  if (typeof body.error === "string" && BROKER_OWN_ERROR_MESSAGES.has(body.error)) {
    const detail = body.reason ?? body.message ?? body.error;
    // 502 here means the broker itself could not complete the request
    // (unreachable target, unprovisioned credential) -- a transport-level
    // failure of the broker hop, not a rejection of the request's shape.
    const errClass: LlmErrorClass = status === 502 ? "transport" : "provider_bug";
    return createLlmError(errClass, `anthropic-via-broker driver: broker refused the request (${body.error}): ${detail}`);
  }
  const anthropicBody = parsed && typeof parsed === "object" ? (parsed as AnthropicErrorBody) : {};
  const message = anthropicBody.error?.message ?? `anthropic-via-broker driver: upstream returned HTTP ${status}`;
  return createLlmError(classifyByStatus(status), message);
}

async function completeImpl(request: LlmRequest, credentials: Credentials): Promise<LlmResponse> {
  if (!credentials.baseUrl) {
    throw createLlmError(
      "invalid_request",
      "anthropic-via-broker driver: credentials.baseUrl (the broker's own listen address) is required -- this driver never talks to a provider directly",
    );
  }
  if (!credentials.apiKey) {
    throw createLlmError("invalid_request", "anthropic-via-broker driver: no broker caller-auth token supplied in credentials.apiKey");
  }

  const { controller, hardTimer, cleanup } = createAttemptController(request);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(brokerProxyUrl(credentials.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEnvelope(request, credentials.apiKey)),
      signal: controller.signal,
    });
  } catch (err) {
    throw classifyTransportError(err, controller.signal.aborted);
  } finally {
    clearTimeout(hardTimer);
    cleanup();
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    throw createLlmError(
      "provider_bug",
      `anthropic-via-broker driver: broker response body was not valid JSON (status ${response.status})`,
    );
  }

  if (!response.ok) {
    throw classifyBrokerFailure(response.status, parsed);
  }

  return fromAnthropicMessage(parsed as Anthropic.Message, Date.now() - startedAt);
}

async function* streamImpl(_request: LlmRequest, _credentials: Credentials): AsyncGenerator<LlmDelta, void, unknown> {
  throw createLlmError(
    "invalid_request",
    "anthropic-via-broker driver: streaming through the broker is not yet supported (services/broker's forward() buffers the full response before resolving; no SSE pass-through exists)",
  );
}

export const anthropicViaBrokerDriver: LlmDriver = {
  provider: PROVIDER,
  complete: completeImpl,
  stream: streamImpl,
};
