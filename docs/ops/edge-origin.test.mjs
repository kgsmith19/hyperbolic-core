// Tests for docs/ops/edge-origin/ (issue #165). Structural checks run in every
// environment; CI additionally runs the pinned nginx image's real `nginx -t`
// with all three configuration files mounted. Local Docker absence skips only
// that integration check, never the isolation/synchronization contracts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const opsDir = path.dirname(fileURLToPath(import.meta.url));
const edgeOriginDir = path.join(opsDir, "edge-origin");
const nginxConf = readFileSync(path.join(edgeOriginDir, "nginx.conf"), "utf8");
const privateSpaConf = readFileSync(path.join(edgeOriginDir, "private_spa_locations.conf"), "utf8");
const publicPathsConf = readFileSync(path.join(edgeOriginDir, "public_paths.conf"), "utf8");
const composeYml = readFileSync(path.join(edgeOriginDir, "compose.yml"), "utf8");

function serviceBlock(serviceName, nextServiceName) {
  const start = composeYml.indexOf(`\n  ${serviceName}:`);
  assert.ok(start >= 0, `${serviceName} service not found`);
  const end = nextServiceName ? composeYml.indexOf(`\n  ${nextServiceName}:`, start + 1) : composeYml.length;
  return composeYml.slice(start, end < 0 ? undefined : end);
}

/**
 * The private nginx application route table. Tailscale has only one root
 * proxy now, so nginx.conf and its focused SPA include are authoritative.
 */
function privateRouteTable() {
  const routes = new Map();
  for (const [route, location] of [
    ...parseLocationBodies(nginxConf),
    ...parseLocationBodies(privateSpaConf),
  ]) {
    if (route === "/healthz" || /\breturn 308\b/.test(location.body)) continue;
    routes.set(route, routeMapping(location.body, route));
  }
  return routes;
}

/** Strips a leading `# ` or `#` comment marker from every line. */
function uncomment(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*#\s?/, ""))
    .join("\n");
}

/**
 * Line-based parser for `location [=] <path> { ... }` blocks, each on its
 * own line with braces balanced inside the block (this repo's nginx files
 * are hand-formatted that way). Deliberately line-aware rather than a
 * multiline regex over the whole file: a regex search for the substring
 * "location ... { ... }" would just as happily match inside a `# location
 * / { ... }` *comment* (the leading `#` doesn't stop `.` or `[^}]` from
 * matching across it), which would silently defeat the "nothing is public
 * by default" test below. Skipping any line that starts with `#` is what
 * makes commented-out blocks invisible to this parser, as they must be.
 */
