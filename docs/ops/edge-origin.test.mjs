// Tests for docs/ops/edge-origin/ (issue #165). No nginx binary is assumed
// to exist in every environment this runs in (see the PR's Verification
// section for where that was and wasn't true); these tests are the
// "equivalent parse check" used when `nginx -t` is unavailable, plus the
// isolation/sync checks between nginx's active private application routes
// and the checked-in, deny-by-default public template.

import assert from "node:assert/strict";
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

/**
 * The private nginx application route table. Tailscale has only one root
 * proxy now, so nginx.conf and its focused SPA include are authoritative.
 */
function privateRouteTable() {
  const routes = new Map();
  for (const [route, body] of [
    ...parseLocationBodies(nginxConf),
    ...parseLocationBodies(privateSpaConf),
  ]) {
    if (route === "/healthz") continue;
    routes.set(route, routeTarget(body, route));
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
 * own line with the closing `}` on its own line (this repo's nginx files
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
    const opening = line.match(/^location\s+(?:(?:=|\^~)\s*)?(\S+)\s*\{$/);
    if (!opening) continue;
    const locationPath = opening[1];
    const bodyLines = [];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "}") {
      bodyLines.push(lines[i]);
      i += 1;
    }
    locations.set(locationPath, bodyLines.join("\n"));
  }
  return locations;
}

/** Extracts the root/alias/proxy_pass value from a location block's body. */
function routeTarget(body, locationPath) {
  const targetMatch = body.match(/\b(?:root|alias|proxy_pass)\s+(\S+?);/);
  assert.ok(targetMatch, `location ${locationPath} has no root/alias/proxy_pass`);
  return targetMatch[1];
}

/** Strips exactly one trailing slash, for comparing alias vs. root targets. */
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

test("every public_paths.conf target matches its private nginx target", () => {
  const privateRoutes = privateRouteTable();
  const templateLocations = parseLocationBodies(uncomment(publicPathsConf));
  for (const [locationPath, body] of templateLocations) {
    const nginxTarget = routeTarget(body, locationPath);
    const expected = privateRoutes.get(locationPath);
    assert.ok(expected, `public_paths.conf has a route tailscale-serve-apply.sh does not: ${locationPath}`);
    if (expected.startsWith("http://")) {
      // Reverse-proxy targets carry the loopback port -- compare byte for byte.
      assert.equal(nginxTarget, expected, `${locationPath}: proxy target must match exactly, including the port`);
    } else {
      assert.equal(
        withoutTrailingSlash(nginxTarget),
        withoutTrailingSlash(expected),
        `${locationPath}: static target must match`,
      );
    }
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
  for (const [locationPath, body] of templateLocations) {
    assertStructurallyValid(`location ${locationPath} {\n${body}\n}`, `public_paths.conf: location ${locationPath}`);
  }
});

test("compose.yml uses host networking so nginx can reach loopback backends without publishing a wildcard port", () => {
  assert.match(composeYml, /network_mode: host/);
  assert.doesNotMatch(composeYml, /^\s+ports:/m);
  assert.doesNotMatch(composeYml, /0\.0\.0\.0/);
});

test("compose.yml's healthcheck targets the private origin before Serve can migrate", () => {
  assert.match(composeYml, /127\.0\.0\.1:8080\/healthz/);
});
