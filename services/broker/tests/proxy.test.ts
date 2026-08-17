import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proxyRequest, type ProxyLogEntry } from "../src/proxy.ts";
import type { PolicyDocument } from "../src/policy.ts";

const EMPTY_POLICY: PolicyDocument = {};
const KNOWN_CALLER_POLICY: PolicyDocument = {
  "llm-handler": { allowedHosts: ["api.anthropic.com"], vaultKeys: [], maxUsdPerDay: null },
};
// A caller manifest-authorized for exactly one vault key (issue #186) --
// distinct from KNOWN_CALLER_POLICY's empty vaultKeys, so authorization
// failures below are genuinely exercising the vaultKeys check, not just
// "caller unknown".
// "127.0.0.1" alongside the real provider host so the withFakeUpstream-based
// tests below (which stand up a real local listener as the "target") stay
// within this caller's allowedHosts -- a separate DISALLOWED_HOST_POLICY
// below intentionally omits it to exercise the host-restriction gate.
const CREDENTIAL_POLICY: PolicyDocument = {
  "llm-handler": { allowedHosts: ["api.anthropic.com", "127.0.0.1"], vaultKeys: ["LLM_KEYS_ANTHROPIC"], maxUsdPerDay: null },
};
const DISALLOWED_HOST_POLICY: PolicyDocument = {
  "llm-handler": { allowedHosts: ["api.anthropic.com"], vaultKeys: ["LLM_KEYS_ANTHROPIC"], maxUsdPerDay: null },
};
const PROVISIONED_CREDENTIALS = { LLM_KEYS_ANTHROPIC: "sk-ant-real-secret" };
// llm-handler's authenticated bearer token (issue #186 round-2: `token` is
// now actually verified, not just shape-checked) -- every test below that
// expects a credential request to be GRANTED must present this exact value;
// tests that intentionally trigger a 403 may use any other string.
const REAL_CALLER_TOKENS = { "llm-handler": "the-real-llm-handler-token" };

function bodyText(result: { body: Buffer }): string {
  return result.body.toString("utf8");
}

function bodyJSON(result: { body: Buffer }): unknown {
  return JSON.parse(bodyText(result));
}

// A real local HTTP server standing in for a third-party target host --
// an independent oracle for "was the request actually forwarded and the
// response actually relayed," not an assertion derived from proxyRequest's
// own implementation.
function withFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        await fn(port);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

// Issue #186 round-2 independent review's finding (NEW-2): a credential-
// bearing request must be refused unless protocol is "https" -- proving
// the SUCCESS path (credential actually delivered) therefore requires a
// real TLS handshake, not just an http.createServer stand-in. A throwaway
// self-signed cert generated once via the system `openssl` binary (same
// tool docs/ops/restic-setup.sh and bootstrap-vps.sh already shell out to
// elsewhere in this repo); NODE_TLS_REJECT_UNAUTHORIZED is set only for the
// duration of each call that needs it and always restored, since this test
// process is the one making the outbound connection through the broker.
function generateSelfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "broker-tls-test-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1",
    ]);
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SELF_SIGNED = generateSelfSignedCert();

