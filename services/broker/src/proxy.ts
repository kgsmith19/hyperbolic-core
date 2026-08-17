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
import type { CredentialMap } from "./credentials.ts";
import { verifyCallerToken, type CallerTokenMap } from "./caller-tokens.ts";

export interface ProxyRequestBody {
  caller: string;
  token: string;
  targetHost: string;
  protocol?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  // issue #186: the vault key NAME (never a value) this request wants
  // injected, and the header name to inject it as -- e.g.
  // { credential: "LLM_KEYS_ANTHROPIC", credentialHeader: "x-api-key" }.
  // Both optional; a request with neither is exactly #185's original
  // log-only pass-through, unchanged.
  credential?: string;
  credentialHeader?: string;
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
  // Present only for a request that named a credential (issue #186 round-2
  // independent review's finding): distinguishes a refused credential
  // request from a granted one, and from the original #185 log-only shape
  // (both fields absent) where no credential was ever requested at all.
  credentialRequested?: string;
  credentialGranted?: boolean;
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

// Headers describing THIS connection to the target -- never caller-
// controlled (round-2 independent review's finding, NEW-3). `host`
// determines virtual-host routing at the destination independently of the
// TCP host:port authorizeCredential's own allowedHosts check constrains
// (classic domain fronting: an allowed TCP destination, an attacker-chosen
// Host header). `content-length`/`transfer-encoding` disagreeing with the
// actual body node:http writes lets the destination read the declared
// byte count and misinterpret the remainder as the start of a second,
// smuggled request. All three are values THIS module computes from the
// actual target/body, never relayed from the caller's own headers.
const REQUEST_CONNECTION_HEADERS = new Set(["host", "content-length", "transfer-encoding"]);

function sanitizeRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  // Object.create(null), matching injectCredential's own reasoning: `name`
  // may legitimately be "__proto__" (a valid HTTP_TOKEN_RE token, and this
  // function may receive injectCredential's own output), and a plain `{}`
  // would silently swallow that assignment via Object.prototype's own
  // __proto__ setter.
  const sanitized: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    if (!REQUEST_CONNECTION_HEADERS.has(name.toLowerCase())) sanitized[name] = value;
  }
  return sanitized;
}

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

// RFC 7230 3.2 field-content: tab, printable ASCII, and the obs-text octet
// range (0x80-0xFF) -- exactly what node:http's own checkInvalidHeaderChar
// accepts. A CRLF-only check (this file's own first draft) misses every
// other C0 control and every code point above 0xFF (a bare non-Latin-1
// character, e.g. "€", or a NUL byte): those still reached node:http
// unvalidated and threw its own internal TypeError -- caught by independent
// review's second pass, which fuzzed all 768 code points 0x0-0x2FF against
// every field and found 542 of them broke exactly this way through the
// header-value path alone.
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

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
    ([name, headerValue]) => HTTP_TOKEN_RE.test(name) && typeof headerValue === "string" && HEADER_VALUE_RE.test(headerValue),
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
    return "headers must be a plain object of valid header-name -> valid header-value string pairs (tab, printable ASCII, or 0x80-0xFF only; no control characters)";
  }
  if (request.body !== undefined && typeof request.body !== "string") {
    return "body must be a string when present";
  }
  // credential/credentialHeader are a pair: naming one without the other
  // is always a mistake (either "inject something, but into what header?"
  // or "here's a header name, but nothing to inject"), refused up front
  // rather than silently doing nothing.
  if (request.credential !== undefined || request.credentialHeader !== undefined) {
    if (typeof request.credential !== "string" || request.credential.length === 0) {
      return "credential must be a non-empty string when credentialHeader is present";
    }
    if (typeof request.credentialHeader !== "string" || !HTTP_TOKEN_RE.test(request.credentialHeader)) {
      return "credentialHeader must be a valid header-name token when credential is present";
    }
  }
  return null;
}

export interface CredentialError {
  status: 403 | 502;
  reason: string;
}

