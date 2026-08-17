// The broker's log-only pass-through path (issue #185): every well-formed
// request is logged with caller, target host, and timestamp, then forwarded
// to its target unmodified -- no allow/deny decision yet. isKnownCaller is
// looked up and included in the log entry for future denial visibility
// (issue #187), but an unknown caller is proxied exactly like a known one at
// this phase; only #187's soak-then-approve enforcement flip may change that.
//
// Never throws, and never reaches node:http's own request layer with
// unvalidated input: every field that flows into `http.request()`'s options
// (method, path, headers, the parsed host/port) is shape- and
// grammar-validated FIRST, so a malformed value is always answered with a
// clean 400 from THIS module, never Node's own internal TypeError/RangeError
// text leaking to the caller, and never a half-opened socket left behind by
// a write() that threw before end() ran (a real, demonstrated fd-exhaustion
// path an independent adversarial review of this file's first draft found
// and confirmed by measurement -- every code path below that opens a socket
// is now wrapped so it is always ended or destroyed).

import * as http from "node:http";
import * as https from "node:https";
import { validateRequest } from "@hyperbolic/broker-contract";
import { isKnownCaller, type PolicyDocument } from "./policy.ts";

export interface ProxyRequestBody {
  caller: string;
  token: string;
  targetHost: string;
  protocol?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyResult {
  status: number;
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
}

export interface ProxyLogEntry {
  caller: string;
  targetHost: string;
  knownCaller: boolean;
  timestamp: string;
}

export type LogFn = (entry: ProxyLogEntry) => void;

export function defaultLog(entry: ProxyLogEntry): void {
  console.log(JSON.stringify({ event: "broker_proxy_request", ...entry }));
}

// Hop-by-hop headers (RFC 7230 6.1) plus Node's own "no chunked encoding
// mismatch" concerns -- relaying these from the upstream response verbatim
// would describe the CONNECTION to the target, not to this proxy's own
// caller, and node:http already writes its own versions of most of them.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

function jsonResult(status: number, body: unknown): ProxyResult {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body), "utf8") };
}

// Same normalization contract.mjs's own validateRequest applies before any
// property access: typeof === "object" && !Array.isArray, so a function,
// array, string, or null input is treated as an empty object rather than
// crashing on property lookup.
function normalize(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// RFC 7230 3.2.6 token: what a header NAME or an HTTP METHOD is grammatically
// allowed to be. node:http throws its own TypeError for a violation of this
// same grammar -- validating it here first means that throw never happens.
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// A request-target's path+query, RFC 7230 3.1.1 / RFC 3986: no control
// characters (CR/LF header-injection into the request line included) and no
// literal whitespace -- a caller that needs either must percent-encode it,
// exactly like a URL would require.
const REQUEST_PATH_RE = /^\/[\x21-\x7e]*$/;

// hostname (RFC 1123) or a bracketed IPv6 literal, with an optional
// :<1-5 digit> port -- rejects header-injection payloads riding in
// targetHost (e.g. "127.0.0.1\r\nX: 1") and ambiguous/garbage port
// suffixes (e.g. "127.0.0.1:99999x", silently coerced to NaN-then-default
// by a bare Number() cast) rather than letting either reach node:http or a
// falsified audit-log entry.
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6_LITERAL_RE = /^\[[0-9A-Fa-f:.]+\]$/;

interface ParsedTarget {
  host: string;
  port: number | undefined;
}

function parseTargetHost(targetHost: string): ParsedTarget | null {
  let hostPart = targetHost;
  let portPart: string | undefined;

  if (targetHost.startsWith("[")) {
    const closeIdx = targetHost.indexOf("]");
    if (closeIdx === -1) return null;
    hostPart = targetHost.slice(0, closeIdx + 1);
    const rest = targetHost.slice(closeIdx + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) return null;
      portPart = rest.slice(1);
    }
    if (!IPV6_LITERAL_RE.test(hostPart)) return null;
  } else {
    const parts = targetHost.split(":");
    if (parts.length > 2) return null; // an unbracketed IPv6 literal or garbage -- ambiguous, refused
    hostPart = parts[0] ?? "";
    portPart = parts[1];
    if (!HOSTNAME_RE.test(hostPart) || hostPart.length > 253) return null;
  }

  let port: number | undefined;
  if (portPart !== undefined) {
    if (!/^[0-9]{1,5}$/.test(portPart)) return null;
    port = Number(portPart);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }

  return { host: hostPart, port };
}

function isPlainHeadersRecord(value: unknown): value is Record<string, string> {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([name, headerValue]) => HTTP_TOKEN_RE.test(name) && typeof headerValue === "string" && !/[\r\n]/.test(headerValue),
  );
}

