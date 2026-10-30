// HTTP routing for the local platform service (#508): /auth/v1, /rest/v1 and
// /health. Errors use PostgREST's {code, message, details, hint} shape so the
// clients' existing error handling keeps working.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import type { Auth } from "./auth.ts";
import type { PlatformConfig } from "./config.ts";
import type { Signer } from "./jwt.ts";
import { ApiError, handleRest } from "./rest.ts";
import { handleRpc } from "./rpc.ts";

const MAX_BODY = 1_048_576;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, "PGRST413", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "PGRST102", "the body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === null || body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(payload ? { "content-type": "application/json; charset=utf-8" } : {}), ...headers });
  res.end(payload);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

export function createPlatformServer(db: DatabaseSync, config: PlatformConfig, auth: Auth, signer: Signer): Server {
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> =
      origin && config.allowedOrigins.includes(origin)
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": "authorization, apikey, content-type, prefer, accept-profile, content-profile, x-client-info, range",
            "access-control-allow-methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
            "access-control-expose-headers": "content-range",
            vary: "origin",
          }
        : {};
    try {
      if (req.method === "OPTIONS") return send(res, 204, null, cors);
      const url = new URL(req.url ?? "/", "http://local");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health") return send(res, 200, { ok: true }, cors);

      if (path === "/auth/v1/.well-known/jwks.json") return send(res, 200, signer.jwks(), cors);
      if (path === "/auth/v1/token" && req.method === "POST") {
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        const grant = url.searchParams.get("grant_type");
        const session =
          grant === "password" ? auth.passwordGrant(body.email, body.password) : grant === "refresh_token" ? auth.refreshGrant(body.refresh_token) : undefined;
        if (session === undefined) return send(res, 400, { error: "unsupported_grant_type", error_description: `grant_type ${grant} is not supported` }, cors);
        if (session === null) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" }, cors);
        return send(res, 200, session, cors);
      }
      if (path === "/auth/v1/user" && req.method === "GET") {
        const principal = auth.principal(bearer(req));
        if (!principal?.isOwner) return send(res, 401, { code: 401, msg: "invalid JWT" }, cors);
        return send(res, 200, auth.user(), cors);
      }
      if (path === "/auth/v1/logout" && req.method === "POST") {
        const principal = auth.principal(bearer(req));
        if (!principal?.isOwner) return send(res, 401, { code: 401, msg: "invalid JWT" }, cors);
        auth.logout();
        return send(res, 204, null, cors);
      }

      const rest = /^\/rest\/v1\/(rpc\/)?([a-z_][a-z0-9_]*)$/.exec(path);
      if (rest) {
        const principal = auth.principal(bearer(req));
        const method = req.method ?? "GET";
        const profile =
          (method === "GET" || method === "HEAD" ? req.headers["accept-profile"] : req.headers["content-profile"]) ??
          req.headers["accept-profile"] ??
          null;
        const body = method === "GET" || method === "HEAD" ? undefined : await readJson(req);
        if (rest[1]) {
          if (method !== "POST" && method !== "GET") throw new ApiError(405, "PGRST117", "RPCs take POST");
          const args = method === "GET" ? Object.fromEntries(url.searchParams) : body;
          return send(res, 200, handleRpc(db, principal, config.ownerId, profile as string | null, rest[2] as string, args), cors);
        }
        const result = handleRest(db, principal, config.ownerId, {
          method,
          profile: profile as string | null,
          table: rest[2] as string,
          params: url.searchParams,
          body,
          prefer: String(req.headers.prefer ?? ""),
        });
        return send(res, result.status, result.body, cors);
      }

      return send(res, 404, { code: "PGRST404", message: `no route for ${req.method} ${path}`, details: null, hint: null }, cors);
    } catch (error) {
      if (error instanceof ApiError) {
        return send(res, error.status, { code: error.code, message: error.message, details: null, hint: null }, cors);
      }
      // Internal detail stays in the local log; the client gets a generic message.
      console.error("platform-api: unhandled error", error);
      return send(res, 500, { code: "XX000", message: "internal error", details: null, hint: null }, cors);
    }
  });
}
