import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rawHttpRequest } from "./test-support/raw-http-request.mjs";

const opsDir = path.dirname(fileURLToPath(import.meta.url));
const spaInclude = path.join(
  opsDir,
  "edge-origin",
  "private_spa_locations.conf",
);
const originConfig = path.join(opsDir, "edge-origin", "nginx.conf");
const nginxImage = "nginx:1.27-alpine";
const privateSpaIncludeDirective =
  "include /etc/nginx/private_spa_locations.conf;";

function probeDocker() {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
  });
}

function requireDocker({ ciIsSet, probeResult }) {
  if (probeResult.status === 0) return true;
  if (ciIsSet) {
    const detail =
      probeResult.error?.code ??
      probeResult.stderr?.trim() ??
      `exit status ${String(probeResult.status)}`;
    throw new Error(
      `Docker is required when CI is set; real-nginx proof cannot run (${detail})`,
    );
  }
  return false;
}

const dockerProbe = probeDocker();
const dockerAvailable = requireDocker({
  ciIsSet: false,
  probeResult: dockerProbe,
});

function locationBody(confText, openingLine) {
  const lines = confText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === openingLine);
  assert.notEqual(start, -1, `missing nginx block: ${openingLine}`);
  const body = [];
  let depth = 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const directive = lines[index].replace(/#.*/, "");
    depth += (directive.match(/\{/g) ?? []).length;
    depth -= (directive.match(/\}/g) ?? []).length;
    if (depth === 0) return body.join("\n");
    body.push(lines[index]);
  }
  assert.fail(`unterminated nginx block: ${openingLine}`);
}

function serverBlocks(confText) {
  const blocks = [];
  const lines = confText.split(/\r?\n/);
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() !== "server {") continue;
    let depth = 0;
    const body = [];
    for (let index = start; index < lines.length; index += 1) {
      const directive = lines[index].replace(/#.*/, "");
      depth += (directive.match(/\{/g) ?? []).length;
      depth -= (directive.match(/\}/g) ?? []).length;
      body.push(lines[index]);
      if (depth === 0) {
        blocks.push(body.join("\n"));
        start = index;
        break;
      }
    }
    assert.equal(depth, 0, "unterminated nginx server block");
  }
  return blocks;
}

function countOccurrences(text, value) {
  return text.split(value).length - 1;
}

function reservedOriginalRequestGuard(confText) {
  const guards = [
    ...confText.matchAll(
      /if\s*\(\$request_uri\s+~\*\s+"([^"]+)"\)\s*\{\s*return\s+404(?:\s+"[^"]*")?;\s*\}/g,
    ),
  ];
  assert.equal(
    guards.length,
    1,
    "reserved original-request policy must have one fail-closed guard",
  );
  return new RegExp(guards[0][1], "i");
}

function assertPrivateSpaIncludeIsolation(confText) {
  const blocks = serverBlocks(confText);
  const privateServers = blocks.filter((block) =>
    /\blisten\s+127\.0\.0\.1:8080;/.test(block),
  );
  const publicServers = blocks.filter((block) =>
    /\blisten\s+127\.0\.0\.1:8081;/.test(block),
  );
  assert.equal(
    privateServers.length,
    1,
    "expected exactly one private 8080 server",
  );
  assert.equal(
    publicServers.length,
    1,
    "expected exactly one public 8081 server",
  );
  assert.equal(
    countOccurrences(privateServers[0], privateSpaIncludeDirective),
    1,
    "private 8080 server must include the SPA routes exactly once",
  );
  assert.equal(
    countOccurrences(publicServers[0], privateSpaIncludeDirective),
    0,
    "public 8081 server must not include the private SPA routes",
  );
}

function privateGatewayConfig() {
  return `
worker_processes 1;
pid /tmp/private-spa-test.pid;

events {
  worker_connections 64;
}

http {
  server {
    listen 8080;
    server_name _;
    absolute_redirect off;

    location = /healthz {
      default_type text/plain;
      return 200 "ok";
    }

    # Issue #345 owns these proxy locations. The sentinel response proves
    # every API prefix wins over both SPA fallbacks, including asset-like API
    # paths that would otherwise match the missing-asset guard.
    location = /life/api {
      return 308 /life/api/;
    }

    location ^~ /life/api/ {
      default_type text/plain;
      return 418 "life-api";
    }

    location = /api/brain {
      return 308 /api/brain/;
    }

    location ^~ /api/brain/ {
      default_type text/plain;
      return 418 "brain-api";
    }

    location = /api {
      return 308 /api/;
    }

    location ^~ /api/ {
      default_type text/plain;
      return 418 "handler-api";
    }

    include /etc/nginx/private_spa_locations.conf;
  }
}
`;
}