// Authorization is a HARD gate, never log-only (issue #186's own design
// rationale, unlike #187's host-allowlist soak): handing a caller
// credentials its own manifest never declared is a real vulnerability the
// instant it happens, not something safe to observe first and lock down
// later. Returns the error to refuse with, or null when the caller is
// authenticated AND authorized for exactly the vault key it named, AND the
// forwarding destination is one that caller's manifest actually declares.
//
// Two round-2 independent-review findings closed here, both load-bearing
// for the "the real secret never has to leave the broker unsupervised"
// claim the whole feature rests on:
//   - `request.token` was previously shape-checked (non-empty string) but
//     never verified against anything -- any process could self-assert
//     `caller: "llm-handler"` and receive its credentials. verifyCallerToken
//     closes that.
//   - `request.targetHost` was never checked against the caller's own
//     `allowedHosts` for a CREDENTIAL-bearing request specifically -- a
//     caller could name any host it wanted and have the real secret
//     injected into a request sent there. That is not the same risk #187's
//     general egress soak covers (this is the destination check the
//     credential gate's own safety depends on, not a generic allowlist);
//     it is enforced here, always, never log-only.
//
// The "unknown caller" and "bad token" cases are folded into one identical
// 403 message deliberately, so a caller cannot use the error text to probe
// which caller ids are even registered.
function authorizeCredential(
  request: ProxyRequestBody,
  policy: PolicyDocument,
  credentials: CredentialMap,
  callerTokens: CallerTokenMap,
  targetHost: string,
): CredentialError | null {
  const entry = policy[request.caller];
  const knownAndDeclared = isKnownCaller(request.caller, policy) && !!entry?.vaultKeys?.includes(request.credential!);
  const tokenOk = verifyCallerToken(callerTokens, request.caller, request.token);
  if (!knownAndDeclared || !tokenOk) {
    return { status: 403, reason: `caller "${request.caller}" is not authorized for vault key "${request.credential}"` };
  }
  // Round-2 independent review's finding (NEW-2): a credential-bearing
  // request must travel over TLS -- without this, `protocol: "http"` put
  // the real secret on the wire in cleartext even to an allowed host.
  // request.protocol is optional and already defaults to https in
  // forward() when absent, so only an EXPLICIT "http" is refused here.
  if (request.protocol === "http") {
    return { status: 403, reason: "a credential-bearing request must use protocol \"https\"" };
  }
  const targetLower = targetHost.toLowerCase();
  if (!(entry!.allowedHosts ?? []).some((host) => host.toLowerCase() === targetLower)) {
    return { status: 403, reason: `caller "${request.caller}" is not authorized to reach host "${targetHost}" with a credential` };
  }
  if (!Object.prototype.hasOwnProperty.call(credentials, request.credential!)) {
    // Fail closed, never silently proxy without the credential the caller
    // explicitly asked for -- an unprovisioned key must be visibly broken,
    // not a mysteriously-unauthenticated call to the real provider.
    return { status: 502, reason: `vault key "${request.credential}" is not provisioned on this broker` };
  }
  if (!HEADER_VALUE_RE.test(credentials[request.credential!]!)) {
    // A malformed provisioned value (e.g. a trailing newline, a common
    // secret-manager copy/paste artifact) must fail as a clear, attributable
    // 502 here -- not reach node:http's own header-write path and throw
    // there, which would violate this module's own "never throws" contract.
    return { status: 502, reason: `vault key "${request.credential}" is provisioned with a value that is not a valid HTTP header value` };
  }
  return null;
}

// Merges the resolved credential into the outgoing headers, overwriting
// (never appending alongside) any caller-supplied value for the same
// header name -- case-insensitively, since HTTP header names are: a
// caller naming `Authorization` while credentialHeader is `authorization`
// must not leak its own value through under the differently-cased key.
//
// Object.create(null), not a `{}` literal (round-2 independent review's
// finding): a plain object's `__proto__` key is an accessor on
// Object.prototype that silently ignores a string assignment rather than
// creating an own property, so `credentialHeader === "__proto__"` (a valid
// HTTP_TOKEN_RE token) previously vanished the injection entirely --
// exactly the "silently proxy without the credential" failure mode this
// file's own header comment already promises never happens. A null-
// prototype object has no such accessor: every assignment here is a plain
// own data property, regardless of its key.
function injectCredential(headers: Record<string, string> | undefined, credentialHeader: string, value: string): Record<string, string> {
  const merged: Record<string, string> = Object.create(null);
  const targetLower = credentialHeader.toLowerCase();
  for (const [name, headerValue] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== targetLower) merged[name] = headerValue;
  }
  merged[credentialHeader] = value;
  return merged;
}

export interface ProxyContext {
  credentials?: CredentialMap;
  callerTokens?: CallerTokenMap;
  log?: LogFn;
}

export async function proxyRequest(input: unknown, policy: PolicyDocument, context: ProxyContext = {}): Promise<ProxyResult> {
  const { credentials = {}, callerTokens = {}, log = defaultLog } = context;
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

  // The credential decision runs BEFORE the log entry is emitted (round-2
  // independent review's finding): logging first meant a 403-refused
  // credential request logged identically to a successful proxy, recording
  // a targetHost the request never actually reached -- an audit trail that
  // cannot distinguish "granted" from "refused" has no value for exactly
  // the hard-gate decision it most needs to record.
  let forwardRequest = request;
  let credentialGranted: boolean | undefined;
  if (request.credential !== undefined) {
    const authError = authorizeCredential(request, policy, credentials, callerTokens, target.host);
    credentialGranted = authError === null;
    if (authError !== null) {
      log({
        caller: request.caller,
        targetHost: loggedTarget,
        knownCaller,
        credentialRequested: request.credential,
        credentialGranted: false,
        timestamp: new Date().toISOString(),
      });
      return jsonResult(authError.status, { error: "credential request refused", reason: authError.reason });
    }
    forwardRequest = {
      ...request,
      headers: injectCredential(request.headers, request.credentialHeader!, credentials[request.credential]!),
    };
  }

  log({
    caller: request.caller,
    targetHost: loggedTarget,
    knownCaller,
    credentialRequested: request.credential,
    credentialGranted,
    timestamp: new Date().toISOString(),
  });

  return forward(forwardRequest, target);
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
      headers: sanitizeRequestHeaders(request.headers),
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
        upstreamReq.destroy();
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
