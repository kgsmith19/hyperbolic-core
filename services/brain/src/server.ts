/**
 * The Brain daemon's HTTP surface. Raw node:http, no framework -- matching
 * services/llm-handler's own precedent for a small, security-relevant
 * loopback service. m4-08 shipped only GET /healthz (07 section 7.3);
 * m4-14 adds the /api/brain/* programmatic surface (07 section 7.8):
 * POST /runs, GET /runs/{id}, GET /runs/{id}/events (SSE), approve/reject,
 * and GET /health -- every one of them auth-gated per ADR-03 (auth.ts).
 */
import http from "node:http";
import { authenticate } from "./auth.ts";
import { handleApproveTask, handleCreateRun, handleGetRun, handleGetRunTasks, handleRejectTask, send } from "./api-routes.ts";
import { parseLastEventId, streamRunEvents } from "./sse.ts";
import type { BrainDaemon } from "./daemon.ts";
import type { BrainConfig } from "./config.ts";

const RUN_ID_RE = /^\/api\/brain\/runs\/([^/]+)$/;
const RUN_TASKS_RE = /^\/api\/brain\/runs\/([^/]+)\/tasks$/;
const RUN_EVENTS_RE = /^\/api\/brain\/runs\/([^/]+)\/events$/;
const TASK_APPROVE_RE = /^\/api\/brain\/tasks\/([^/]+)\/approve$/;
const TASK_REJECT_RE = /^\/api\/brain\/tasks\/([^/]+)\/reject$/;

function readJsonBodySafe(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data.length ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/** The one ADR-03 gate every /api/brain/* route goes through. A
 * malformed/absent header is rejected synchronously (extractBearerToken
 * inside authenticate()) before any network round trip -- the fast path
 * m4-14's own "401 within 50 ms" acceptance criterion depends on; only a
 * syntactically well-formed credential ever reaches the owner-session
 * RPC or agent-token signature check. */
async function requireAuth(req: http.IncomingMessage, res: http.ServerResponse, config: BrainConfig) {
  const principal = await authenticate(req.headers.authorization, {
    supabaseUrl: config.supabaseUrl,
    supabasePublishableKey: config.supabasePublishableKey,
    agentTokenPublicKeyPem: config.agentTokenPublicKeyPem,
    agentTokenIssuer: config.agentTokenIssuer,
    agentTokenAudience: config.agentTokenAudience,
  });
  if (!principal) {
    send(res, 401, { error: "missing or invalid credential" });
    return null;
  }
  return principal;
}

export function createHandler(daemon: BrainDaemon, config: BrainConfig) {
  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const route = (req.url ?? "/").split("?")[0]!;
    const method = req.method ?? "GET";

    // /healthz + /api/healthz: bare for the loopback Docker healthcheck,
    // prefixed for tailscale-serve path-mounting (llm-handler/src/
    // server.ts's own dual-registration precedent, same reasoning).
    // Deliberately unauthenticated, like every other unit's health route
    // in this monorepo -- an infra liveness probe, not an operator
    // surface, and m4-14's own 401-latency acceptance criterion is
    // scoped to "any /api/brain/* route", which this is not.
    if ((route === "/healthz" || route === "/api/brain/health") && method === "GET") {
      daemon
        .health()
        .then((health) => send(res, health.status === "ok" ? 200 : 503, health))
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    if (route === "/api/brain/runs" && method === "POST") {
      requireAuth(req, res, config)
        .then(async (principal) => {
          if (principal) await handleCreateRun(req, res, daemon.store, daemon.journal, config, principal);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    const eventsMatch = RUN_EVENTS_RE.exec(route);
    if (eventsMatch && method === "GET") {
      requireAuth(req, res, config)
        .then((principal) => {
          if (!principal) return;
          const runId = eventsMatch[1]!;
          if (!daemon.store.getRun(runId)) {
            send(res, 404, { error: `run ${runId} not found` });
            return;
          }
          const lastEventId = parseLastEventId(req.headers["last-event-id"]);
          const cleanup = streamRunEvents(res, daemon.journal, runId, { lastEventId });
          req.on("close", cleanup);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    const tasksMatch = RUN_TASKS_RE.exec(route);
    if (tasksMatch && method === "GET") {
      requireAuth(req, res, config)
        .then((principal) => {
          if (principal) handleGetRunTasks(res, daemon.store, tasksMatch[1]!);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    const runMatch = RUN_ID_RE.exec(route);
    if (runMatch && method === "GET") {
      requireAuth(req, res, config)
        .then((principal) => {
          if (principal) handleGetRun(res, daemon.store, runMatch[1]!);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    const approveMatch = TASK_APPROVE_RE.exec(route);
    if (approveMatch && method === "POST") {
      requireAuth(req, res, config)
        .then((principal) => {
          if (principal) handleApproveTask(res, daemon.store, daemon.journal, approveMatch[1]!);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    const rejectMatch = TASK_REJECT_RE.exec(route);
    if (rejectMatch && method === "POST") {
      requireAuth(req, res, config)
        .then(async (principal) => {
          if (!principal) return;
          const body = await readJsonBodySafe(req);
          const reason = typeof body.reason === "string" ? body.reason : undefined;
          handleRejectTask(res, daemon.store, daemon.journal, rejectMatch[1]!, reason);
        })
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    send(res, 404, { error: "not found" });
  };
}

export function startServer(daemon: BrainDaemon, config: BrainConfig): Promise<http.Server> {
  const server = http.createServer(createHandler(daemon, config));
  return new Promise((resolve) => {
    server.listen(config.port, "127.0.0.1", () => resolve(server));
  });
}