function writeFixture(root) {
  const shellRoot = path.join(root, "shell");
  const lifeRoot = path.join(root, "life");
  mkdirSync(path.join(shellRoot, "assets"), { recursive: true });
  mkdirSync(path.join(lifeRoot, "assets"), { recursive: true });

  writeFileSync(
    path.join(shellRoot, "index.html"),
    "<!doctype html><title>shell-index</title>",
  );
  writeFileSync(
    path.join(shellRoot, "assets", "shell.js"),
    "globalThis.shellAsset = true;\n",
  );
  writeFileSync(
    path.join(shellRoot, "assets", "shell-manifest"),
    "shell-static-manifest\n",
  );
  writeFileSync(
    path.join(shellRoot, "styles.css"),
    "body { color: rgb(1, 2, 3); }\n",
  );
  writeFileSync(path.join(shellRoot, ".env"), "PRIVATE_SENTINEL=do-not-serve\n");
  mkdirSync(path.join(shellRoot, ".git"));
  writeFileSync(path.join(shellRoot, ".git", "config"), "private-git-config\n");

  writeFileSync(
    path.join(lifeRoot, "index.html"),
    "<!doctype html><title>life-index</title>",
  );
  writeFileSync(
    path.join(lifeRoot, "assets", "life.js"),
    "globalThis.lifeAsset = true;\n",
  );
  writeFileSync(
    path.join(lifeRoot, "assets", "life.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  );
  writeFileSync(
    path.join(lifeRoot, "assets", "life-manifest"),
    "life-static-manifest\n",
  );

  writeFileSync(path.join(root, "nginx.conf"), privateGatewayConfig());
  return { shellRoot, lifeRoot };
}

async function waitForNginx(baseUrl, containerName) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {
      // The container can take a few scheduler ticks to begin accepting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const logs = execFileSync("docker", ["logs", containerName], {
    encoding: "utf8",
  });
  assert.fail(`nginx did not become ready:\n${logs}`);
}

async function assertResponse(baseUrl, requestPath, expected) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    redirect: "manual",
  });
  assert.equal(response.status, expected.status, `${requestPath}: status`);
  const body = await response.text();
  if (expected.body !== undefined) {
    assert.equal(body, expected.body, `${requestPath}: body`);
  }
  if (expected.contentType !== undefined) {
    assert.match(
      response.headers.get("content-type") ?? "",
      expected.contentType,
      `${requestPath}: content type`,
    );
  }
  if (expected.notContentType !== undefined) {
    assert.doesNotMatch(
      response.headers.get("content-type") ?? "",
      expected.notContentType,
      `${requestPath}: content type`,
    );
  }
  if (expected.location !== undefined) {
    const location = response.headers.get("location") ?? "";
    if (expected.location instanceof RegExp) {
      assert.match(location, expected.location, `${requestPath}: location`);
    } else {
      assert.equal(location, expected.location, `${requestPath}: location`);
    }
  }
}

async function assertRawResponse(baseUrl, requestPath, expected) {
  const response = await rawHttpRequest(baseUrl, requestPath);
  assert.equal(
    response.rawRequestTarget,
    requestPath,
    `${requestPath}: raw request target`,
  );
  assert.ok(
    expected.statuses.includes(response.status),
    `${requestPath}: status ${response.status}`,
  );
  if (expected.notContentType !== undefined) {
    assert.doesNotMatch(
      response.headers["content-type"] ?? "",
      expected.notContentType,
      `${requestPath}: content type`,
    );
  }
  return response;
}

test("the private SPA include exists for the private-origin gateway to consume", () => {
  assert.ok(readFileSync(spaInclude, "utf8").trim().length > 0);
});

test("Docker absence is a local skip but a CI failure", () => {
  const missingDocker = {
    status: null,
    stderr: "",
    error: { code: "ENOENT" },
  };
  assert.equal(
    requireDocker({ ciIsSet: false, probeResult: missingDocker }),
    false,
  );
  assert.throws(
    () => requireDocker({ ciIsSet: true, probeResult: missingDocker }),
    /Docker is required when CI is set.*ENOENT/,
  );
});

