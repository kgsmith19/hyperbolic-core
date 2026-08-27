import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const normalize = (text) => text.replaceAll("\r\n", "\n");
const nginx = normalize(read("docs/ops/edge-origin/nginx.conf"));
const compose = read("docs/ops/edge-origin/compose.yml");
const privateSpaPath = path.join(root, "docs/ops/edge-origin/private_spa_locations.conf");
const privateSpa = existsSync(privateSpaPath) ? normalize(readFileSync(privateSpaPath, "utf8")) : "";
const publicPaths = normalize(read("docs/ops/edge-origin/public_paths.conf"));
const serveApply = read("docs/ops/tailscale-serve-apply.sh");
const edgeWorkflow = read(".github/workflows/ops-edge.yml");
const serveWorkflow = read(".github/workflows/ops-serve-apply.yml");
const lifeosWorkflow = read(".github/workflows/lifeos-deploy.yml");
const smokeWorkflow = read(".github/workflows/platform-smoke.yml");
const runbook = normalize(read("docs/ops/runbook.md"));
const activeRouteOwners = new Map(
  [
    "apps/lifeos/backend/src/api/main.py",
    "apps/lifeos/backend/tests/api/test_root_path.py",
    "apps/lifeos/backend/docs/runbook.md",
    "apps/lifeos/backend/compose.yaml",
    ".github/workflows/deploy.yml",
    "services/llm-handler/src/server.ts",
    "services/llm-handler/tests/server.test.ts",
    "services/llm-handler/compose.yaml",
    "services/brain/AGENTS.md",
    "services/brain/src/server.ts",
    "services/brain/tests/server.test.ts",
  ].map((relativePath) => [relativePath, normalize(read(relativePath))]),
);

function extractBlocks(text, openingPattern) {
  const lines = text.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = openingPattern.exec(lines[index].trim());
    openingPattern.lastIndex = 0;
    if (!opening) continue;
    const blockLines = [lines[index]];
    let depth = 1;
    while (depth > 0 && ++index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed.endsWith("{")) depth += 1;
      if (trimmed === "}") depth -= 1;
      blockLines.push(line);
    }
    assert.equal(depth, 0, `unclosed block starting with ${blockLines[0].trim()}`);
    blocks.push({ match: opening, source: blockLines.join("\n") });
  }
  return blocks;
}

