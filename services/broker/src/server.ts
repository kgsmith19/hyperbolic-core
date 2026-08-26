// Raw node:http, no framework -- matching services/llm-handler/src/server.ts's
// own precedent for a small, security-relevant loopback service. Two routes
// only at this phase: GET /healthz (liveness) and POST /proxy (the log-only
// pass-through path, issue #185).

import * as http from "node:http";
import { send, readJsonBody } from "./http.ts";
import { proxyRequest, type ProxyContext } from "./proxy.ts";
import type { PolicyDocument } from "./policy.ts";

// 1 MiB: ample for the request metadata plus a proxied body this skeleton
// phase forwards (a completion-sized payload); not the 16 KB control-route
// cap services/llm-handler uses for its own non-proxy routes, since every
// route here IS the proxy route.
const PROXY_BODY_CAP_BYTES = 1024 * 1024;

export function createHandler(policy: PolicyDocument, context: ProxyContext = {}) {
  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const route = (req.url ?? "/").split("?")[0] ?? "/";

    if (route === "/healthz" && req.method === "GET") {
      send(res, 200, { status: "ok" });
      return;
    }

    if (route === "/proxy" && req.method === "POST") {
      readJsonBody(req, PROXY_BODY_CAP_BYTES)
        .then((parsed) => proxyRequest(parsed, policy, context))
        .then((result) => {
          // The full, filtered upstream header set (proxy.ts already
          // stripped hop-by-hop headers) -- relayed as-is, not narrowed to
          // content-type, so Location/Set-Cookie/Retry-After/etc. survive
          // the round trip. The response body is a Buffer end-to-end
          // (proxy.ts's own Buffer.concat), so res.end() writes the exact
          // bytes the upstream sent, never a re-encoded string.
          res.writeHead(result.status, { ...result.headers, "cache-control": "no-store" });
          res.end(result.body);
        })
        .catch((err: Error) => {
          send(res, 400, { error: err.message });
        });
      return;
    }

    send(res, 404, { error: "not found" });
  };
}

export function startServer(port: number, policy: PolicyDocument, context: ProxyContext = {}): Promise<http.Server> {
  const server = http.createServer(createHandler(policy, context));
  return new Promise((resolve) => {
    // 0.0.0.0, not 127.0.0.1: see services/llm-handler/src/server.ts's
    // identical comment (Issue #323) -- compose.yaml's host-side
    // 127.0.0.1:PORT:PORT publish is the real loopback-only boundary;
    // binding to the container's own loopback instead of 0.0.0.0 makes
    // the app unreachable via that published port at all.
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}
