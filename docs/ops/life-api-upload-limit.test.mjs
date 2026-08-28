import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const opsDir = path.dirname(fileURLToPath(import.meta.url));
const edgeOriginDir = path.join(opsDir, "edge-origin");
const originConfigPath = path.join(edgeOriginDir, "nginx.conf");
const originConfig = readFileSync(originConfigPath, "utf8");
const nginxImage = "nginx:1.27-alpine";
const maxUploadBytes = 10 * 1024 * 1024;
const multipartSlackBytes = 8 * 1024;

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

function nginxSizeBytes(value) {
  const match = /^(\d+)([kmg])?$/i.exec(value);
  assert.ok(match, `unsupported nginx size: ${value}`);
  const multiplier = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    (match[2] ?? "").toLowerCase()
  ];
  return Number(match[1]) * multiplier;
}

function dockerProbe() {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function waitForNginx(baseUrl, containerName) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {
      // The gateway can take a few scheduler ticks to start accepting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const logs = execFileSync("docker", ["logs", containerName], {
    encoding: "utf8",
  });
  assert.fail(`nginx did not become ready:\n${logs}`);
}

function assertUploadCeilingIsScoped(confText) {
  const directives = [...confText.matchAll(/^\s*client_max_body_size\s+(\S+);$/gm)];
  assert.equal(
    directives.length,
    1,
    "client_max_body_size must appear exactly once, inside /life/api/ only",
  );
  const body = locationBody(confText, "location ^~ /life/api/ {");
  const directive = /^\s*client_max_body_size\s+(\S+);$/m.exec(body);
  assert.ok(directive, "/life/api/ must declare its own request-body ceiling");
  assert.ok(
    nginxSizeBytes(directive[1]) > maxUploadBytes + multipartSlackBytes,
    "nginx must pass the complete application boundary to LifeOS for its own 413 response",
  );
}

test("the LifeOS API nginx ceiling is scoped only to /life/api/ and leaves the application cap authoritative", () => {
  assertUploadCeilingIsScoped(originConfig);
});

test("the upload-scope oracle rejects a duplicate ceiling outside /life/api/", () => {
  const broadened = originConfig.replace("http {", "http {\n    client_max_body_size 11m;");
  assert.throws(
    () => assertUploadCeilingIsScoped(broadened),
    /must appear exactly once/,
  );
});

test("real nginx passes a 10 MiB multipart upload to an upstream that consumes the full body", async (t) => {
  const probe = dockerProbe();
  if (probe.status !== 0) {
    const detail =
      probe.error?.code ??
      probe.stderr?.trim() ??
      `exit status ${String(probe.status)}`;
    if (Object.hasOwn(process.env, "CI")) {
      assert.fail(`Docker is required in CI for the real-nginx upload proof (${detail})`);
    }
    t.skip(`Docker is unavailable outside CI (${detail})`);
    return;
  }

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "life-api-upload-nginx-"));
  const gatewayName = `life-api-gateway-${process.pid}-${Date.now()}`;
  const gatewayConfigPath = path.join(fixtureRoot, "gateway.conf");
  let consumedBytes = -1;
  const upstream = createServer((request, response) => {
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
    });
    request.on("end", () => {
      consumedBytes = bytes;
      response.writeHead(204, {
        "X-LifeOS-Upstream": "reached",
        "X-LifeOS-Upstream-Bytes": String(bytes),
      });
      response.end();
    });
  });
  upstream.listen(0, "0.0.0.0");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  writeFileSync(
    gatewayConfigPath,
    originConfig
      .replace("listen 127.0.0.1:8080;", "listen 8080;")
      .replace("listen 127.0.0.1:8081;", "listen 8081;")
      .replace(
        "http://127.0.0.1:8000",
        `http://host.docker.internal:${upstreamAddress.port}`,
      ),
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
        "--add-host",
        "host.docker.internal:host-gateway",
        "--publish",
        "127.0.0.1::8080",
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
      ["port", gatewayName, "8080/tcp"],
      { encoding: "utf8" },
    ).trim();
    const portMatch = published.match(/127\.0\.0\.1:(\d+)$/);
    assert.ok(portMatch, `unexpected published port: ${published}`);
    const baseUrl = `http://127.0.0.1:${portMatch[1]}`;
    await waitForNginx(baseUrl, gatewayName);

    const boundary = "lifeos-upload-boundary";
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const requestBody = Buffer.concat([
      prefix,
      Buffer.alloc(maxUploadBytes, 0x78),
      suffix,
    ]);
    assert.ok(requestBody.length > 1024 * 1024);
    assert.ok(requestBody.length <= maxUploadBytes + multipartSlackBytes);

    const response = await fetch(`${baseUrl}/life/api/documents`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: requestBody,
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("x-lifeos-upstream"), "reached");
    assert.equal(response.headers.get("x-lifeos-upstream-bytes"), String(requestBody.length));
    assert.equal(consumedBytes, requestBody.length);
  } finally {
    spawnSync("docker", ["rm", "--force", gatewayName], {
      encoding: "utf8",
    });
    upstream.close();
    await once(upstream, "close");
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