function parseLocationBodies(confText) {
  const locations = new Map();
  const lines = confText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const opening = line.match(/^location\s+(?:(=|\^~)\s*)?(\S+)\s*\{$/);
    if (!opening) continue;
    const locationPath = opening[2];
    const bodyLines = [];
    let depth = 1;
    i += 1;
    while (i < lines.length) {
      const directive = lines[i].replace(/#.*/, "");
      depth += (directive.match(/\{/g) ?? []).length;
      depth -= (directive.match(/\}/g) ?? []).length;
      if (depth === 0) break;
      bodyLines.push(lines[i]);
      i += 1;
    }
    assert.equal(depth, 0, `unterminated location ${locationPath}`);
    locations.set(locationPath, {
      modifier: opening[1] ?? "",
      body: bodyLines.join("\n"),
    });
  }
  return locations;
}

/** Extracts the root/alias/proxy_pass directive and value from a location. */
function routeMapping(body, locationPath) {
  const targetMatch = body.match(/\b(root|alias|proxy_pass)\s+(\S+?);/);
  assert.ok(targetMatch, `location ${locationPath} has no root/alias/proxy_pass`);
  return { directive: targetMatch[1], target: targetMatch[2] };
}

/** Strips exactly one trailing slash when comparing root targets. */
function withoutTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

test("nothing is public by default: no active (non-comment) line in public_paths.conf mentions `location`", () => {
  // Deliberately format-agnostic, unlike parseLocationBodies above: that
  // parser only recognizes a block whose opening line ends in a lone `{`
  // and whose closing `}` sits alone on its own line. A single-line block
  // -- `location /x/ { return 200 "x"; }` -- is syntactically valid nginx
  // (confirmed against a real nginx container during review) and would
  // actually serve traffic, but is invisible to that parser, which would
  // report zero active locations while a route was actually live. This
  // check can't be fooled by an unexpected block shape because it doesn't
  // try to understand block shape at all: any non-comment line merely
  // containing the word "location" fails it.
  for (const rawLine of publicPathsConf.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    assert.ok(!/\blocation\b/.test(line), `active (uncommented) line mentions location: ${rawLine}`);
  }
});

test("the commented-out public template covers every private application route, not a subset", () => {
  const privateRoutes = privateRouteTable();
  const templateLocations = parseLocationBodies(uncomment(publicPathsConf));
  assert.deepEqual([...templateLocations.keys()].sort(), [...privateRoutes.keys()].sort());
});

function assertPublicTargetsMatch(publicConfig) {
  const privateRoutes = privateRouteTable();
  const templateLocations = parseLocationBodies(uncomment(publicConfig));
  for (const [locationPath, location] of templateLocations) {
    const actual = routeMapping(location.body, locationPath);
    const expected = privateRoutes.get(locationPath);
    assert.ok(expected, `public_paths.conf has a route tailscale-serve-apply.sh does not: ${locationPath}`);
    assert.equal(actual.directive, expected.directive, `${locationPath}: target directive must match`);
    if (expected.directive === "root") {
      assert.equal(
        withoutTrailingSlash(actual.target),
        withoutTrailingSlash(expected.target),
        `${locationPath}: root target must match`,
      );
    } else if (expected.directive === "alias") {
      assert.equal(
        actual.target,
        expected.target,
        `${locationPath}: alias target must match byte-for-byte`,
      );
    } else {
      // Reverse-proxy targets carry the loopback port -- compare byte for byte.
      assert.equal(
        actual.target,
        expected.target,
        `${locationPath}: proxy target must match exactly, including the port`,
      );
    }
  }
}

test("every public_paths.conf target matches its private nginx target", () => {
  assertPublicTargetsMatch(publicPathsConf);
});

test("public alias targets retain their nginx-significant trailing slashes", () => {
  for (const [withSlash, withoutSlash] of [
    [
      "#     alias /home/deploy/lifeos-ui/current/;",
      "#     alias /home/deploy/lifeos-ui/current;",
    ],
    [
      "#     alias /home/deploy/lifeos-ui/current/assets/;",
      "#     alias /home/deploy/lifeos-ui/current/assets;",
    ],
  ]) {
    const mutated = publicPathsConf.replace(withSlash, withoutSlash);
    assert.notEqual(mutated, publicPathsConf, `mutation fixture is absent: ${withSlash}`);
    assert.throws(
      () => assertPublicTargetsMatch(mutated),
      /alias target must match byte-for-byte/,
    );
  }
});

test("the public template preserves the private static namespace policy", () => {
  const privateLocations = parseLocationBodies(privateSpaConf);
  const templateLocations = parseLocationBodies(uncomment(publicPathsConf));

  for (const locationPath of ["/assets/", "/life/assets/"]) {
    const privateLocation = privateLocations.get(locationPath);
    const templateLocation = templateLocations.get(locationPath);
    assert.ok(privateLocation, `private route is missing ${locationPath}`);
    assert.ok(templateLocation, `public template is missing ${locationPath}`);
    assert.equal(privateLocation.modifier, "^~", `${locationPath}: private modifier`);
    assert.equal(templateLocation.modifier, "^~", `${locationPath}: public modifier`);
  }

  for (const locations of [privateLocations, templateLocations]) {
    assert.match(locations.get("/assets/").body, /\btry_files \$uri =404;/);
    assert.doesNotMatch(locations.get("/life/assets/").body, /\bindex\.html\b/);
  }
});

test("nginx.conf exposes isolated private and public loopback listeners", () => {
  assert.match(nginxConf, /listen 127\.0\.0\.1:8080;/);
  assert.match(nginxConf, /listen 127\.0\.0\.1:8081;/);
  assert.doesNotMatch(nginxConf, /listen (?:0\.0\.0\.0|808[01]);/);
});

test("nginx.conf includes public_paths.conf inside the server block", () => {
  assert.match(nginxConf, /include \/etc\/nginx\/public_paths\.conf;/);
});

/**
 * A lightweight structural stand-in for `nginx -t`: every directive line
 * ends in `;`, `{`, or `}`, and braces balance. Not a full parse, but it
 * catches the most likely hand-authoring mistakes (missing semicolon,
 * unbalanced braces) without requiring an nginx binary in every environment
 * this test runs in.
 */
function assertStructurallyValid(confText, label) {
  let depth = 0;
  for (const rawLine of confText.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    for (const char of line) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
    }
    assert.ok(depth >= 0, `${label}: unbalanced closing brace at line: ${rawLine}`);
    assert.ok(
      line.endsWith(";") || line.endsWith("{") || line.endsWith("}"),
      `${label}: directive does not end in ; {  or }: ${rawLine}`,
    );
  }
  assert.equal(depth, 0, `${label}: unbalanced braces`);
}

