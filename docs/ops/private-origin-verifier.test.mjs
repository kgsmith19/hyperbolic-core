import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const opsDirectory = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(opsDirectory, "verify-private-origin.sh");
const verifierSource = readFileSync(verifier, "utf8");
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "private-origin-verifier-"));
const requestLog = path.join(fixtureRoot, "requests.log");
const probeTemp = path.join(fixtureRoot, "probe-temp");
const serverScript = path.join(fixtureRoot, "server.mjs");
let origin;
let server;

const shellDocument = '<!doctype html><script type="module" src="/assets/index-shell.js"></script>';
const lifeDocument = '<!doctype html><script type="module" src="/life/assets/index-life.js"></script>';

before(async () => {
  mkdirSync(probeTemp);
  writeFileSync(
    serverScript,
    `import { appendFileSync } from "node:fs";
import http from "node:http";

const shellDocument = ${JSON.stringify(shellDocument)};
const lifeDocument = ${JSON.stringify(lifeDocument)};
const reservedTraversalRoutes = [
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
  "/api/%2e%2e%2Fsettings",
  "/api/%2F%2e%2e%2Fsettings",
  "/assets/%2e%2e%2Fsettings",
  "/assets//%2e%2e/settings",
  "/life/api/%2e%2e%2Fcapture",
  "/life/api//%2e%2e/capture",
  "/life/assets/%2e%2e%2Fcapture",
  "/life/assets/%2F%2E%2e%2fcapture",
  "/%41pi/%2e%2e/settings",
  "/%41%50%49/%2e%2e/settings",
  "/%61%50i/%2e%2e/settings",
  "/%41ssets/../settings",
  "/%41%53%53%45%54%53/%2e%2e/settings",
  "/%61%53s%65%54%73/%2e%2e/settings",
  "/life/%41ssets/../capture",
  "/life/%41%73%53e%54%73/%2e%2e/capture",
];

const server = http.createServer((request, response) => {
  const pathname = request.url.split("?", 1)[0];
  appendFileSync(process.env.PRIVATE_ORIGIN_REQUEST_LOG, request.url + "\\n");
  const [, scenario, ...segments] = pathname.split("/");
  const route = "/" + segments.join("/");
  let body;
  let contentType;
  let status = 200;

  if (route === "/login" || route === "/settings") {
    body = scenario === "swapped" ? lifeDocument : shellDocument;
    contentType = "text/html; charset=utf-8";
  } else if (route === "/life/capture") {
    body = scenario === "swapped" ? shellDocument : lifeDocument;
    contentType = "text/html; charset=utf-8";
  } else if ([
    "/assets/__ops_origin_missing__.js",
    "/life/assets/__ops_origin_missing__.js",
  ].includes(route)) {
    status = 404;
    body = "missing asset";
    contentType = "text/plain";
    if (
      (scenario === "shell-asset-fallback" && route === "/assets/__ops_origin_missing__.js") ||
      (scenario === "life-asset-fallback" && route === "/life/assets/__ops_origin_missing__.js")
    ) {
      status = 200;
      body = route.startsWith("/life/") ? lifeDocument : shellDocument;
      contentType = "text/html; charset=utf-8";
    }
  } else if ([
    "/api/__ops_origin_boundary__.js",
    "/api/brain/__ops_origin_boundary__.js",
    "/life/api/__ops_origin_boundary__.js",
  ].includes(route)) {
    status = 404;
    body = '{"detail":"not found"}';
    contentType = "application/json; charset=utf-8";
    const boundary = route.startsWith("/api/brain/")
      ? "brain"
      : route.startsWith("/life/api/")
        ? "life"
        : "handler";
    if (scenario === boundary + "-boundary-fallback") {
      status = 200;
    }
    if (scenario === boundary + "-boundary-html") {
      body = shellDocument;
      contentType = "text/html; charset=utf-8";
    }
  } else if (reservedTraversalRoutes.includes(route)) {
    status = 404;
    body = "reserved namespace traversal rejected";
    contentType = "text/plain; charset=utf-8";
    const traversalScenario = "reserved-traversal-" + String(
      reservedTraversalRoutes.indexOf(route),
    );
    if (scenario === traversalScenario) {
      status = 200;
      body = route.startsWith("/life/") ? lifeDocument : shellDocument;
      contentType = "text/html; charset=utf-8";
    }
  } else if (["/api/healthz", "/api/brain/health", "/life/api/healthz"].includes(route)) {
    body = '{"status":"ok"}';
    contentType = "application/json; charset=utf-8";
    if (scenario === "api-html" && route === "/api/healthz") {
      body = shellDocument;
      contentType = "text/html; charset=utf-8";
    }
    if (scenario === "api-mislabeled" && route === "/api/brain/health") {
      contentType = "text/plain";
    }
    if (scenario === "api-array" && route === "/life/api/healthz") {
      body = '[{"status":"ok"}]';
    }
    if (scenario === "api-created" && route === "/api/healthz") {
      status = 201;
    }
    if (scenario === "api-not-ok" && route === "/api/healthz") {
      body = '{"status":"degraded"}';
    }
    if (scenario === "api-malformed" && route === "/api/brain/health") {
      body = '{not-json';
    }
  } else {
    status = 404;
    body = "missing";
    contentType = "text/plain";
  }

  response.writeHead(status, { "content-type": contentType });
  response.end(body);
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port) + "\\n");
});
`,
  );
  server = spawn(process.execPath, [serverScript], {
    env: { ...process.env, PRIVATE_ORIGIN_REQUEST_LOG: requestLog },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [portChunk] = await once(server.stdout, "data");
  origin = `http://127.0.0.1:${String(portChunk).trim()}`;
});

after(() => {
  server?.kill();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function verifyScenario(scenario, verifierPath = verifier) {
  writeFileSync(requestLog, "");
  const result = spawnSync(process.env.BASH_PATH ?? "bash", [verifierPath, `${origin}/${scenario}`], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: probeTemp },
  });
  assert.deepEqual(readdirSync(probeTemp), [], "the verifier must remove its bounded response directory");
  return {
    requests: readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean),
    result,
  };
}

function assertBoundedSignalCleanup(source) {
  const exitTrap = source.indexOf("trap cleanup EXIT");
  const temporaryDirectory = source.indexOf('temporary_directory="$(mktemp -d');
  assert.ok(exitTrap > -1 && temporaryDirectory > exitTrap, "cleanup must be armed before mktemp");
  assert.match(source, /trap 'exit 130' INT/);
  assert.match(source, /trap 'exit 143' TERM/);
  assert.match(source, /trap 'exit 129' HUP/);
  assert.match(
    source,
    /find "\$temporary_directory" -mindepth 1 -maxdepth 1 -type f -delete\s+rmdir "\$temporary_directory"/,
  );
  assert.doesNotMatch(source, /rm -rf/);
}

test("response cleanup is bounded and armed before work for EXIT and signals", () => {
  assertBoundedSignalCleanup(verifierSource);
  for (const mutant of [
    verifierSource.replace("trap cleanup EXIT", "# EXIT cleanup removed"),
    verifierSource.replace("trap 'exit 129' HUP", "# HUP handling removed"),
    verifierSource.replace("-maxdepth 1", "-maxdepth 2"),
  ]) {
    assert.throws(() => assertBoundedSignalCleanup(mutant));
  }
});

test("content-aware verification probes documents, missing assets, API boundaries, and health", () => {
  const { requests, result } = verifyScenario("ok");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests, [
    "/ok/login",
    "/ok/settings",
    "/ok/settings?return=/%41pi/../x",
    "/ok/life/capture",
    "/ok/assets/__ops_origin_missing__.js",
    "/ok/life/assets/__ops_origin_missing__.js",
    "/ok/api/__ops_origin_boundary__.js",
    "/ok/api/brain/__ops_origin_boundary__.js",
    "/ok/life/api/__ops_origin_boundary__.js",
    "/ok/%2Fapi/%2e%2e/settings",
    "/ok//api/../settings",
    "/ok/./assets/../settings",
    "/ok/%2Flife/api/%2e%2e/capture",
    "/ok//life/api/../capture",
    "/ok/./life/assets/../capture",
    "/ok/%2F%61pi/%2e%2e/settings",
    "/ok//assets/../settings",
    "/ok/./%2E/%61ssets/%2e%2E/settings",
    "/ok/%2Flife/%61pi/%2e%2e/capture",
    "/ok//%6Cife/assets/../capture",
    "/ok/./life/%2E/%61pi/%2e%2e/capture",
    "/ok/%2E/%6cife/%2F%61ssets/%2e%2E/capture",
    "/ok/foo/../api/../settings",
    "/ok/%66oo/%2e%2e/%61pi/%2e%2e/settings",
    "/ok//foo/../api/../settings",
    "/ok/%2Ffoo/%2e%2e/api/%2e%2e/settings",
    "/ok/life/foo/../assets/../capture",
    "/ok/life/%66oo/%2e%2e/%61ssets/%2e%2e/capture",
    "/ok/alpha/beta/../../api/v1/../../settings",
    "/ok/life/one/two/../../assets/v1/../../capture",
    "/ok/api/%2e%2e%2Fsettings",
    "/ok/api/%2F%2e%2e%2Fsettings",
    "/ok/assets/%2e%2e%2Fsettings",
    "/ok/assets//%2e%2e/settings",
    "/ok/life/api/%2e%2e%2Fcapture",
    "/ok/life/api//%2e%2e/capture",
    "/ok/life/assets/%2e%2e%2Fcapture",
    "/ok/life/assets/%2F%2E%2e%2fcapture",
    "/ok/%41pi/%2e%2e/settings",
    "/ok/%41%50%49/%2e%2e/settings",
    "/ok/%61%50i/%2e%2e/settings",
    "/ok/%41ssets/../settings",
    "/ok/%41%53%53%45%54%53/%2e%2e/settings",
    "/ok/%61%53s%65%54%73/%2e%2e/settings",
    "/ok/life/%41ssets/../capture",
    "/ok/life/%41%73%53e%54%73/%2e%2e/capture",
    "/ok/api/healthz",
    "/ok/api/brain/health",
    "/ok/life/api/healthz",
  ]);
});

