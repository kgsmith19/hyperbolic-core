import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { startServer } from "../src/server.ts";
import type { PolicyDocument } from "../src/policy.ts";

const POLICY: PolicyDocument = { "llm-handler": { allowedHosts: [], vaultKeys: [], maxUsdPerDay: null } };

function requestJson(
  port: number,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("server: GET /healthz reports ok without touching the policy or any upstream", async () => {
  const server = await startServer(0, POLICY);
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const { status, body } = await requestJson(port, "/healthz", "GET");
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { status: "ok" });
  } finally {
    server.close();
  }
});

test("server: an unknown route is a plain 404, not a crash", async () => {
  const server = await startServer(0, POLICY);
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const { status } = await requestJson(port, "/nonexistent", "GET");
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test("server: POST /proxy end-to-end round-trips through the real HTTP server, not just proxyRequest() directly", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"forwarded":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const upstreamAddress = upstream.address();
    const upstreamPort = typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;

    const server = await startServer(0, POLICY);
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const { status, body } = await requestJson(port, "/proxy", "POST", {
        caller: "llm-handler",
        token: "t",
        targetHost: `127.0.0.1:${upstreamPort}`,
        protocol: "http",
      });
      assert.equal(status, 200);
      assert.deepEqual(JSON.parse(body), { forwarded: true });
    } finally {
      server.close();
    }
  } finally {
    upstream.close();
  }
});

test("server: a malformed JSON body on /proxy is answered with 400, not a hung connection or a 500", async () => {
  const server = await startServer(0, POLICY);
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/proxy", method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.write("{ not json");
      req.end();
    });
    assert.equal(result.status, 400);
  } finally {
    server.close();
  }
});