test("nginx.conf is structurally well-formed (parse check -- no nginx binary assumed)", () => {
  assertStructurallyValid(nginxConf, "nginx.conf");
});

test("public_paths.conf, with every path uncommented, is structurally well-formed", () => {
  // Validate only the reconstructed location blocks, not the file's prose
  // header -- uncomment() strips "# " from every line indiscriminately, so
  // feeding the whole file through it would turn explanatory prose into
  // fake, semicolon-less "directives" and fail this check for the wrong
  // reason.
  const templateLocations = parseLocationBodies(uncomment(publicPathsConf));
  for (const [locationPath, location] of templateLocations) {
    assertStructurallyValid(
      `location ${locationPath} {\n${location.body}\n}`,
      `public_paths.conf: location ${locationPath}`,
    );
  }
});

test("compose.yml uses host networking so nginx can reach loopback backends without publishing a wildcard port", () => {
  assert.match(composeYml, /network_mode: host/);
  assert.doesNotMatch(composeYml, /^\s+ports:/m);
  assert.doesNotMatch(composeYml, /0\.0\.0\.0/);
});

test("cloudflared pins its real host-network metrics listener to one loopback address", () => {
  const cloudflared = serviceBlock("cloudflared");
  assert.match(cloudflared, /^\s+command: tunnel --no-autoupdate --metrics 127\.0\.0\.1:20241 run$/m);
  assert.doesNotMatch(cloudflared, /--metrics (?:0\.0\.0\.0|\[::\]|:)/);
});

test("compose.yml's healthcheck targets the private origin before Serve can migrate", () => {
  assert.match(composeYml, /127\.0\.0\.1:8080\/healthz/);
});

const dockerInfo = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
  timeout: 10_000,
});
const dockerReady = dockerInfo.status === 0;

test(
  "nginx:1.27-alpine accepts the mounted main, private SPA, and public policy configs",
  { skip: !process.env.CI && !dockerReady },
  () => {
    assert.equal(
      dockerInfo.status,
      0,
      `Docker is required for nginx -t in CI: ${dockerInfo.stderr || dockerInfo.error?.message || "unavailable"}`,
    );
    const mount = (source, target) => `${path.resolve(edgeOriginDir, source).replaceAll("\\", "/")}:${target}:ro`;
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--volume",
        mount("nginx.conf", "/etc/nginx/nginx.conf"),
        "--volume",
        mount("private_spa_locations.conf", "/etc/nginx/private_spa_locations.conf"),
        "--volume",
        mount("public_paths.conf", "/etc/nginx/public_paths.conf"),
        "nginx:1.27-alpine",
        "nginx",
        "-t",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /test is successful/);
  },
);