for (const [scenario, label] of [
  ["reserved-traversal-0", "Root API encoded-separator exact traversal"],
  ["reserved-traversal-1", "Root API duplicate-separator traversal"],
  ["reserved-traversal-2", "Root asset dot-prefix traversal"],
  ["reserved-traversal-3", "LifeOS API encoded-separator exact traversal"],
  ["reserved-traversal-4", "LifeOS API duplicate-separator traversal"],
  ["reserved-traversal-5", "LifeOS asset dot-prefix traversal"],
  ["reserved-traversal-6", "Root API encoded-separator prefix traversal"],
  ["reserved-traversal-7", "Root asset literal-separator prefix traversal"],
  ["reserved-traversal-8", "Root asset dot-component prefix traversal"],
  ["reserved-traversal-9", "LifeOS API encoded-separator prefix traversal"],
  ["reserved-traversal-10", "LifeOS asset literal-separator prefix traversal"],
  ["reserved-traversal-11", "LifeOS API dot-component prefix traversal"],
  ["reserved-traversal-12", "LifeOS asset mixed normalization prefix traversal"],
  ["reserved-traversal-13", "Root API cancelled-prefix traversal"],
  ["reserved-traversal-14", "Root API encoded cancelled-prefix traversal"],
  ["reserved-traversal-15", "Root API duplicate-separator cancelled-prefix traversal"],
  ["reserved-traversal-16", "Root API encoded-separator cancelled-prefix traversal"],
  ["reserved-traversal-17", "LifeOS asset cancelled-prefix traversal"],
  ["reserved-traversal-18", "LifeOS asset encoded cancelled-prefix traversal"],
  ["reserved-traversal-19", "Root API nested cancelled-prefix traversal"],
  ["reserved-traversal-20", "LifeOS asset nested cancelled-prefix traversal"],
  ["reserved-traversal-21", "Root API traversal"],
  ["reserved-traversal-22", "Root API adjacent-separator traversal"],
  ["reserved-traversal-23", "Root asset traversal"],
  ["reserved-traversal-24", "Root asset adjacent-separator traversal"],
  ["reserved-traversal-25", "LifeOS API traversal"],
  ["reserved-traversal-26", "LifeOS API adjacent-separator traversal"],
  ["reserved-traversal-27", "LifeOS asset traversal"],
  ["reserved-traversal-28", "LifeOS asset adjacent-separator traversal"],
  ["reserved-traversal-29", "Root API uppercase-A encoded traversal"],
  ["reserved-traversal-30", "Root API fully uppercase-byte traversal"],
  ["reserved-traversal-31", "Root API mixed encoded-byte traversal"],
  ["reserved-traversal-32", "Root asset uppercase-A encoded traversal"],
  ["reserved-traversal-33", "Root asset fully uppercase-byte traversal"],
  ["reserved-traversal-34", "Root asset mixed encoded-byte traversal"],
  ["reserved-traversal-35", "LifeOS asset uppercase-A encoded traversal"],
  ["reserved-traversal-36", "LifeOS asset mixed encoded-byte traversal"],
]) {
  test(`content-aware verification rejects ${scenario}`, () => {
    const { result } = verifyScenario(scenario);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`${label} must return HTTP 404`, "i"),
    );
  });
}