async function withFakeHttpsUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = https.createServer({ key: SELF_SIGNED.key, cert: SELF_SIGNED.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    await fn(port);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("proxyRequest: missing required fields is refused with a 400 and no upstream call is ever attempted", async () => {
  const logged: ProxyLogEntry[] = [];
  const result = await proxyRequest({ caller: "llm-handler" }, EMPTY_POLICY, { log: (entry) => logged.push(entry) });
  assert.equal(result.status, 400);
  const parsed = bodyJSON(result) as { error: string; details: string[] };
  assert.equal(parsed.error, "invalid broker request");
  assert.ok(parsed.details.length > 0);
  assert.equal(logged.length, 0, "an invalid request has nothing valid to log and must not be logged");
});

test("proxyRequest: never throws on malformed input -- a function, an array, or null are all refused, not crashed on", async () => {
  for (const malformed of [() => {}, ["not", "an", "object"], null, "a string", 42]) {
    const result = await proxyRequest(malformed, EMPTY_POLICY);
    assert.equal(result.status, 400);
  }
});

// Every case below is a value that would previously have reached
// node:http's own request layer and thrown a Node-internal
// TypeError/RangeError (leaked verbatim to the caller, and for the body
// case, left a connected socket open with nothing to ever close it -- an
// independent adversarial review of this file's first draft measured file
// descriptors climbing under exactly this load). None of these may ever
// open a socket: forward() must never run.
test("proxyRequest: rejects every field that would otherwise reach node:http's request layer unsafely, with a clean 400, before any socket opens", async () => {
  const base = { caller: "llm-handler", token: "t", targetHost: "127.0.0.1:1" };
  const cases: [string, Record<string, unknown>][] = [
    ["header name with a space", { ...base, headers: { "bad name": "x" } }],
    ["header value with embedded CRLF (header injection)", { ...base, headers: { "x-a": "a\r\nX-Injected: 1" } }],
    // Round-2 independent review's finding: a CRLF-only check on header
    // VALUES (this file's own first fix) missed every other C0 control and
    // every code point above 0xFF -- a bare non-Latin-1 character or a NUL
    // byte still reached node:http unvalidated and threw its own internal
    // TypeError. Exhaustively fuzzed 0x0-0x2FF against this exact field by
    // that review; these four are representative, not exhaustive.
    ["header value containing a non-Latin-1 character (e.g. euro sign)", { ...base, headers: { "x-a": "€" } }],
    ["header value containing a NUL byte", { ...base, headers: { "x-a": "a\x00b" } }],
    ["header value containing a vertical-tab control character", { ...base, headers: { "x-a": "a\x0bb" } }],
    ["header value containing a lone UTF-16 surrogate", { ...base, headers: { "x-a": "a\ud800b" } }],
    ["headers as an array, not an object", { ...base, headers: ["a"] }],
    ["method containing a space (request-line injection)", { ...base, method: "GET /evil HTTP/1.1" }],
    ["method as a number", { ...base, method: 42 }],
    ["path containing a space", { ...base, path: "/a b" }],
    ["path containing embedded CRLF", { ...base, path: "/a\r\nX: 1" }],
    ["targetHost containing embedded CRLF", { ...base, targetHost: "127.0.0.1\r\nX: 1" }],
    ["targetHost with a garbage (non-numeric-suffix) port", { ...base, targetHost: "127.0.0.1:99999x" }],
    ["targetHost with a port above 65535", { ...base, targetHost: "127.0.0.1:99999" }],
    ["targetHost with a stray second colon (ambiguous)", { ...base, targetHost: "127.0.0.1:1:9999" }],
    ["body that is not a string", { ...base, body: { a: 1 } }],
  ];
  for (const [label, malformed] of cases) {
    const result = await proxyRequest(malformed, KNOWN_CALLER_POLICY);
    assert.equal(result.status, 400, `${label}: expected 400, got ${result.status} (body: ${bodyText(result)})`);
    const parsed = bodyJSON(result) as { error: string };
    assert.equal(parsed.error, "invalid broker request", `${label}: must be refused as a broker-request validation error, not an upstream failure`);
  }
});

test("proxyRequest: legitimate header values (a real bearer token, a tab, latin-1 bytes) are forwarded, not rejected -- the fix is not overly broad", async () => {
  await withFakeUpstream(
    (req, res) => {
      assert.equal(req.headers.authorization, "Bearer sk-ant-api03-xyz_-ABC.123");
      assert.equal(req.headers["x-with-tab"], "a\tb");
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        {
          caller: "llm-handler",
          token: "t",
          targetHost: `127.0.0.1:${port}`,
          protocol: "http",
          headers: { authorization: "Bearer sk-ant-api03-xyz_-ABC.123", "x-with-tab": "a\tb" },
        },
        KNOWN_CALLER_POLICY,
      );
      assert.equal(result.status, 200);
    },
  );
});

test("proxyRequest: a targetHost's port is parsed exactly, never silently coerced -- the logged host:port is what was actually contacted", async () => {
  // The demonstrated failure mode: a bare Number() cast on a garbage port
  // suffix produces NaN, which node:http silently replaces with the
  // protocol default port -- so the audit log would record a host:port the
  // broker never actually reached. Confirmed fixed by construction: the
  // malformed-port cases above are refused outright rather than reaching
  // forward() with a wrong port at all.
  await withFakeUpstream(
    (_req, res) => {
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const logged: ProxyLogEntry[] = [];
      await proxyRequest(
        { caller: "llm-handler", token: "t", targetHost: `127.0.0.1:${port}`, protocol: "http" },
        KNOWN_CALLER_POLICY,
        { log: (entry) => logged.push(entry) },
      );
      assert.equal(logged[0]!.targetHost, `127.0.0.1:${port}`);
    },
  );
});

test("proxyRequest: a known caller is logged with knownCaller=true, caller, targetHost, and a real ISO timestamp", async () => {
  await withFakeUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    },
    async (port) => {
      const logged: ProxyLogEntry[] = [];
      const before = Date.now();
      await proxyRequest(
        { caller: "llm-handler", token: "t", targetHost: `127.0.0.1:${port}`, protocol: "http" },
        KNOWN_CALLER_POLICY,
        { log: (entry) => logged.push(entry) },
      );
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.caller, "llm-handler");
      assert.equal(logged[0]!.targetHost, `127.0.0.1:${port}`);
      assert.equal(logged[0]!.knownCaller, true);
      const loggedAt = new Date(logged[0]!.timestamp).getTime();
      assert.ok(loggedAt >= before && loggedAt <= Date.now(), "timestamp must be a real, current ISO time, not a placeholder");
    },
  );
});