test("the current environment can run the real-nginx proof when CI is set", (t) => {
  const ciIsSet = Object.hasOwn(process.env, "CI");
  if (!ciIsSet && !dockerAvailable) {
    t.skip("Docker is unavailable outside CI");
    return;
  }
  assert.equal(requireDocker({ ciIsSet, probeResult: dockerProbe }), true);
});

test("the bare /life mount redirects permanently to the canonical LifeOS prefix", () => {
  const body = locationBody(
    readFileSync(spaInclude, "utf8"),
    "location = /life {",
  );
  assert.match(body, /return 308 \/life\/;/);
});

test("only literal canonical LifeOS document boundaries can reach its redirect or fallback", () => {
  const config = readFileSync(spaInclude, "utf8");
  const redirectBody = locationBody(config, "location = /life {");
  const fallbackBody = locationBody(config, "location /life/ {");
  const assetBody = locationBody(config, "location ^~ /life/assets/ {");

  assert.match(
    redirectBody,
    /if \(\$request_uri !~ "\^\/life\(\?:\[\?\]\|\$\)"\) \{\s*return 404;\s*\}/,
  );
  assert.match(
    fallbackBody,
    /if \(\$request_uri !~ "\^\/life\/"\) \{\s*return 404;\s*\}/,
  );
  assert.doesNotMatch(assetBody, /\$request_uri/);
});

test("one original-request policy rejects literal and encoded traversal from reserved namespaces", () => {
  const guard = reservedOriginalRequestGuard(readFileSync(spaInclude, "utf8"));

  for (const requestPath of [
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
    "/api/../settings",
    "/api//../settings",
    "/api/%2F%2e%2e%2Fsettings",
    "/%61pi//%2e%2e/settings",
    "/api/%2f/%2E.%2Fsettings",
    "/api//v1//../settings",
    "/api/%2e%2e%2Fsettings",
    "/%61pi/%2e%2e%2Fsettings",
    "/api%2F%2e%2e%2Fsettings",
    "/assets/../settings",
    "/assets///../settings",
    "/%61ssets/%2F/%2e%2E/settings",
    "/assets/%2e%2e%2Fsettings",
    "/%61ssets/%2e%2e%2Fsettings",
    "/assets%2F%2e%2e%2Fsettings",
    "/life/api/../capture",
    "/life/api//%2e%2e/capture",
    "/%6Cife/%61pi/%2f/%2E.%2Fcapture",
    "/life/api/%2e%2e%2Fcapture",
    "/life/%61pi/%2e%2e%2Fcapture",
    "/life/api%2F%2e%2e%2Fcapture",
    "/life/assets/../capture",
    "/life/assets/%2F%2e%2E%2fcapture",
    "/%6cife/%61ssets///../capture",
    "/life/assets/%2e%2e%2Fcapture",
    "/life/%61ssets/%2e%2e%2Fcapture",
    "/life/assets%2F%2e%2e%2Fcapture",
  ]) {
    assert.equal(guard.test(requestPath), true, requestPath);
  }

  for (const requestPath of [
    "/",
    "/login",
    "/settings",
    "/life",
    "/life/",
    "/life/capture",
    "/life/chat",
    "/life/entities/id",
    "/docs/api/reference",
    "//api/healthz",
    "/./assets/shell.js",
    "/./apiary/../settings",
    "//assets-data/../settings",
    "/./life/apiary/../capture",
    "/life/./assets2/../capture",
    "/life/%2e/entities/id%2Fwith%2Fslashes",
    "/api/not-a-route",
    "/api//healthz",
    "/api/%2Fitems/id%2Fwith%2Fslashes",
    "/api//..ish/settings",
    "/api//.%2eextra/settings",
    "/api/items/id%2Fwith%2Fslashes",
    "/apiary//../settings",
    "/assets/shell.js",
    "/assets-data//../settings",
    "/life/api/healthz",
    "/life/apiary//../capture",
    "/life/assets/life.js",
    "/life/assets2//../capture",
    "/life/entities//../capture",
    "/life/entities/id%2Fwith%2Fslashes",
    "/settings?return=/api/../x",
    "/settings?return=/%41pi/../x",
    "/life/%FF",
    "/lifefoo",
  ]) {
    assert.equal(guard.test(requestPath), false, requestPath);
  }
});

