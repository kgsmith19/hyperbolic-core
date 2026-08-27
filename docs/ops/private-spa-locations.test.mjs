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
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "}") return body.join("\n");
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
    path.join(shellRoot, "styles.css"),
    "body { color: rgb(1, 2, 3); }\n",
  );

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
  if (expected.location !== undefined) {
    const location = response.headers.get("location") ?? "";
    if (expected.location instanceof RegExp) {
      assert.match(location, expected.location, `${requestPath}: location`);
    } else {
      assert.equal(location, expected.location, `${requestPath}: location`);
    }
  }
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
      ]) {
        await assertResponse(baseUrl, requestPath, {
          status: 200,
          body: "<!doctype html><title>life-index</title>",
          contentType: /^text\/html\b/,
        });
      }

      await assertResponse(baseUrl, "/life", {
        status: 308,
        location: /\/life\/$/,
      });
      const redirectedLife = await fetch(`${baseUrl}/life`);
      assert.equal(redirectedLife.status, 200, "/life: eventual status");
      assert.equal(
        await redirectedLife.text(),
        "<!doctype html><title>life-index</title>",
        "/life: eventual body",
      );

      await assertResponse(baseUrl, "/assets/shell.js", {
        status: 200,
        body: "globalThis.shellAsset = true;\n",
        contentType: /^(?:application|text)\/javascript\b/,
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

      for (const requestPath of [
        "/missing.js",
        "/missing.css",
        "/missing.png",
        "/missing.js.map",
        "/favicon.ico",
        "/fonts/missing.woff2",
        "/life/assets/missing.js",
        "/life/assets/missing.css",
        "/life/assets/missing.png",
        "/life/assets/missing.js.map",
        "/life/favicon.ico",
      ]) {
        await assertResponse(baseUrl, requestPath, { status: 404 });
      }

      for (const [requestPath, body] of [
        ["/api/", "handler-api"],
        ["/api/missing.js", "handler-api"],
        ["/api/brain/", "brain-api"],
        ["/api/brain/missing.css", "brain-api"],
        ["/life/api/", "life-api"],
        ["/life/api/missing.png", "life-api"],
      ]) {
        await assertResponse(baseUrl, requestPath, {
          status: 418,
          body,
          contentType: /^text\/plain\b/,
        });
      }

      for (const [requestPath, canonicalPath, body] of [
        ["/api", "/api/", "handler-api"],
        ["/api/brain", "/api/brain/", "brain-api"],
        ["/life/api", "/life/api/", "life-api"],
      ]) {
        await assertResponse(baseUrl, requestPath, {
          status: 308,
          location: new RegExp(`${canonicalPath}$`),
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