test("proxyRequest: an UNKNOWN caller is logged with knownCaller=false but is still proxied -- log-only means no denial yet", async () => {
  // The exact behavior this Issue's own acceptance criteria calls for:
  // deny-by-default enforcement is issue #187's soak-then-approve flip, not
  // this skeleton. A plausible wrong implementation: refuse an unknown
  // caller early, defeating the log-only design.
  await withFakeUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reached the target");
    },
    async (port) => {
      const logged: ProxyLogEntry[] = [];
      const result = await proxyRequest(
        { caller: "never-declared", token: "t", targetHost: `127.0.0.1:${port}`, protocol: "http" },
        EMPTY_POLICY,
        { log: (entry) => logged.push(entry) },
      );
      assert.equal(logged[0]!.knownCaller, false);
      assert.equal(result.status, 200);
      assert.equal(bodyText(result), "reached the target");
    },
  );
});

test("proxyRequest: forwards method, path, headers, and body to the target, and relays the target's response status and body unmodified", async () => {
  await withFakeUpstream(
    (req, res) => {
      let received = "";
      req.on("data", (chunk: Buffer) => (received += chunk));
      req.on("end", () => {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v1/complete");
        assert.equal(req.headers["x-caller-header"], "present");
        assert.equal(received, '{"prompt":"hello"}');
        res.writeHead(201, { "content-type": "application/json" });
        res.end('{"answer":"world"}');
      });
    },
    async (port) => {
      const result = await proxyRequest(
        {
          caller: "llm-handler",
          token: "t",
          targetHost: `127.0.0.1:${port}`,
          protocol: "http",
          method: "POST",
          path: "/v1/complete",
          headers: { "x-caller-header": "present" },
          body: '{"prompt":"hello"}',
        },
        KNOWN_CALLER_POLICY,
      );
      assert.equal(result.status, 201);
      assert.equal(result.headers["content-type"], "application/json");
      assert.equal(bodyText(result), '{"answer":"world"}');
    },
  );
});

test("proxyRequest: relays the FULL upstream header set, not just content-type -- Location, Set-Cookie, and custom headers all survive", async () => {
  await withFakeUpstream(
    (_req, res) => {
      res.writeHead(302, {
        "content-type": "text/plain",
        location: "https://example.com/next",
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
        "x-ratelimit-remaining": "42",
      });
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        { caller: "llm-handler", token: "t", targetHost: `127.0.0.1:${port}`, protocol: "http" },
        KNOWN_CALLER_POLICY,
      );
      assert.equal(result.status, 302);
      assert.equal(result.headers.location, "https://example.com/next");
      assert.deepEqual(result.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
      assert.equal(result.headers["x-ratelimit-remaining"], "42");
    },
  );
});