function cartesianSpellings(optionsByLetter) {
  return optionsByLetter.reduce(
    (prefixes, options) =>
      prefixes.flatMap((prefix) => options.map((option) => prefix + option)),
    [""],
  );
}

function replaceOccurrence(source, token, ordinal, replacement) {
  let seen = 0;
  return source.replaceAll(token, (match) => {
    if (seen++ === ordinal) return replacement;
    return match;
  });
}

test("every API and asset namespace letter accepts literal or byte-encoded ASCII case", () => {
  const guard = reservedOriginalRequestGuard(readFileSync(spaInclude, "utf8"));
  const apiOptions = [
    ["a", "A", "%61", "%41"],
    ["p", "P", "%70", "%50"],
    ["i", "I", "%69", "%49"],
  ];
  const assetOptions = [
    ["a", "A", "%61", "%41"],
    ["s", "S", "%73", "%53"],
    ["s", "S", "%73", "%53"],
    ["e", "E", "%65", "%45"],
    ["t", "T", "%74", "%54"],
    ["s", "S", "%73", "%53"],
  ];

  const matrix = [
    ...cartesianSpellings(apiOptions).map(
      (namespace) => `/${namespace}/../settings`,
    ),
    ...cartesianSpellings(assetOptions).map(
      (namespace) => `/life/${namespace}/../capture`,
    ),
  ];
  assert.equal(matrix.length, 4_160, "complete api/assets spelling matrix");
  for (const requestPath of matrix) {
    assert.equal(guard.test(requestPath), true, requestPath);
  }

  const positionMutants = [
    {
      namespace: "api",
      position: 0,
      token: "%[46]1",
      ordinal: 0,
      lower: "%61",
      upper: "%41",
    },
    {
      namespace: "api",
      position: 1,
      token: "%[57]0",
      ordinal: 0,
      lower: "%70",
      upper: "%50",
    },
    {
      namespace: "api",
      position: 2,
      token: "%[46]9",
      ordinal: 0,
      lower: "%69",
      upper: "%49",
    },
    {
      namespace: "assets",
      position: 0,
      token: "%[46]1",
      ordinal: 1,
      lower: "%61",
      upper: "%41",
    },
    {
      namespace: "assets",
      position: 1,
      token: "%[57]3",
      ordinal: 0,
      lower: "%73",
      upper: "%53",
    },
    {
      namespace: "assets",
      position: 2,
      token: "%[57]3",
      ordinal: 1,
      lower: "%73",
      upper: "%53",
    },
    {
      namespace: "assets",
      position: 3,
      token: "%[46]5",
      ordinal: 0,
      lower: "%65",
      upper: "%45",
    },
    {
      namespace: "assets",
      position: 4,
      token: "%[57]4",
      ordinal: 0,
      lower: "%74",
      upper: "%54",
    },
    {
      namespace: "assets",
      position: 5,
      token: "%[57]3",
      ordinal: 2,
      lower: "%73",
      upper: "%53",
    },
  ];
  for (const mutation of positionMutants) {
    const spelling = mutation.namespace.split("");
    spelling[mutation.position] = mutation.upper;
    const requestPath =
      mutation.namespace === "api"
        ? `/${spelling.join("")}/../settings`
        : `/life/${spelling.join("")}/../capture`;
    const mutantSource = replaceOccurrence(
      guard.source,
      mutation.token,
      mutation.ordinal,
      mutation.lower,
    );
    assert.notEqual(
      mutantSource,
      guard.source,
      `${mutation.namespace}[${mutation.position}] mutation applied`,
    );
    assert.equal(
      new RegExp(mutantSource, "i").test(requestPath),
      false,
      `${requestPath} kills a lowercase-byte-only mutant`,
    );
  }
});

