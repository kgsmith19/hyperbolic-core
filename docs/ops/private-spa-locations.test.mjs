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
const publicOriginConfig = path.join(opsDir, "edge-origin", "nginx.conf");
const nginxImage = "nginx:1.27-alpine";

function dockerIsAvailable() {
  const result = spawnSync(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0;
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

  const nginxConf = `
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
    location ^~ /life/api/ {
      default_type text/plain;
      return 418 "life-api";
    }

    location ^~ /api/brain/ {
      default_type text/plain;
      return 418 "brain-api";
    }

    location ^~ /api/ {
      default_type text/plain;
      return 418 "handler-api";
    }

    include /etc/nginx/private_spa_locations.conf;
  }
}
`;
  writeFileSync(path.join(root, "nginx.conf"), nginxConf);
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
}

test("the private SPA include exists for the private-origin gateway to consume", () => {
  assert.ok(readFileSync(spaInclude, "utf8").trim().length > 0);
});

test("the deny-by-default public listener does not import the private SPA routes", () => {
  assert.doesNotMatch(
    readFileSync(publicOriginConfig, "utf8"),
    /private_spa_locations\.conf/,
  );
});

test(
  "real nginx serves document fallbacks and assets without swallowing missing assets or API paths",
  {
    skip: dockerIsAvailable()
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
    } finally {
      spawnSync("docker", ["rm", "--force", containerName], {
        encoding: "utf8",
      });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);