test("proxyRequest: never drops hop-by-hop headers into the relayed response (they describe the upstream connection, not this one)", async () => {
  await withFakeUpstream(
    (_req, res) => {
      // node:http manages connection/transfer-encoding itself; setting them
      // explicitly here still exercises the filter if the server honors it.
      res.writeHead(200, { connection: "close", "x-real-header": "kept" });
      res.end("body");
    },
    async (port) => {
      const result = await proxyRequest(
        { caller: "llm-handler", token: "t", targetHost: `127.0.0.1:${port}`, protocol: "http" },
        KNOWN_CALLER_POLICY,
      );
      assert.equal(result.headers.connection, undefined);
      assert.equal(result.headers["x-real-header"], "kept");
    },
  );
});

// Round-2 independent review's finding (NEW-3): the destination TCP
// host:port is what authorizeCredential's allowedHosts check constrains,
// but a caller-supplied `Host` header controls virtual-host routing AT the
// destination independently of that -- domain fronting. Applies to every
// forwarded request, not just credentialed ones (the same class of bug
// #185's own original design already should have closed for headers that
// describe the connection, not the payload).
test("proxyRequest: a caller-supplied Host header is never relayed -- node:http's own Host, derived from the actual TCP destination, is what the upstream sees", async () => {
  await withFakeUpstream(
    (req, res) => {
      assert.notEqual(req.headers.host, "evil.example.com");
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        {
          caller: "llm-handler",
          token: "t",
          targetHost: `127.0.0.1:${port}`,
          protocol: "http",
          headers: { host: "evil.example.com" },
        },
        KNOWN_CALLER_POLICY,
      );
      assert.equal(result.status, 200);
    },
  );
});

// A caller-supplied content-length that disagrees with the actual body
// previously let the upstream read exactly the DECLARED byte count and
// treat the remaining bytes as the start of a second, smuggled request --
// classic HTTP request smuggling. Stripping it lets node:http decide its
// own framing (here: chunked, since no length is pre-declared) rather than
// trusting a caller-supplied number that may not match what is actually
// written.
test("proxyRequest: a caller-supplied content-length that disagrees with the actual body is never relayed -- no request-smuggling via a falsified length", async () => {
  await withFakeUpstream(
    (req, res) => {
      let received = "";
      req.on("data", (chunk: Buffer) => (received += chunk));
      req.on("end", () => {
        // The full body must be read as ONE request, not truncated to the
        // caller-declared 5 bytes with the remainder left to be misread as
        // a second request's start.
        assert.equal(received, '{"prompt":"12345678"}');
        // The falsified value must never survive on the wire -- whether
        // node:http ends up omitting content-length (chunked framing) or
        // recomputing it correctly is an implementation detail this test
        // doesn't pin down.
        assert.notEqual(req.headers["content-length"], "5");
        res.writeHead(200, {});
        res.end();
      });
    },
    async (port) => {
      const body = '{"prompt":"12345678"}';
      const result = await proxyRequest(
        {
          caller: "llm-handler",
          token: "t",
          targetHost: `127.0.0.1:${port}`,
          protocol: "http",
          method: "POST",
          headers: { "content-length": "5" }, // falsified -- must never reach the wire
          body,
        },
        KNOWN_CALLER_POLICY,
      );
      assert.equal(result.status, 200);
    },
  );
});