test("the reserved-component scan is query-bounded and linear on long raw targets", () => {
  const guard = reservedOriginalRequestGuard(readFileSync(spaInclude, "utf8"));
  const longControls = [
    `/${"segment/".repeat(20_000)}settings`,
    `/${"x".repeat(100_000)}?return=/api/../x`,
    `/${"x".repeat(100_000)}?return=/%41pi/../x`,
  ];
  const started = performance.now();
  for (const requestPath of longControls) {
    assert.equal(guard.test(requestPath), false, requestPath.slice(0, 80));
  }
  assert.ok(
    performance.now() - started < 250,
    "the raw path guard must stay bounded on long non-matches",
  );

  const queryBlindMutant = new RegExp(
    guard.source.replaceAll("[?#]", "[#]"),
    "i",
  );
  assert.equal(
    queryBlindMutant.test("/settings?return=/api/../x"),
    true,
    "the query negative control must kill a guard that scans beyond ?",
  );
  assert.equal(
    queryBlindMutant.test("/settings?return=/%41pi/../x"),
    true,
    "the uppercase-byte query control must kill a guard that scans beyond ?",
  );
});

test("the real-nginx fixture keeps every canonical redirect relative", () => {
  assert.equal(
    countOccurrences(privateGatewayConfig(), "absolute_redirect off;"),
    1,
  );
});

test("asset-like paths with trailing slashes have an explicit 404 owner", () => {
  const config = readFileSync(spaInclude, "utf8");
  const rejectingPatterns = [...config.matchAll(/location\s+~\*\s+([^\s{]+)\s*\{([^}]*)\}/g)]
    .filter(([, , body]) => /\breturn\s+404;/.test(body))
    .map(([, pattern]) => new RegExp(pattern, "i"));

  for (const requestPath of [
    "/missing.js/",
    "/assets/chunks/missing.js/",
    "/life/assets/missing.js/",
  ]) {
    assert.ok(
      rejectingPatterns.some((pattern) => pattern.test(requestPath)),
      `${requestPath} must match an explicit 404 location`,
    );
  }
});

test("root dotfile-shaped paths have an explicit 404 owner", () => {
  const config = readFileSync(spaInclude, "utf8");
  const rejectingPatterns = [...config.matchAll(/location\s+~\*\s+([^\s{]+)\s*\{([^}]*)\}/g)]
    .filter(([, , body]) => /\breturn\s+404;/.test(body))
    .map(([, pattern]) => new RegExp(pattern, "i"));

  for (const requestPath of ["/.env", "/.env/", "/.git/config"]) {
    assert.ok(
      rejectingPatterns.some((pattern) => pattern.test(requestPath)),
      `${requestPath} must match an explicit 404 location`,
    );
  }
});

test("the Shell static namespace preserves its URI path and fails missing files closed", () => {
  const body = locationBody(
    readFileSync(spaInclude, "utf8"),
    "location ^~ /assets/ {",
  );
  assert.match(body, /^\s*root \/home\/deploy\/shell\/current;\s*$/m);
  assert.match(body, /^\s*try_files \$uri =404;\s*$/m);
});

test("the LifeOS static namespace strips its mount prefix without an SPA fallback", () => {
  const body = locationBody(
    readFileSync(spaInclude, "utf8"),
    "location ^~ /life/assets/ {",
  );
  assert.match(
    body,
    /^\s*alias \/home\/deploy\/lifeos-ui\/current\/assets\/;\s*$/m,
  );
  assert.doesNotMatch(body, /\bindex\.html\b/);
});

test("the private gateway fixture keeps bare API mounts out of both SPA fallbacks", () => {
  const config = privateGatewayConfig();
  for (const [requestPath, canonicalPath] of [
    ["/api", "/api/"],
    ["/api/brain", "/api/brain/"],
    ["/life/api", "/life/api/"],
  ]) {
    const body = locationBody(config, `location = ${requestPath} {`);
    assert.match(body, new RegExp(`return 308 ${canonicalPath};`));
  }
});

test("the server-scoped oracle requires one private SPA include and none in the public server", () => {
  const composedFixture = `
http {
  server {
    listen 127.0.0.1:8080;
    ${privateSpaIncludeDirective}
  }
  server {
    listen 127.0.0.1:8081;
    include /etc/nginx/public_paths.conf;
  }
}`;
  assert.doesNotThrow(() => assertPrivateSpaIncludeIsolation(composedFixture));
  assert.throws(
    () =>
      assertPrivateSpaIncludeIsolation(
        composedFixture.replace(
          "include /etc/nginx/public_paths.conf;",
          privateSpaIncludeDirective,
        ),
      ),
    /public 8081 server must not include/,
  );
  assert.throws(
    () =>
      assertPrivateSpaIncludeIsolation(
        composedFixture.replace(
          privateSpaIncludeDirective,
          `${privateSpaIncludeDirective}\n    ${privateSpaIncludeDirective}`,
        ),
      ),
    /private 8080 server must include the SPA routes exactly once/,
  );
});

