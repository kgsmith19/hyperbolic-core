import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const opsDir = path.dirname(fileURLToPath(import.meta.url));
const edgeOriginDir = path.join(opsDir, "edge-origin");
const originConfig = readFileSync(path.join(edgeOriginDir, "nginx.conf"), "utf8");
const nginxImage = "nginx:1.27-alpine";

function publicServerBody(config) {
  const lines = config.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "server {") continue;
    const block = [lines[index]];
    let depth = 1;
    while (depth > 0 && ++index < lines.length) {
      const line = lines[index];
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      block.push(line);
    }
    assert.equal(depth, 0, "production config contains an unclosed server block");
    const body = block.join("\n");
    if (/^\s*listen 127\.0\.0\.1:8081;$/m.test(body)) return body;
  }
  assert.fail("production config must contain the separate public loopback server");
}

function dockerProbe() {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function waitForPublicOrigin(baseUrl, containerName) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return response;
    } catch {
      // The container can take a few scheduler ticks to accept requests.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const logs = execFileSync("docker", ["logs", containerName], { encoding: "utf8" });
  assert.fail(`public nginx origin did not become ready:\n${logs}`);
}

test("the public server maps unmatched paths below a deliberately nonexistent root", () => {
  const publicServer = publicServerBody(originConfig);
  assert.match(publicServer, /^\s*root \/var\/empty\/hyperbolic-public-deny-by-default;$/m);
  assert.doesNotMatch(publicServer, /^\s*root \/var\/empty;$/m);
});

test("real production nginx returns public health 200 and unmatched root 404", async (t) => {
  const probe = dockerProbe();
  if (probe.status !== 0) {
    const detail =
      probe.error?.code ??
      probe.stderr?.trim() ??
      `exit status ${String(probe.status)}`;
    if (Object.hasOwn(process.env, "CI")) {
      assert.fail(`Docker is required in CI for the public deny-by-default proof (${detail})`);
    }
    t.skip(`Docker is unavailable outside CI (${detail})`);
    return;
  }

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "public-origin-nginx-"));
  const gatewayName = `public-origin-${process.pid}-${Date.now()}`;
  const gatewayConfigPath = path.join(fixtureRoot, "nginx.conf");
  writeFileSync(
    gatewayConfigPath,
    originConfig
      .replace("listen 127.0.0.1:8080;", "listen 8080;")
      .replace("listen 127.0.0.1:8081;", "listen 8081;"),
  );

  try {
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        gatewayName,
        "--publish",
        "127.0.0.1::8081",
        "--mount",
        `type=bind,src=${gatewayConfigPath},dst=/etc/nginx/nginx.conf,readonly`,
        "--mount",
        `type=bind,src=${path.join(edgeOriginDir, "private_spa_locations.conf")},dst=/etc/nginx/private_spa_locations.conf,readonly`,
        "--mount",
        `type=bind,src=${path.join(edgeOriginDir, "public_paths.conf")},dst=/etc/nginx/public_paths.conf,readonly`,
        nginxImage,
      ],
      { encoding: "utf8" },
    );

    const published = execFileSync(
      "docker",
      ["port", gatewayName, "8081/tcp"],
      { encoding: "utf8" },
    ).trim();
    const portMatch = /127\.0\.0\.1:(\d+)$/.exec(published);
    assert.ok(portMatch, `unexpected published port: ${published}`);
    const baseUrl = `http://127.0.0.1:${portMatch[1]}`;

    const health = await waitForPublicOrigin(baseUrl, gatewayName);
    assert.equal(await health.text(), "ok");
    const root = await fetch(`${baseUrl}/`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(root.status, 404);
  } finally {
    spawnSync("docker", ["rm", "--force", gatewayName], {
      encoding: "utf8",
    });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
