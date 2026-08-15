// The two-line JSON response every route in this service writes. Shared
// because server.ts and llm-routes.ts had byte-identical private copies, and
// a divergence between them would be a silent header inconsistency rather
// than a failure -- `cache-control: no-store` in particular is a deliberate
// part of this service's contract, not a default.
import type { ServerResponse } from "node:http";

export function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}