// Validates every field forward() will pass into node:http's own request
// layer, BEFORE any socket is opened. Returns an error string on the first
// violation found, or null when the request is safe to forward.
function validateForwarding(request: ProxyRequestBody): string | null {
  if (request.protocol !== undefined && request.protocol !== "http" && request.protocol !== "https") {
    return 'protocol must be "http" or "https" when present';
  }
  if (parseTargetHost(request.targetHost) === null) {
    return "targetHost must be a bare hostname/IPv4/bracketed-IPv6 literal with an optional :port (1-65535)";
  }
  if (request.method !== undefined && (typeof request.method !== "string" || !HTTP_TOKEN_RE.test(request.method))) {
    return "method must be a valid HTTP token";
  }
  if (request.path !== undefined && (typeof request.path !== "string" || !REQUEST_PATH_RE.test(request.path))) {
    return "path must start with / and contain no control characters or whitespace";
  }
  if (!isPlainHeadersRecord(request.headers)) {
    return "headers must be a plain object of valid header-name -> single-line string-value pairs";
  }
  if (request.body !== undefined && typeof request.body !== "string") {
    return "body must be a string when present";
  }
  return null;
}

export async function proxyRequest(input: unknown, policy: PolicyDocument, log: LogFn = defaultLog): Promise<ProxyResult> {
  const candidate = normalize(input);
  const validation = validateRequest(candidate);
  if (!validation.ok) {
    return jsonResult(400, { error: "invalid broker request", details: validation.errors });
  }

  const request = candidate as unknown as ProxyRequestBody;
  const forwardingError = validateForwarding(request);
  if (forwardingError !== null) {
    return jsonResult(400, { error: "invalid broker request", details: [forwardingError] });
  }

  const target = parseTargetHost(request.targetHost);
  // Unreachable given validateForwarding already checked this, but keeps
  // TypeScript honest about the narrowed type without a second `!`.
  if (target === null) return jsonResult(400, { error: "invalid broker request", details: ["targetHost"] });

  const knownCaller = isKnownCaller(request.caller, policy);
  // Logs the host:port actually parsed and about to be contacted, not the
  // raw caller-supplied string -- what the audit trail promises is a
  // truthful record of where the request went, and parseTargetHost is the
  // only thing in this module allowed to decide that.
  const loggedTarget = target.port !== undefined ? `${target.host}:${target.port}` : target.host;
  log({ caller: request.caller, targetHost: loggedTarget, knownCaller, timestamp: new Date().toISOString() });

  return forward(request, target);
}

const UPSTREAM_TIMEOUT_MS = 15_000;

function forward(request: ProxyRequestBody, target: ParsedTarget): Promise<ProxyResult> {
  const transport = request.protocol === "http" ? http : https;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProxyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const upstreamReq = transport.request({
      host: target.host,
      port: target.port,
      path: request.path ?? "/",
      method: request.method ?? "GET",
      headers: request.headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    });

    // A dead/unreachable/timed-out target must answer the broker's own
    // caller, not hang or crash the process -- the broker itself is not the
    // thing being tested for reachability here. Every one of these paths
    // destroys the request so its socket is never left open.
    upstreamReq.on("error", (err) => {
      upstreamReq.destroy();
      finish(jsonResult(502, { error: "broker upstream request failed", message: (err as Error).message }));
    });
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy();
      finish(jsonResult(502, { error: "broker upstream request failed", message: "upstream request timed out" }));
    });

    upstreamReq.on("response", (upstreamRes) => {
      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      upstreamRes.on("end", () => {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
          headers[name] = value;
        }
        // Buffer.concat, never string concatenation: a multi-byte UTF-8
        // character (or arbitrary binary) split across two TCP chunks is
        // corrupted by `data += chunk`'s implicit per-chunk toString() --
        // concatenating the raw Buffers first and decoding/relaying once
        // (here: not decoding at all, passed straight to the caller's own
        // response) is what "forwarded unmodified" actually requires.
        finish({ status: upstreamRes.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
      });
      upstreamRes.on("error", (err) => {
        finish(jsonResult(502, { error: "broker upstream response failed", message: (err as Error).message }));
      });
    });

    // Every path out of this try block ends the request exactly once --
    // the fix for the fd leak an independent review measured: a .write()
    // that throws (previously) skipped .end() entirely, leaving an
    // already-connected socket with no timeout to ever reclaim it.
    try {
      if (request.body) upstreamReq.write(request.body);
      upstreamReq.end();
    } catch (err) {
      upstreamReq.destroy();
      finish(jsonResult(502, { error: "broker upstream request failed", message: (err as Error).message }));
    }
  });
}
