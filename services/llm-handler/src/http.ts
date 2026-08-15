// The two-line JSON response every route in this service writes. Shared
// because server.ts and llm-routes.ts had byte-identical private copies, and
// a divergence between them would be a silent header inconsistency rather
// than a failure -- `cache-control: no-store` in particular is a deliberate
// part of this service's contract, not a default.
import type { IncomingMessage, ServerResponse } from "node:http";

export function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

/**
 * Reads a JSON request body, refusing anything past `cap` bytes.
 *
 * `cap` is a parameter rather than a constant because the two callers
 * deliberately differ: server.ts admits 16 KB, which is ample for this
 * service's own control routes, while llm-routes.ts admits 2 MB because a
 * completion request legitimately carries a large prompt. The cap is enforced
 * mid-stream and destroys the request rather than buffering to the end, so an
 * oversized body is refused as it arrives instead of after it is all in
 * memory -- which is the whole point of having a cap.
 */
export function readJsonBody(req: IncomingMessage, cap: number): Promise<unknown> {
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