test("proxyRequest: relays a multi-byte UTF-8 character split across two separate upstream writes without corruption", async () => {
  // The demonstrated failure mode: `data += chunk` implicitly calls
  // Buffer.prototype.toString() on EACH chunk independently, so a
  // multi-byte character whose bytes land in two different chunks is
  // corrupted into two replacement characters. Buffer.concat (this file's
  // actual fix) only decodes/relays once the full body is assembled.
  const euroSignBytes = Buffer.from("€", "utf8"); // E2 82 AC
  await withFakeUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write(euroSignBytes.subarray(0, 1));
      res.write(euroSignBytes.subarray(1));
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        { caller: "llm-handler", token: "t", targetHost: `127.0.0.1:${port}`, protocol: "http" },
        KNOWN_CALLER_POLICY,
      );
      assert.equal(bodyText(result), "€");
    },
  );
});

test("proxyRequest: defaults to GET / when method and path are omitted", async () => {
  await withFakeUpstream(
    (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/");
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        { caller: "llm-handler", token: "t", targetHost: `127.0.0.1:${port}`, protocol: "http" },
        KNOWN_CALLER_POLICY,
      );
      assert.equal(result.status, 200);
    },
  );
});

test("proxyRequest: an unreachable target answers with 502, never throws or hangs the caller's promise", async () => {
  // Port 1 on loopback is reliably refused (privileged, nothing listens).
  const result = await proxyRequest(
    { caller: "llm-handler", token: "t", targetHost: "127.0.0.1:1", protocol: "http" },
    KNOWN_CALLER_POLICY,
  );
  assert.equal(result.status, 502);
  const parsed = bodyJSON(result) as { error: string };
  assert.equal(parsed.error, "broker upstream request failed");
});

// Issue #186: credential brokering. Authorization here is a HARD gate (see
// proxy.ts's own authorizeCredential rationale) -- unlike the log-only
// caller-identity path above, every one of these must actually refuse, not
// merely log a would-have-refused entry.

test("proxyRequest: a caller authorized for the named vault key, with a valid token, gets the real credential injected into the forwarded request over TLS, never the raw name", async () => {
  await withFakeHttpsUpstream(
    (req, res) => {
      assert.equal(req.headers["x-api-key"], "sk-ant-real-secret");
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        {
          caller: "llm-handler",
          token: "the-real-llm-handler-token",
          targetHost: `127.0.0.1:${port}`,
          protocol: "https",
          credential: "LLM_KEYS_ANTHROPIC",
          credentialHeader: "x-api-key",
        },
        CREDENTIAL_POLICY,
        { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS },
      );
      assert.equal(result.status, 200);
    },
  );
});

// Round-2 independent review's finding (NEW-2): a credential-bearing
// request over plain HTTP put the real secret on the wire in cleartext,
// even to an allowed host -- refused before any upstream call is attempted.
test("proxyRequest: a credential-bearing request over plain HTTP (protocol: \"http\") is refused with 403, even for an otherwise-fully-authorized caller+vaultKey+host", async () => {
  const result = await proxyRequest(
    {
      caller: "llm-handler",
      token: "the-real-llm-handler-token",
      targetHost: "127.0.0.1:1",
      protocol: "http",
      credential: "LLM_KEYS_ANTHROPIC",
      credentialHeader: "x-api-key",
    },
    CREDENTIAL_POLICY,
    { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS },
  );
  assert.equal(result.status, 403);
  const parsed = bodyJSON(result) as { error: string };
  assert.equal(parsed.error, "credential request refused");
});

test("proxyRequest: an unknown caller naming any credential is refused with 403, and no upstream call is ever attempted", async () => {
  const result = await proxyRequest(
    {
      caller: "never-declared",
      token: "t",
      targetHost: "127.0.0.1:1",
      protocol: "http",
      credential: "LLM_KEYS_ANTHROPIC",
      credentialHeader: "x-api-key",
    },
    CREDENTIAL_POLICY,
    { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS },
  );
  assert.equal(result.status, 403);
  const parsed = bodyJSON(result) as { error: string };
  assert.equal(parsed.error, "credential request refused");
});

