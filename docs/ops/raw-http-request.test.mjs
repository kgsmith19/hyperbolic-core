import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { rawHttpRequest } from "./test-support/raw-http-request.mjs";

const traversalTargets = [
  ["/api//../settings", "/api/settings"],
  ["/api/%2F%2e%2e%2Fsettings", "/api/%2F%2e%2e%2Fsettings"],
  ["/%61pi//%2e%2e/settings", "/%61pi/settings"],
  ["/api/%2f/%2E.%2Fsettings", "/api/%2f/%2E.%2Fsettings"],
  ["/api//v1//../settings", "/api//v1/settings"],
  ["/assets///../settings", "/assets//settings"],
  ["/%61ssets/%2F/%2e%2E/settings", "/%61ssets/settings"],
  ["/life/api//%2e%2e/capture", "/life/api/capture"],
  [
    "/%6Cife/%61pi/%2f/%2E.%2Fcapture",
    "/%6Cife/%61pi/%2f/%2E.%2Fcapture",
  ],
  [
    "/life/assets/%2F%2e%2E%2fcapture",
    "/life/assets/%2F%2e%2E%2fcapture",
  ],
  ["/%6cife/%61ssets///../capture", "/%6cife/%61ssets//capture"],
];

const normalizationPrefixTargets = [
  "/%2Fapi/%2e%2e/settings",
  "//api/../settings",
  "/./assets/../settings",
  "/%2Flife/api/%2e%2e/capture",
  "//life/api/../capture",
  "/./life/assets/../capture",
  "/%2F%61pi/%2e%2e/settings",
  "//assets/../settings",
  "/./%2E/%61ssets/%2e%2E/settings",
  "/%2Flife/%61pi/%2e%2e/capture",
  "//%6Cife/assets/../capture",
  "/./life/%2E/%61pi/%2e%2e/capture",
  "/%2E/%6cife/%2F%61ssets/%2e%2E/capture",
  "/foo/../api/../settings",
  "/%66oo/%2e%2e/%61pi/%2e%2e/settings",
  "//foo/../api/../settings",
  "/%2Ffoo/%2e%2e/api/%2e%2e/settings",
  "/life/foo/../assets/../capture",
  "/life/%66oo/%2e%2e/%61ssets/%2e%2e/capture",
  "/alpha/beta/../../api/v1/../../settings",
  "/life/one/two/../../assets/v1/../../capture",
  "/%41pi/%2e%2e/settings",
  "/%41%50%49/%2e%2e/settings",
  "/%61%50i/%2e%2e/settings",
  "/%41ssets/../settings",
  "/%41%53%53%45%54%53/%2e%2e/settings",
  "/%61%53s%65%54%73/%2e%2e/settings",
  "/life/%41ssets/../capture",
  "/life/%41%73%53e%54%73/%2e%2e/capture",
];

const traversalNegativeTargets = [
  "/lifefoo",
  "/api/healthz",
  "/assets/shell.js",
  "/docs/api/reference",
  "/settings?return=/api/../x",
  "/settings?return=/%41pi/../x",
  "/life/entities/id%2Fwith%2Fslashes",
];

async function startCaptureServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    openConnectionCount() {
      return sockets.size;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("WHATWG fetch normalizes literal dot segments before the origin receives them", async () => {
  const seenTargets = [];
  const fixture = await startCaptureServer((request, response) => {
    seenTargets.push(request.url);
    response.writeHead(204).end();
  });
  try {
    for (const [requestTarget, normalizedTarget] of traversalTargets) {
      const response = await fetch(`${fixture.origin}${requestTarget}`);
      assert.equal(response.status, 204, requestTarget);
      assert.equal(seenTargets.pop(), normalizedTarget, requestTarget);
    }
  } finally {
    await fixture.close();
  }
});

test("raw HTTP requests preserve every traversal target and capture the response", async () => {
  const seenTargets = [];
  const fixture = await startCaptureServer((request, response) => {
    seenTargets.push(request.url);
    response.writeHead(409, {
      "content-type": "text/plain; charset=utf-8",
      "x-raw-fixture": "captured",
    });
    response.end(`seen:${request.url}`);
  });
  try {
    for (const requestTarget of [
      ...traversalTargets.map(([target]) => target),
      ...normalizationPrefixTargets,
      ...traversalNegativeTargets,
    ]) {
      const response = await rawHttpRequest(fixture.origin, requestTarget);
      assert.equal(response.rawRequestTarget, requestTarget, requestTarget);
      assert.equal(seenTargets.pop(), requestTarget, requestTarget);
      assert.equal(response.status, 409, requestTarget);
      assert.equal(response.headers["x-raw-fixture"], "captured", requestTarget);
      assert.equal(response.body, `seen:${requestTarget}`, requestTarget);
    }
  } finally {
    await fixture.close();
  }
});

test("raw HTTP requests time out and release a stalled connection", async () => {
  const fixture = await startCaptureServer(() => {});
  try {
    await assert.rejects(
      rawHttpRequest(fixture.origin, "/stall", { timeoutMs: 25 }),
    );
    for (
      let attempt = 0;
      attempt < 25 && fixture.openConnectionCount();
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fixture.openConnectionCount(), 0);
  } finally {
    await fixture.close();
  }
});

test("raw HTTP requests reject oversized response bodies", async () => {
  const fixture = await startCaptureServer((_request, response) => {
    response.end("too-large");
  });
  try {
    await assert.rejects(
      rawHttpRequest(fixture.origin, "/large", { maxBodyBytes: 4 }),
      /exceeded 4 bytes/,
    );
  } finally {
    await fixture.close();
  }
});

test("raw HTTP requests surface connection errors", async () => {
  const fixture = await startCaptureServer((_request, response) => {
    response.end();
  });
  const origin = fixture.origin;
  await fixture.close();
  await assert.rejects(rawHttpRequest(origin, "/unreachable"));
});
