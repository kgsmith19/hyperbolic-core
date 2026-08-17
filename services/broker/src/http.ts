// The two-line JSON response every control route in this service writes.
// Mirrors services/llm-handler/src/http.ts's own send()/readJsonBody() pair
// -- same contract (cache-control: no-store is deliberate, not a default),
// copied rather than shared across services because the two files are small
// and each service's own copy stays independently deployable.
import type { IncomingMessage, ServerResponse } from "node:http";

export function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

/**
 * Reads a JSON request body, refusing anything past `cap` bytes.
 *
 * The cap is enforced mid-stream and destroys the request rather than
 * buffering to the end, so an oversized body is refused as it arrives
 * instead of after it is all in memory.
 */
export function readJsonBody(req: IncomingMessage, cap: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > cap) {
        // Reject HERE, not from the `end` handler. destroy() emits neither
        // `end` nor `error` (it emits `close`), so an over-cap body would
        // otherwise settle this promise on no path at all.
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data.length ? JSON.parse(data) : {});
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
    // Backstop for the other way this stream can finish without `end`: a
    // client that aborts mid-upload.
    req.on("close", () => reject(new Error("request aborted before the body was received")));
  });
}
