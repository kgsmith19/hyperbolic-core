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

// `new URL("/proxy", baseUrl)` resolves an absolute-path reference against
// baseUrl per the URL spec, which REPLACES baseUrl's own path entirely (not
// appends to it) -- credentials.baseUrl must therefore be the broker's bare
// origin (e.g. "http://127.0.0.1:8300"), never a URL with its own path
// prefix; a reverse-proxy path prefix in front of the broker is not
// supported today and would need explicit handling here if that topology
// is ever introduced.
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
//
// Known, accepted limitation (round-2 independent review's finding, not
// closed in this PR): this is body-content sniffing, not a cryptographic or
// out-of-band signal, so a malicious/compromised UPSTREAM could in
// principle send a 4xx body containing one of BROKER_OWN_ERROR_MESSAGES
// verbatim and have it misclassified as a broker-level refusal instead of
// a real provider error. The practical exploitability is low here: this
// driver's own targetHost is a hardcoded constant
// (ANTHROPIC_TARGET_HOST) and authorizeCredential's own allowedHosts check
// (services/broker/src/proxy.ts) means only requests actually destined for
// that declared host ever reach injectCredential at all, so an attacker
// would need to already control api.anthropic.com's own responses. A
// robust fix (an out-of-band broker-refusal signal, e.g. a dedicated
// response header the broker sets on ITS OWN refusals and server.ts never
// relays from an upstream response) is deferred as a follow-up given that
// low severity.
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

  let proxyUrl: string;
  try {
    proxyUrl = brokerProxyUrl(credentials.baseUrl);
  } catch {
    // A malformed baseUrl is a configuration mistake, not a network failure
    // -- round-2 independent review's finding: this used to be caught by
    // the same catch as fetch()'s own errors and misclassified "transport"
    // (retryable), so a permanently bad config would be retried pointlessly
    // instead of surfacing as the non-retryable invalid_request it is.
    throw createLlmError("invalid_request", `anthropic-via-broker driver: credentials.baseUrl is not a valid URL: "${credentials.baseUrl}"`);
  }

  const { controller, hardTimer, cleanup } = createAttemptController(request);
  const startedAt = Date.now();
  let response: Response;
  let text: string;
  try {
    response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEnvelope(request, credentials.apiKey)),
      signal: controller.signal,
    });
    // Reading the body inside the SAME try/finally as fetch() itself
    // (round-2 independent review's finding): the previous version cleared
    // hardTimer/cleanup() the moment fetch() resolved -- i.e. once
    // response HEADERS arrived -- so request.timeoutMs stopped being
    // enforced for the remainder of the body read. A broker that sent
    // headers immediately but stalled mid-body left this call hanging
    // indefinitely regardless of timeoutMs. Reading the body here keeps
    // the same AbortController (and its still-armed hardTimer) covering
    // the read too, so an abort mid-body-read now actually aborts it.
    text = await response.text();
  } catch (err) {
    throw classifyTransportError(err, controller.signal.aborted);
  } finally {
    clearTimeout(hardTimer);
    cleanup();
  }

  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    // Classified by the actual HTTP status, not hardcoded provider_bug
    // (round-2 independent review's finding): a non-JSON body on a 5xx
    // (e.g. an HTML error page from a reverse proxy in front of the
    // broker) is a genuine transport-level failure and should retry like
    // any other 5xx; only a non-JSON body on a 2xx is truly "the broker
    // said success but sent garbage", which classifyByStatus's own
    // fallback already maps to provider_bug.
    throw createLlmError(
      classifyByStatus(response.status),
      `anthropic-via-broker driver: broker response body was not valid JSON (status ${response.status})`,
    );
  }

  if (!response.ok) {
    throw classifyBrokerFailure(response.status, parsed);
  }

  // A 2xx response body that isn't a usable JSON object must never reach
  // fromAnthropicMessage as `undefined`/`null` (round-2 independent
  // review's finding): fromAnthropicMessage's own malformed-response guard
  // dereferences `message.content` before it can run, so an empty or
  // literal-`null` body threw a raw, unclassified TypeError that bypassed
  // this driver's entire LlmError taxonomy -- reachable in practice,
  // since the broker's own test suite already produces a bodiless
  // relayed 200.
  if (typeof parsed !== "object" || parsed === null) {
    throw createLlmError(
      "provider_bug",
      `anthropic-via-broker driver: broker returned HTTP ${response.status} with no usable JSON body`,
    );
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
