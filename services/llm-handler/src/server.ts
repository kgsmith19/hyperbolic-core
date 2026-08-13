// Handler A's HTTP surface. Raw node:http, no framework -- matching this
// repo's own precedent for a small, security-relevant loopback service
// (apps/agentic-command-center/gui/server.mjs), and 08-llm-handlers.md's
// "small deployed service" framing. Only /healthz and
// POST /api/intake/submit exist today; /v1/complete, /v1/stream, /v1/count
// (08 section 5) are added when m4-05 actually lands.

import http from "node:http";
import { extractBearerToken, verifyOwnerSession } from "./auth.ts";
import { submitIdea, type SubmitDeps } from "./intake-submit.ts";
import type { HandlerConfig } from "./types.ts";

const BODY_CAP = 16 * 1024;

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let overCap = false;
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > BODY_CAP) {
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
    body = await readJsonBody(req);
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

export function createHandler(config: HandlerConfig, serviceRoleKey: string) {
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

    send(res, 404, { error: "not found" });
  };
}

export function startServer(config: HandlerConfig, serviceRoleKey: string): Promise<http.Server> {
  const server = http.createServer(createHandler(config, serviceRoleKey));
  return new Promise((resolve) => {
    server.listen(config.port, "127.0.0.1", () => resolve(server));
  });
}
