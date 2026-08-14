// /v1/complete, /v1/stream, /v1/count (08-llm-handlers.md section 5).
// /v1/complete and /v1/stream reuse m3-06's existing ADR-03 owner auth
// (auth.ts) unchanged -- 08's "operator session JWT or scoped agent token"
// column describes the general ADR-03 contract; no scoped-agent-token
// issuer exists anywhere in this repo yet (m4-05's own scope list has no
// item for minting or verifying one), so the only credential Handler A can
// actually check today is the owner session, exactly what m3-06 already
// built and what this file's tests assert 401 without.

import type { IncomingMessage, ServerResponse } from "node:http";
import { complete, isLlmError, stream, type LlmDelta, type LlmErrorClass, type LlmResponse } from "@hyperbolic/llm";
import type { ConcurrencyGate } from "./concurrency.ts";
import { estimateMessagesTokens } from "./count.ts";
import { logLlmCall } from "./llm-call-log.ts";
import { parseLlmRequest } from "./llm-request.ts";
import type { HandlerConfig } from "./types.ts";

function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

// Handler A's own admission-control/validation-error mapping. Distinct from
// LlmError.retryable (which governs packages/llm's internal retry/fallover
// decisions, not what an HTTP client should see): a caller-facing status
// reflects who is responsible for the failure -- 4xx when the request
// itself (or the provider rejecting its content) is at fault, 5xx when
// Handler A's own upstream credential/transport/provider is at fault.
const STATUS_BY_ERROR_CLASS: Record<LlmErrorClass, number> = {
  invalid_request: 400,
  content_policy: 422,
  rate_limit: 429,
  auth: 502,
  transport: 502,
  provider_bug: 502,
  overloaded: 503,
};

function errorResponseFor(err: unknown): { status: number; class: string; message: string } {
  if (isLlmError(err)) {
    return { status: STATUS_BY_ERROR_CLASS[err.class], class: err.class, message: err.message };
  }
  return { status: 500, class: "unknown", message: err instanceof Error ? err.message : "internal error" };
}

/** 16 KiB (server.ts's own intake-route cap) is far too small for LLM
 * message histories, tool schemas, and system prompts. 2 MiB matches this
 * service's compose.yaml deploy footprint (a single small container, no
 * reason to admit an unbounded body) while comfortably covering any real
 * request this route needs to accept. */
const LLM_BODY_CAP = 2 * 1024 * 1024;

function readJsonBody(req: IncomingMessage, cap: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let overCap = false;
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > cap) {
        overCap = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overCap) {
        reject(new Error("request body too large"));
        return;
      }
      try {
        resolve(data.length ? JSON.parse(data) : {});
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Aborts when the client disconnects, so an abandoned /v1/complete or
 * /v1/stream call stops burning provider quota and a concurrency slot
 * instead of running to completion unobserved (LlmRequest.signal, already
 * threaded through every retry/fallover decision in packages/llm). */
function abortSignalForRequest(req: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  req.once("close", () => controller.abort());
  return controller.signal;
}

async function handleComplete(req: IncomingMessage, res: ServerResponse, config: HandlerConfig, gate: ConcurrencyGate): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req, LLM_BODY_CAP);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : "invalid request body" });
    return;
  }
  const parsed = parseLlmRequest(body);
  if (!parsed.ok) {
    send(res, 400, { error: parsed.error });
    return;
  }
  const { request } = parsed;
  const callerApp = request.metadata.callerApp;

  if (!gate.tryAcquire(callerApp)) {
    send(res, 429, { error: `caller "${callerApp}" is at its concurrency cap` });
    return;
  }

  const startedAt = performance.now();
  try {
    const response = await complete(request, config.llmCredentials, {});
    void logLlmCall(config.supabaseUrl, config.supabasePublishableKey, bearerTokenFrom(req), {
      callerApp,
      purpose: request.metadata.purpose,
      runRef: request.metadata.runRef,
      provider: response.provider,
      model: response.model,
      status: "ok",
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      latencyMs: response.latencyMs,
    });
    send(res, 200, response satisfies LlmResponse);
  } catch (err) {
    const mapped = errorResponseFor(err);
    void logLlmCall(config.supabaseUrl, config.supabasePublishableKey, bearerTokenFrom(req), {
      callerApp,
      purpose: request.metadata.purpose,
      runRef: request.metadata.runRef,
      provider: request.provider,
      model: request.model,
      status: "error",
      latencyMs: Math.round(performance.now() - startedAt),
      errorClass: mapped.class,
    });
    send(res, mapped.status, { error: mapped.class, message: mapped.message });
  } finally {
    gate.release(callerApp);
  }
}