for (const [scenario, label] of [
  ["shell-asset-fallback", "Missing Shell asset"],
  ["life-asset-fallback", "Missing LifeOS asset"],
  ["handler-boundary-fallback", "Handler API boundary"],
  ["brain-boundary-fallback", "Brain API boundary"],
  ["life-boundary-fallback", "LifeOS API boundary"],
]) {
  test(`content-aware verification rejects ${scenario}`, () => {
    const { result } = verifyScenario(scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${label} must return HTTP 404`, "i"));
  });
}

for (const [scenario, label] of [
  ["handler-boundary-html", "Handler API boundary"],
  ["brain-boundary-html", "Brain API boundary"],
  ["life-boundary-html", "LifeOS API boundary"],
]) {
  test(`content-aware verification rejects ${scenario}`, () => {
    const { result } = verifyScenario(scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${label} must not return text/html`, "i"));
  });
}

for (const [scenario, failure] of [
  ["swapped", /Shell bundle/],
  ["api-html", /application\/json/],
  ["api-mislabeled", /application\/json/],
  ["api-array", /JSON object/],
  ["api-created", /HTTP 200/],
  ["api-not-ok", /status=ok/],
  ["api-malformed", /valid JSON/],
]) {
  test(`content-aware verification rejects ${scenario}`, () => {
    const { result } = verifyScenario(scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, failure);
  });
}

test("the API oracle fails if its top-level status=ok comparison is removed", () => {
  const comparison = `if body.get("status") != "ok":
    print(f"error: {label} JSON object must contain top-level status=ok", file=sys.stderr)
    raise SystemExit(1)`;
  assert.match(verifierSource, /if body\.get\("status"\) != "ok":/);
  const mutantSource = verifierSource.replace(comparison, "# status comparison removed");
  assert.notEqual(mutantSource, verifierSource, "the test mutation must alter the verifier");
  const mutantVerifier = path.join(fixtureRoot, "verify-private-origin-no-status-check.sh");
  writeFileSync(mutantVerifier, mutantSource);
  const { result } = verifyScenario("api-not-ok", mutantVerifier);
  assert.equal(
    result.status,
    0,
    "the negative control must survive all other checks when the status comparison is removed",
  );
});