test("the composed production origin keeps private SPA routes scoped to port 8080", (t) => {
  const currentConfig = readFileSync(originConfig, "utf8");
  const hasPrivateServer = serverBlocks(currentConfig).some((block) =>
    /\blisten\s+127\.0\.0\.1:8080;/.test(block),
  );
  if (!hasPrivateServer) {
    t.skip("Issue #345 private server is not present on this branch base");
    return;
  }
  assertPrivateSpaIncludeIsolation(currentConfig);
});

test(
  "real nginx serves document fallbacks and assets without swallowing missing assets or API paths",
  {
    skip: dockerAvailable
      ? false
      : "Docker is unavailable; real-nginx proof runs in Linux CI",
  },
  async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "private-spa-nginx-"));
    const containerName = `private-spa-nginx-${process.pid}-${Date.now()}`;
    const { shellRoot, lifeRoot } = writeFixture(fixtureRoot);

    try {
      execFileSync(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          containerName,
          "--publish",
          "127.0.0.1::8080",
          "--mount",
          `type=bind,src=${path.join(fixtureRoot, "nginx.conf")},dst=/etc/nginx/nginx.conf,readonly`,
          "--mount",
          `type=bind,src=${spaInclude},dst=/etc/nginx/private_spa_locations.conf,readonly`,
          "--mount",
          `type=bind,src=${shellRoot},dst=/home/deploy/shell/current,readonly`,
          "--mount",
          `type=bind,src=${lifeRoot},dst=/home/deploy/lifeos-ui/current,readonly`,
          nginxImage,
        ],
        { encoding: "utf8" },
      );

      const published = execFileSync(
        "docker",
        ["port", containerName, "8080/tcp"],
        {
          encoding: "utf8",
        },
      ).trim();
      const portMatch = published.match(/127\.0\.0\.1:(\d+)$/);
      assert.ok(portMatch, `unexpected published port: ${published}`);
      const baseUrl = `http://127.0.0.1:${portMatch[1]}`;
      await waitForNginx(baseUrl, containerName);

      for (const requestPath of [
        "/",
        "/login",
        "/settings",
        "/settings?return=/api/../x",
        "/settings?return=/%41pi/../x",
        "/docs/api/reference",
        "/tools/example",
      ]) {
        await assertResponse(baseUrl, requestPath, {
          status: 200,
          body: "<!doctype html><title>shell-index</title>",
          contentType: /^text\/html\b/,
        });
      }

      for (const requestPath of [
        "/life/",
        "/life/capture",
        "/life/chat",
        "/life/entities/123",
        "/life/entities/id%2Fwith%2Fslashes",
        "/life/%FF",
      ]) {
        await assertResponse(baseUrl, requestPath, {
          status: 200,
          body: "<!doctype html><title>life-index</title>",
          contentType: /^text\/html\b/,
        });
      }

      await assertResponse(baseUrl, "/life", {
        status: 308,
        location: "/life/",
      });
      const redirectedLife = await fetch(`${baseUrl}/life`);
      assert.equal(redirectedLife.status, 200, "/life: eventual status");
      assert.equal(
        await redirectedLife.text(),
        "<!doctype html><title>life-index</title>",
        "/life: eventual body",
      );

      for (const requestPath of [
        "/%6cife/capture",
        "/%6cife",
        "/life%2Fcapture",
        "/life%2F",
        "/%6cife%2Fcapture",
        "/%2Flife/capture",
        "/shell/%2e%2e%2Flife%2Fcapture",
      ]) {
        await assertResponse(baseUrl, requestPath, {
          status: 404,
        });
      }

      for (const requestPath of [
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
        "/api/%2e%2e%2Fsettings",
        "/api//../settings",
        "/api/%2F%2e%2e%2Fsettings",
        "/%61pi//%2e%2e/settings",
        "/api/%2f/%2E.%2Fsettings",
        "/%61pi/%2e%2e%2Fsettings",
        "/api%2F%2e%2e%2Fsettings",
        "/assets/%2e%2e%2Fsettings",
        "/assets///../settings",
        "/%61ssets/%2F/%2e%2E/settings",
        "/%61ssets/%2e%2e%2Fsettings",
        "/assets%2F%2e%2e%2Fsettings",
        "/life/api/%2e%2e%2Fcapture",
        "/life/api//%2e%2e/capture",
        "/%6Cife/%61pi/%2f/%2E.%2Fcapture",
        "/life/%61pi/%2e%2e%2Fcapture",
        "/life/api%2F%2e%2e%2Fcapture",
        "/life/assets/%2e%2e%2Fcapture",
        "/life/assets/%2F%2e%2E%2fcapture",
        "/%6cife/%61ssets///../capture",
        "/life/%61ssets/%2e%2e%2Fcapture",
        "/life/assets%2F%2e%2e%2Fcapture",
      ]) {
        await assertRawResponse(baseUrl, requestPath, {
          statuses: [400, 404],
          notContentType: /^text\/html\b/,
        });
      }

      await assertResponse(baseUrl, "/lifefoo", {
        status: 200,
        body: "<!doctype html><title>shell-index</title>",
        contentType: /^text\/html\b/,
      });

      await assertResponse(baseUrl, "/assets/shell.js", {
        status: 200,
        body: "globalThis.shellAsset = true;\n",
        contentType: /^(?:application|text)\/javascript\b/,
      });
      await assertResponse(baseUrl, "/assets/shell-manifest", {
        status: 200,
        body: "shell-static-manifest\n",
        contentType: /^application\/octet-stream\b/,
      });
      await assertResponse(baseUrl, "/styles.css", {
        status: 200,
        body: "body { color: rgb(1, 2, 3); }\n",
        contentType: /^text\/css\b/,
      });
      await assertResponse(baseUrl, "/life/assets/life.js", {
        status: 200,
        body: "globalThis.lifeAsset = true;\n",
        contentType: /^(?:application|text)\/javascript\b/,
      });
      await assertResponse(baseUrl, "/life/assets/life.svg", {
        status: 200,
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
        contentType: /^image\/svg\+xml\b/,
      });
      await assertResponse(baseUrl, "/life/assets/life-manifest", {
        status: 200,
        body: "life-static-manifest\n",
        contentType: /^application\/octet-stream\b/,
      });

      for (const requestPath of [
        "/.env",
        "/.env/",
        "/.git/config",
        "/missing.js",
        "/missing.js/",
        "/missing.css",
        "/missing.png",
        "/missing.js.map",
        "/favicon.ico",
        "/fonts/missing.woff2",
        "/assets/does-not-exist",
        "/assets/chunks/missing.js/",
        "/assets/shell.js/",
        "/life/assets/does-not-exist",
        "/life/assets/missing.js",
        "/life/assets/missing.js/",
        "/life/assets/missing.css",
        "/life/assets/missing.png",
        "/life/assets/missing.js.map",
        "/life/favicon.ico",
        "/life/assets/life.js/",
      ]) {
        await assertResponse(baseUrl, requestPath, { status: 404 });
      }

      for (const [requestPath, body] of [
        ["/api/", "handler-api"],
        ["/api/missing.js", "handler-api"],
        ["/api/missing.js/", "handler-api"],
        ["/api/brain/", "brain-api"],
        ["/api/brain/missing.css", "brain-api"],
        ["/api/brain/missing.css/", "brain-api"],
        ["/life/api/", "life-api"],
        ["/life/api/missing.png", "life-api"],
        ["/life/api/missing.png/", "life-api"],
      ]) {
        await assertResponse(baseUrl, requestPath, {
          status: 418,
          body,
          notContentType: /^text\/html\b/,
        });
      }

      for (const [requestPath, canonicalPath, body] of [
        ["/api", "/api/", "handler-api"],
        ["/api/brain", "/api/brain/", "brain-api"],
        ["/life/api", "/life/api/", "life-api"],
      ]) {
        await assertResponse(baseUrl, requestPath, {
          status: 308,
          location: canonicalPath,
        });
        const redirectedApi = await fetch(`${baseUrl}${requestPath}`);
        assert.equal(
          redirectedApi.status,
          418,
          `${requestPath}: eventual status`,
        );
        assert.equal(
          await redirectedApi.text(),
          body,
          `${requestPath}: eventual body`,
        );
      }
    } finally {
      spawnSync("docker", ["rm", "--force", containerName], {
        encoding: "utf8",
      });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);
