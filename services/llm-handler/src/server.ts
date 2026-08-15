// Handler A's HTTP surface. Raw node:http, no framework -- matching this
// repo's own precedent for a small, security-relevant loopback service
// (apps/agentic-command-center/backend/gui/server.mjs), and 08-llm-handlers.md's
// "small deployed service" framing. /healthz, POST /api/intake/submit
// (m3-06), and /v1/complete, /v1/stream, /v1/count (08 section 5, m4-05).

import http from "node:http";
import { extractBearerToken, verifyOwnerSession } from "./auth.ts";
import { ConcurrencyGate } from "./concurrency.ts";
import { submitIdea, type SubmitDeps } from "./intake-submit.ts";
import { llmRoutes } from "./llm-routes.ts";
import { readJsonBody, send } from "./http.ts";
import type { HandlerConfig } from "./types.ts";

const BODY_CAP = 16 * 1024;

async function handleIntakeSubmit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: HandlerConfig,
  serviceRoleKey: string
): Promise<void> {
  const bearerToken = extractBearerToken(req.headers.authorization);
  if (!bearerToken) {
    send(res, 401, { error: "missing or malformed Authorization header" });
    return;
  }
  // The single round trip that verifies BOTH JWT validity and owner
  // identity (auth.ts's own doc comment); every non-owner/invalid case
  // fails closed to 401 here, so a garbage or non-owner token never reaches
  // the submit orchestration at all.
  const isOwner = await verifyOwnerSession(config.supabaseUrl, config.supabasePublishableKey, bearerToken);
  if (!isOwner) {
    send(res, 401, { error: "not an active platform owner session" });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, BODY_CAP);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : "invalid request body" });
    return;
  }
  const ideaId = (body as { ideaId?: unknown } | null)?.ideaId;
  if (typeof ideaId !== "string" || !ideaId) {
    send(res, 400, { error: "ideaId is required" });
    return;
  }

  const deps: SubmitDeps = {
    supabaseUrl: config.supabaseUrl,
    supabasePublishableKey: config.supabasePublishableKey,
    serviceRoleKey,
    githubIntakePat: config.githubIntakePat,
  };
  const outcome = await submitIdea(deps, bearerToken, ideaId);

  switch (outcome.kind) {
    case "already_submitted":
    case "submitted":
      send(res, 200, { issueNumber: outcome.issueNumber, issueUrl: outcome.issueUrl });
      return;
    case "draft_not_promoted":
      // II-1: promote to 'idea' before submit is legal.
      send(res, 409, { error: "idea is still a draft; promote it before submitting" });
      return;
    case "error":
      send(res, 502, { error: outcome.errorClass, message: outcome.message });
      return;
  }
}

/** Shared ADR-03 gate for every /v1/* route: reuses m3-06's
 * extractBearerToken/verifyOwnerSession unchanged (see llm-routes.ts's own
 * header comment on why this is owner-only today). Returns true on a
 * verified owner session, or sends the 401 itself and returns false. */
async function requireOwnerSession(req: http.IncomingMessage, res: http.ServerResponse, config: HandlerConfig): Promise<boolean> {
  const bearerToken = extractBearerToken(req.headers.authorization);
  if (!bearerToken) {
    send(res, 401, { error: "missing or malformed Authorization header" });
    return false;
  }
  const isOwner = await verifyOwnerSession(config.supabaseUrl, config.supabasePublishableKey, bearerToken);
  if (!isOwner) {
    send(res, 401, { error: "not an active platform owner session" });
    return false;
  }
  return true;
}

export function createHandler(config: HandlerConfig, serviceRoleKey: string) {
  const llmConcurrencyGate = new ConcurrencyGate(config.llmMaxConcurrencyPerCaller);

  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const route = (req.url ?? "/").split("?")[0];

    // /healthz: the loopback-only Docker healthcheck and
    // tailscale-serve-apply.sh's preflight both curl 127.0.0.1:8200
    // directly, bypassing tailscale entirely, matching every other unit's
    // bare-/healthz convention. /api/healthz: tailscale serve forwards the
    // FULL incoming path unchanged for a path-mounted target (does not
    // strip the /api/ mount prefix -- confirmed against this repo's own
    // apps/lifeos/backend/tests/api/test_root_path.py, which documents the
    // identical mechanic for LifeOS's /life/api/ mount), so an operator
    // checking health through the real public origin needs this second,
    // prefixed alias to reach the same handler.
    if ((route === "/healthz" || route === "/api/healthz") && req.method === "GET") {
      send(res, 200, { status: "ok" });
      return;
    }

    if (route === "/api/intake/submit" && req.method === "POST") {
      handleIntakeSubmit(req, res, config, serviceRoleKey).catch((err: unknown) => {
        send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
      });
      return;
    }

    // /api/v1/*, not bare /v1/*: docs/ops/runbook.md's Tailscale Serve
    // table mounts Handler A's whole loopback origin at /api/ with the full
    // incoming path forwarded unchanged (same mechanic /api/healthz's own
    // comment above documents), and /api/intake/submit already established
    // the precedent of a single canonical /api/-prefixed path with no bare
    // alias (unlike /healthz, which genuinely needs both for the loopback
    // Docker healthcheck). The Brain never calls this surface at all (08
    // forced decision 5: it links packages/llm in-process with its own
    // isolated key), so there is no legitimate bare-path loopback caller to
    // support here either.
    if (route === "/api/v1/complete" && req.method === "POST") {
      requireOwnerSession(req, res, config)
        .then(async (ok) => {
          if (ok) await llmRoutes.handleComplete(req, res, config, llmConcurrencyGate);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    if (route === "/api/v1/stream" && req.method === "POST") {
      requireOwnerSession(req, res, config)
        .then(async (ok) => {
          if (ok) await llmRoutes.handleStream(req, res, config, llmConcurrencyGate);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    if (route === "/api/v1/count" && req.method === "POST") {
      requireOwnerSession(req, res, config)
        .then(async (ok) => {
          if (ok) await llmRoutes.handleCount(req, res);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    send(res, 404, { error: "not found" });
  };
}

export function startServer(config: HandlerConfig, serviceRoleKey: string): Promise<http.Server> {
  const server = http.createServer(createHandler(config, serviceRoleKey));
  return new Promise((resolve) => {
    server.listen(config.port, "127.0.0.1", () => resolve(server));
  });
}