test("proxyRequest: a known caller naming a vault key its own manifest never declared is refused with 403, even with a valid token", async () => {
  const result = await proxyRequest(
    {
      caller: "llm-handler",
      token: "the-real-llm-handler-token",
      targetHost: "127.0.0.1:1",
      protocol: "http",
      credential: "LLM_KEYS_OPENAI", // CREDENTIAL_POLICY only declares LLM_KEYS_ANTHROPIC for this caller
      credentialHeader: "x-api-key",
    },
    CREDENTIAL_POLICY,
    { credentials: { ...PROVISIONED_CREDENTIALS, LLM_KEYS_OPENAI: "sk-openai-real-secret" }, callerTokens: REAL_CALLER_TOKENS },
  );
  assert.equal(result.status, 403);
  const parsed = bodyJSON(result) as { error: string };
  assert.equal(parsed.error, "credential request refused");
});

// Round-2 independent review's finding: `token` was previously accepted as
// any non-empty string, shape-checked but never verified -- any process
// could self-assert `caller: "llm-handler"` and receive its credentials.
test("proxyRequest: a known caller declared for the vault key, but presenting the WRONG token, is refused with 403 -- caller identity is authenticated, not self-asserted", async () => {
  const result = await proxyRequest(
    {
      caller: "llm-handler",
      token: "an-attacker-guessed-token",
      targetHost: "127.0.0.1:1",
      protocol: "http",
      credential: "LLM_KEYS_ANTHROPIC",
      credentialHeader: "x-api-key",
    },
    CREDENTIAL_POLICY,
    { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS },
  );
  assert.equal(result.status, 403);
});

test("proxyRequest: a known, correctly-tokened caller naming a declared vault key is still refused (403) when the target host is not in that caller's own allowedHosts -- the credential gate's destination check is hard-enforced, not #187's soakable general egress allowlist", async () => {
  const result = await proxyRequest(
    {
      caller: "llm-handler",
      token: "the-real-llm-handler-token",
      targetHost: "attacker.example.com",
      protocol: "https",
      credential: "LLM_KEYS_ANTHROPIC",
      credentialHeader: "x-api-key",
    },
    DISALLOWED_HOST_POLICY,
    { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS },
  );
  assert.equal(result.status, 403);
  const parsed = bodyJSON(result) as { error: string };
  assert.equal(parsed.error, "credential request refused");
});

test("proxyRequest: a manifest-declared vault key that is not yet provisioned on this broker fails closed with 502, not a silently unauthenticated call", async () => {
  const result = await proxyRequest(
    {
      caller: "llm-handler",
      token: "the-real-llm-handler-token",
      targetHost: "127.0.0.1:1",
      protocol: "https",
      credential: "LLM_KEYS_ANTHROPIC",
      credentialHeader: "x-api-key",
    },
    CREDENTIAL_POLICY,
    { credentials: {}, callerTokens: REAL_CALLER_TOKENS }, // declared in policy, but never provisioned in this broker's own env
  );
  assert.equal(result.status, 502);
  const parsed = bodyJSON(result) as { error: string };
  assert.equal(parsed.error, "credential request refused");
});

// Round-2 independent review's finding: a plain `{}` object's `__proto__`
// key is an accessor that silently ignores a string assignment, so this
// previously vanished the injection entirely (200, credential absent) --
// exactly the "fail closed, never silently proxy without the credential"
// violation the file's own header comment promised couldn't happen.
test("proxyRequest: credentialHeader: \"__proto__\" still injects the credential as a real, present header -- never silently swallowed by the prototype chain", async () => {
  await withFakeHttpsUpstream(
    (req, res) => {
      // req.headers is a normal object -- node:http's OWN header parser hits
      // the identical __proto__-setter quirk populating it, independent of
      // anything this broker does, so it is not a valid oracle here.
      // req.rawHeaders is the flat wire-level [name, value, ...] array with
      // no object-key semantics at all: the only way to see what was
      // actually SENT on the wire, which is what injectCredential's fix is
      // actually responsible for.
      const idx = req.rawHeaders.findIndex((h) => h === "__proto__");
      assert.ok(idx !== -1, "expected a literal __proto__ header on the wire");
      assert.equal(req.rawHeaders[idx + 1], "sk-ant-real-secret");
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        {
          caller: "llm-handler",
          token: "the-real-llm-handler-token",
          targetHost: `127.0.0.1:${port}`,
          protocol: "https",
          credential: "LLM_KEYS_ANTHROPIC",
          credentialHeader: "__proto__",
        },
        CREDENTIAL_POLICY,
        { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS },
      );
      assert.equal(result.status, 200);
    },
  );
});

