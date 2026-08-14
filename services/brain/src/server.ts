/**
 * The Brain daemon's HTTP surface. Raw node:http, no framework -- matching
 * services/llm-handler's own precedent for a small, security-relevant
 * loopback service. m4-08 ships only GET /healthz (07 section 7.3); the
 * real API/SSE surface lands in m4-14.
 */
import http from "node:http";
import type { BrainDaemon } from "./daemon.ts";

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

export function createHandler(daemon: BrainDaemon) {
  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const route = (req.url ?? "/").split("?")[0];

    if (route === "/healthz" && req.method === "GET") {
      daemon
        .health()
        .then((health) => send(res, health.status === "ok" ? 200 : 503, health))
        .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
      return;
    }

    send(res, 404, { error: "not found" });
  };
}

export function startServer(daemon: BrainDaemon, port: number): Promise<http.Server> {
  const server = http.createServer(createHandler(daemon));
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
