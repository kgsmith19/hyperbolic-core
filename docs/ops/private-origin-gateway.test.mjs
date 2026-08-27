import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const nginx = read("docs/ops/edge-origin/nginx.conf");
const compose = read("docs/ops/edge-origin/compose.yml");
const privateSpaPath = path.join(root, "docs/ops/edge-origin/private_spa_locations.conf");
const privateSpa = existsSync(privateSpaPath) ? readFileSync(privateSpaPath, "utf8") : "";
const publicPaths = read("docs/ops/edge-origin/public_paths.conf");
const serveApply = read("docs/ops/tailscale-serve-apply.sh");
const edgeWorkflow = read(".github/workflows/ops-edge.yml");
const serveWorkflow = read(".github/workflows/ops-serve-apply.yml");

function locations(text) {
  return [...text.matchAll(/^\s*location\s+(?:=\s*|\^~\s*)?(\S+)\s*\{/gm)].map((match) => match[1]);
}

test("the private listener owns exactly the health, API, and two frontend route families", () => {
  assert.match(nginx, /listen 127\.0\.0\.1:8080;/);
  assert.deepEqual(
    [...new Set([...locations(nginx), ...locations(privateSpa)])].sort(),
    ["/", "/api/", "/api/brain/", "/healthz", "/life/", "/life/api/"].sort(),
  );
  assert.match(nginx, /include \/etc\/nginx\/private_spa_locations\.conf;/);
});

test("API proxies preserve the complete incoming path and take precedence over frontend prefixes", () => {
  for (const [route, target] of [
    ["/life/api/", "http://127.0.0.1:8000"],
    ["/api/brain/", "http://127.0.0.1:8100"],
    ["/api/", "http://127.0.0.1:8200"],
  ]) {
    const escapedRoute = route.replaceAll("/", "\\/");
    const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(nginx, new RegExp(`location \\^~ ${escapedRoute} \\{[^}]*proxy_pass ${escapedTarget};`, "s"));
    assert.doesNotMatch(nginx, new RegExp(`proxy_pass ${escapedTarget}/;`));
  }
});

test("the public listener stays separate and deny-by-default", () => {
  assert.match(nginx, /listen 127\.0\.0\.1:8081;/);
  assert.match(nginx, /include \/etc\/nginx\/public_paths\.conf;/);
  assert.match(nginx, /root \/var\/empty;/);
  for (const line of publicPaths.split("\n")) {
    if (!line.trim().startsWith("#")) assert.doesNotMatch(line, /\blocation\b/);
  }
  assert.doesNotMatch(publicPaths, /^\s*include\s+.*private_spa_locations/m);
});

test("Compose gives nginx host-loopback reachability without opening a wildcard listener", () => {
  assert.match(compose, /edge-origin:\s*[\s\S]*?network_mode: host/);
  assert.match(compose, /\.\/private_spa_locations\.conf:\/etc\/nginx\/private_spa_locations\.conf:ro/);
  assert.doesNotMatch(compose, /0\.0\.0\.0/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
});

test("Serve preflights nginx and replaces the old table with one root proxy", () => {
  assert.match(serveApply, /curl -fsS --max-time 5 http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(serveApply, /tailscale serve reset/);
  assert.match(serveApply, /--set-path=\/[\s\S]*?http:\/\/127\.0\.0\.1:8080/);
  assert.equal((serveApply.match(/--set-path=/g) ?? []).length, 1);
  for (const obsolete of ["8000", "8100", "8200", "lifeos-ui", "shell/current"]) {
    assert.doesNotMatch(serveApply, new RegExp(obsolete));
  }
});

test("the origin workflow starts nginx independently of the optional Cloudflare tunnel", () => {
  assert.match(edgeWorkflow, /if: vars\.DEPLOY_ENABLED == 'true' && vars\.PRIVATE_ORIGIN_GATEWAY_ENABLED == 'true'/);
  assert.match(edgeWorkflow, /docker compose pull edge-origin/);
  assert.match(edgeWorkflow, /docker compose up -d --wait edge-origin/);
  assert.match(edgeWorkflow, /DEPLOY_HOST must be a non-empty DNS name or IPv4 address/);
  assert.match(edgeWorkflow, /curl -fsS http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(edgeWorkflow, /private_spa_locations\.conf/);
  assert.match(edgeWorkflow, /if: vars\.CLOUDFLARE_EDGE_ENABLED == 'true'/);
});

test("Serve transport still ships the checked-in script and cannot mutate before its preflight", () => {
  assert.match(serveWorkflow, /scp .*docs\/ops\/tailscale-serve-apply\.sh/);
  assert.match(serveWorkflow, /\.\/tailscale-serve-apply\.sh --apply/);
  assert.doesNotMatch(serveWorkflow, /tailscale serve reset/);
});
