import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { proxyRequest, type ProxyLogEntry } from "../src/proxy.ts";
import type { PolicyDocument } from "../src/policy.ts";

const EMPTY_POLICY: PolicyDocument = {};
const KNOWN_CALLER_POLICY: PolicyDocument = {
  "llm-handler": { allowedHosts: ["api.anthropic.com"], vaultKeys: [], maxUsdPerDay: null },
};

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
  const parsed = JSON.parse(result.body) as { error: string; details: string[] };
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
      assert.equal(result.body, "reached the target");
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
      assert.equal(result.body, '{"answer":"world"}');
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
  const parsed = JSON.parse(result.body) as { error: string };
  assert.equal(parsed.error, "broker upstream request failed");
});
