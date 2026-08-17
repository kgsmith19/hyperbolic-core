import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { proxyRequest, type ProxyLogEntry } from "../src/proxy.ts";
import type { PolicyDocument } from "../src/policy.ts";

const EMPTY_POLICY: PolicyDocument = {};
const KNOWN_CALLER_POLICY: PolicyDocument = {
  "llm-handler": { allowedHosts: ["api.anthropic.com"], vaultKeys: [], maxUsdPerDay: null },
};

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

test("proxyRequest: missing required fields is refused with a 400 and no upstream call is ever attempted", async () => {
  const logged: ProxyLogEntry[] = [];
  const result = await proxyRequest({ caller: "llm-handler" }, EMPTY_POLICY, (entry) => logged.push(entry));
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
        (entry) => logged.push(entry),
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
        (entry) => logged.push(entry),
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
        (entry) => logged.push(entry),
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