function writeSseFrame(res: ServerResponse, event: string | null, data: unknown): void {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleStream(req: IncomingMessage, res: ServerResponse, config: HandlerConfig, gate: ConcurrencyGate): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req, LLM_BODY_CAP);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : "invalid request body" });
    return;
  }
  const parsed = parseLlmRequest(body);
  if (!parsed.ok) {
    send(res, 400, { error: parsed.error });
    return;
  }
  const { request } = parsed;
  const callerApp = request.metadata.callerApp;

  if (!gate.tryAcquire(callerApp)) {
    send(res, 429, { error: `caller "${callerApp}" is at its concurrency cap` });
    return;
  }

  const bearerToken = bearerTokenFrom(req);
  const startedAt = performance.now();
  const logOutcome = (delta: Extract<LlmDelta, { kind: "done" }> | null, err: unknown | null) => {
    if (delta) {
      void logLlmCall(config.supabaseUrl, config.supabasePublishableKey, bearerToken, {
        callerApp,
        purpose: request.metadata.purpose,
        runRef: request.metadata.runRef,
        provider: delta.response.provider,
        model: delta.response.model,
        status: "ok",
        inputTokens: delta.response.usage.inputTokens,
        outputTokens: delta.response.usage.outputTokens,
        cacheReadTokens: delta.response.usage.cacheReadTokens,
        latencyMs: delta.response.latencyMs,
      });
    } else {
      const mapped = errorResponseFor(err);
      void logLlmCall(config.supabaseUrl, config.supabasePublishableKey, bearerToken, {
        callerApp,
        purpose: request.metadata.purpose,
        runRef: request.metadata.runRef,
        provider: request.provider,
        model: request.model,
        status: "error",
        latencyMs: Math.round(performance.now() - startedAt),
        errorClass: mapped.class,
      });
    }
  };

  try {
    const requestWithSignal = { ...request, signal: abortSignalForRequest(req) };
    const iterator = stream(requestWithSignal, config.llmCredentials, {})[Symbol.asyncIterator]();
    // Defer committing to a 200/SSE response until the FIRST step succeeds:
    // a failure here (invalid_request, an immediate auth/transport failure
    // before any delta) can still be reported as a clean HTTP status code
    // instead of a 200 followed by a same-conversation SSE error frame.
    let step: IteratorResult<LlmDelta>;
    try {
      step = await iterator.next();
    } catch (err) {
      const mapped = errorResponseFor(err);
      logOutcome(null, err);
      send(res, mapped.status, { error: mapped.class, message: mapped.message });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    while (!step.done) {
      writeSseFrame(res, null, step.value);
      if (step.value.kind === "done") {
        logOutcome(step.value, null);
      }
      try {
        step = await iterator.next();
      } catch (err) {
        // LlmDelta has no "error" kind (types.ts): a mid-stream failure is
        // reported on this Handler-A-specific SSE "error" event instead,
        // since the HTTP status line and headers are already committed.
        logOutcome(null, err);
        const mapped = errorResponseFor(err);
        writeSseFrame(res, "error", { error: mapped.class, message: mapped.message });
        break;
      }
    }
    res.end();
  } finally {
    gate.release(callerApp);
  }
}

function bearerTokenFrom(req: IncomingMessage): string {
  // Only reached after the route's own extractBearerToken()/
  // verifyOwnerSession() gate in server.ts already proved this header is a
  // well-formed, live owner bearer token -- safe to re-extract verbatim
  // here rather than threading it through every function signature above.
  const header = req.headers.authorization ?? "";
  return header.slice("Bearer ".length);
}

async function handleCount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req, LLM_BODY_CAP);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : "invalid request body" });
    return;
  }
  if (!body || typeof body !== "object") {
    send(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.model !== "string" || !raw.model) {
    send(res, 400, { error: "model is required" });
    return;
  }
  if (!Array.isArray(raw.messages)) {
    send(res, 400, { error: "messages must be an array" });
    return;
  }
  try {
    const tokens = estimateMessagesTokens(raw.messages);
    send(res, 200, { tokens });
  } catch {
    send(res, 400, { error: "messages contains a malformed entry" });
  }
}

export const llmRoutes = { handleComplete, handleStream, handleCount };
