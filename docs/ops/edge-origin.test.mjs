// Tests for docs/ops/edge-origin/ (issue #165). No nginx binary is assumed
// to exist in every environment this runs in (see the PR's Verification
// section for where that was and wasn't true); these tests are the
// "equivalent parse check" the Issue's acceptance criteria explicitly
// allows as a fallback for `nginx -t`, plus the sync test that is this
// Issue's actual point: the private route table
// (docs/ops/tailscale-serve-apply.sh) and the public one (public_paths.conf)
// must never silently drift apart.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const opsDir = path.dirname(fileURLToPath(import.meta.url));
const serveApplyScript = path.join(opsDir, "tailscale-serve-apply.sh");
const edgeOriginDir = path.join(opsDir, "edge-origin");
const nginxConf = readFileSync(path.join(edgeOriginDir, "nginx.conf"), "utf8");
const publicPathsConf = readFileSync(path.join(edgeOriginDir, "public_paths.conf"), "utf8");
const composeYml = readFileSync(path.join(edgeOriginDir, "compose.yml"), "utf8");

/**
 * The private route table, straight from the script that applies it for
 * real -- not a second hand-parsed copy of its mounts/targets arrays, so
 * this test can't drift from tailscale-serve-apply.sh's own logic. Runs
 * --dry-run with no test-root override, so it reports the real production
 * deploy_root (/home/deploy), matching what public_paths.conf hardcodes.
 */
function privateRouteTable() {
  const output = execFileSync(serveApplyScript, ["--dry-run"], { encoding: "utf8" });
  const routes = new Map();
  for (const line of output.trim().split("\n")) {
    const match = line.match(/--set-path=(\S+)\s+(\S+)$/);
    assert.ok(match, `unparseable tailscale-serve-apply.sh dry-run line: ${line}`);
    routes.set(match[1], match[2]);
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
    const opening = line.match(/^location\s+(?:=\s*)?(\S+)\s*\{$/);
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

test("nothing is public by default: every location in the checked-in public_paths.conf is commented out", () => {
  const activeLocations = parseLocationBodies(publicPathsConf);
  assert.deepEqual([...activeLocations.keys()], []);
});

test("the commented-out template covers every private route, not a subset", () => {
  const privateRoutes = privateRouteTable();
  const templateLocations = parseLocationBodies(uncomment(publicPathsConf));
  assert.deepEqual([...templateLocations.keys()].sort(), [...privateRoutes.keys()].sort());
});

test("every public_paths.conf target matches its tailscale-serve-apply.sh target", () => {
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

test("nginx.conf always exposes /healthz, independent of public_paths.conf", () => {
  const withoutInclude = nginxConf.replace("include /etc/nginx/public_paths.conf;", "");
  const locations = parseLocationBodies(withoutInclude);
  assert.deepEqual([...locations.keys()], ["/healthz"]);
  assert.match(locations.get("/healthz"), /return 200 "ok";/);
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

test("compose.yml binds the edge-origin service to 127.0.0.1:8081 only", () => {
  assert.match(composeYml, /"127\.0\.0\.1:8081:8081"/);
  assert.doesNotMatch(composeYml, /"8081:8081"/);
  assert.doesNotMatch(composeYml, /0\.0\.0\.0/);
});

test("compose.yml's healthcheck targets the always-on /healthz endpoint", () => {
  assert.match(composeYml, /127\.0\.0\.1:8081\/healthz/);
});