test("proxyRequest: a provisioned credential value that is not a valid HTTP header value (e.g. a trailing newline) fails closed with 502, never reaching node:http's own header-write path", async () => {
  const result = await proxyRequest(
    {
      caller: "llm-handler",
      token: "the-real-llm-handler-token",
      targetHost: "127.0.0.1:1",
      protocol: "https",
      credential: "LLM_KEYS_ANTHROPIC",
      credentialHeader: "x-api-key",
    },
    CREDENTIAL_POLICY,
    { credentials: { LLM_KEYS_ANTHROPIC: "sk-ant-real-secret\n" }, callerTokens: REAL_CALLER_TOKENS },
  );
  assert.equal(result.status, 502);
  const parsed = bodyJSON(result) as { error: string };
  assert.equal(parsed.error, "credential request refused");
});

test("proxyRequest: a refused credential request is logged with credentialGranted=false and the vault key name it asked for -- the audit trail distinguishes refused from forwarded", async () => {
  const logged: ProxyLogEntry[] = [];
  await proxyRequest(
    {
      caller: "never-declared",
      token: "t",
      targetHost: "127.0.0.1:1",
      protocol: "http",
      credential: "LLM_KEYS_ANTHROPIC",
      credentialHeader: "x-api-key",
    },
    CREDENTIAL_POLICY,
    { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS, log: (entry) => logged.push(entry) },
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.credentialRequested, "LLM_KEYS_ANTHROPIC");
  assert.equal(logged[0]!.credentialGranted, false);
});

test("proxyRequest: a granted credential request is logged with credentialGranted=true", async () => {
  await withFakeHttpsUpstream(
    (_req, res) => {
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const logged: ProxyLogEntry[] = [];
      await proxyRequest(
        {
          caller: "llm-handler",
          token: "the-real-llm-handler-token",
          targetHost: `127.0.0.1:${port}`,
          protocol: "https",
          credential: "LLM_KEYS_ANTHROPIC",
          credentialHeader: "x-api-key",
        },
        CREDENTIAL_POLICY,
        { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS, log: (entry) => logged.push(entry) },
      );
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.credentialRequested, "LLM_KEYS_ANTHROPIC");
      assert.equal(logged[0]!.credentialGranted, true);
    },
  );
});

test("proxyRequest: a caller-supplied value for the same header name as credentialHeader is always overwritten, never leaked through to the real forwarded request", async () => {
  await withFakeHttpsUpstream(
    (req, res) => {
      assert.equal(req.headers["x-api-key"], "sk-ant-real-secret");
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        {
          caller: "llm-handler",
          token: "the-real-llm-handler-token",
          targetHost: `127.0.0.1:${port}`,
          protocol: "https",
          headers: { "X-Api-Key": "caller-supplied-value-must-not-survive" },
          credential: "LLM_KEYS_ANTHROPIC",
          credentialHeader: "x-api-key",
        },
        CREDENTIAL_POLICY,
        { credentials: PROVISIONED_CREDENTIALS, callerTokens: REAL_CALLER_TOKENS },
      );
      assert.equal(result.status, 200);
    },
  );
});

test("proxyRequest: a request naming neither credential nor credentialHeader is unaffected by the credential path (log-only pass-through unchanged) -- no token authentication required when no credential is requested", async () => {
  await withFakeUpstream(
    (req, res) => {
      assert.equal(req.headers["x-api-key"], undefined);
      res.writeHead(200, {});
      res.end();
    },
    async (port) => {
      const result = await proxyRequest(
        { caller: "llm-handler", token: "t", targetHost: `127.0.0.1:${port}`, protocol: "http" },
        CREDENTIAL_POLICY,
        { credentials: PROVISIONED_CREDENTIALS }, // no callerTokens at all -- must not matter for a non-credentialed request
      );
      assert.equal(result.status, 200);
    },
  );
});