function serverForListen(text, address) {
  const matches = extractBlocks(text, /^server\s*\{$/).filter(({ source }) =>
    new RegExp(`^\\s*listen ${address.replaceAll(".", "\\.")};$`, "m").test(source),
  );
  assert.equal(matches.length, 1, `expected exactly one server for ${address}`);
  return matches[0].source;
}

function locationMap(text) {
  const entries = extractBlocks(text, /^location\s+(?:(=|\^~)\s+)?(\S+)\s*\{$/);
  const locations = new Map();
  for (const { match, source } of entries) {
    const path = match[2];
    assert.ok(!locations.has(path), `duplicate location ${path}`);
    locations.set(path, { modifier: match[1] ?? "", source });
  }
  return locations;
}

function includes(text) {
  return [...text.matchAll(/^\s*include\s+(\S+);$/gm)].map((match) => match[1]);
}

function assertIsolatedTopology(nginxText) {
  const privateServer = serverForListen(nginxText, "127.0.0.1:8080");
  const publicServer = serverForListen(nginxText, "127.0.0.1:8081");
  const privateLocations = locationMap(privateServer);
  const publicLocations = locationMap(publicServer);
  assert.deepEqual(
    [...privateLocations.keys()].sort(),
    ["/api", "/api/", "/api/brain", "/api/brain/", "/healthz", "/life/api", "/life/api/"].sort(),
    "private server locations",
  );
  assert.deepEqual([...publicLocations.keys()], ["/healthz"], "public server locations");
  assert.deepEqual(includes(privateServer), ["/etc/nginx/private_spa_locations.conf"]);
  assert.deepEqual(includes(publicServer), ["/etc/nginx/public_paths.conf"]);
  assert.deepEqual([...locationMap(privateSpa).keys()].sort(), ["/", "/life/"].sort());
  return { privateLocations, privateServer, publicLocations, publicServer };
}

test("the two listeners have exact, independently parsed route and include ownership", () => {
  assertIsolatedTopology(nginx);
});

test("API slashless paths return exact canonical 308 redirects owned only by the private server", () => {
  const { privateLocations, privateServer, publicLocations } = assertIsolatedTopology(nginx);
  assert.match(privateServer, /^\s*absolute_redirect off;$/m, "Location headers remain exact relative paths");
  for (const [path, location] of [
    ["/api", "/api/"],
    ["/api/brain", "/api/brain/"],
    ["/life/api", "/life/api/"],
  ]) {
    const route = privateLocations.get(path);
    assert.equal(route.modifier, "=", `${path} must be an exact-match redirect`);
    assert.match(route.source, new RegExp(`^\\s*return 308 ${location.replaceAll("/", "\\/")};$`, "m"));
    assert.doesNotMatch(route.source, /proxy_pass|root|alias/);
    assert.ok(!publicLocations.has(path), `${path} must not exist on the public listener`);
  }
});

test("API prefix proxies preserve the complete incoming path and take precedence over frontend prefixes", () => {
  const { privateLocations } = assertIsolatedTopology(nginx);
  for (const [route, target] of [
    ["/life/api/", "http://127.0.0.1:8000"],
    ["/api/brain/", "http://127.0.0.1:8100"],
    ["/api/", "http://127.0.0.1:8200"],
  ]) {
    const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const location = privateLocations.get(route);
    assert.equal(location.modifier, "^~", `${route} must win prefix selection`);
    assert.match(location.source, new RegExp(`proxy_pass ${escapedTarget};`));
    assert.doesNotMatch(location.source, new RegExp(`proxy_pass ${escapedTarget}/;`));
  }
});

test("the public listener stays separate and deny-by-default", () => {
  const { publicServer } = assertIsolatedTopology(nginx);
  assert.match(publicServer, /root \/var\/empty;/);
  for (const line of publicPaths.split("\n")) {
    if (!line.trim().startsWith("#")) assert.doesNotMatch(line, /\blocation\b/);
  }
  assert.doesNotMatch(publicPaths, /^\s*include\s+.*private_spa_locations/m);
});

test("topology validation rejects moving a private route or the private include to the public server", () => {
  assertIsolatedTopology(nginx);
  const apiBlock = /\n\s*location \^~ \/api\/ \{[\s\S]*?\n\s*\}/.exec(nginx)?.[0];
  assert.ok(apiBlock, "fixture contains private /api/ block");
  const movedRoute = nginx
    .replace(apiBlock, "")
    .replace("    include /etc/nginx/public_paths.conf;", `${apiBlock}\n\n    include /etc/nginx/public_paths.conf;`);
  assert.throws(() => assertIsolatedTopology(movedRoute), /private server locations|public server locations/);

  const movedInclude = nginx
    .replace("include /etc/nginx/private_spa_locations.conf;", "include /etc/nginx/temporary.conf;")
    .replace("include /etc/nginx/public_paths.conf;", "include /etc/nginx/private_spa_locations.conf;")
    .replace("include /etc/nginx/temporary.conf;", "include /etc/nginx/public_paths.conf;");
  assert.throws(() => assertIsolatedTopology(movedInclude));
});

test("active deployment guidance assigns path ownership to nginx, never legacy Serve mounts", () => {
  const rollbackStart = runbook.indexOf("### Roll back to the prior five mounts");
  const rollbackEnd = runbook.indexOf("### Operator evidence still required", rollbackStart);
  assert.ok(rollbackStart > 0 && rollbackEnd > rollbackStart, "rollback-only section is explicit");
  const activeRunbook = `${runbook.slice(0, rollbackStart)}${runbook.slice(rollbackEnd)}`;
  assert.doesNotMatch(activeRunbook, /--set-path=\/(?:life|api)/);
  assert.doesNotMatch(activeRunbook, /(?:serve|Serve) (?:mount|route) (?:is |must |still |points |serves |at )/);
  assert.doesNotMatch(lifeosWorkflow, /skip_live_verify|(?:serve|Serve) (?:mount|route)/);
  assert.doesNotMatch(smokeWorkflow, /(?:Serve|serve) mount|through the \/(?:api|life\/api)\/ mount/);
  assert.match(activeRunbook, /nginx owns all path routing/);
});

test("active application source and nested guidance cannot reassign API paths to Tailscale Serve", () => {
  const legacyOwnership =
    /tailscale-serve-forwarded|tailscale serve (?:forwards|STRIPS)|(?:serve|Serve) (?:mount|route table)|Serve table mounts|tailscale-serve-apply\.sh.{0,80}\/(?:api|life\/api)\//s;

  for (const [relativePath, source] of activeRouteOwners) {
    assert.doesNotMatch(source, legacyOwnership, relativePath);
    assert.match(source, /nginx/i, `${relativePath} must name nginx as the active path owner`);
  }
});

test("Compose gives nginx host-loopback reachability without opening a wildcard listener", () => {
  assert.match(compose, /edge-origin:\s*[\s\S]*?network_mode: host/);
  assert.match(compose, /\.\/private_spa_locations\.conf:\/etc\/nginx\/private_spa_locations\.conf:ro/);
  assert.doesNotMatch(compose, /0\.0\.0\.0/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.doesNotMatch(compose, /never listens on anything/);
  assert.match(compose, /metrics listener binds only 127\.0\.0\.1:20241/);
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
