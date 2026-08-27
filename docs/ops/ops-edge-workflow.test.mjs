// Structural assertions over .github/workflows/ops-edge.yml and the
// cloudflared addition to docs/ops/edge-origin/compose.yml (issue #169).
// Each test names the failure it catches.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/ops-edge.yml"), "utf8");
const compose = readFileSync(path.join(root, "docs/ops/edge-origin/compose.yml"), "utf8");

test("the private origin deploy is production-gated while Cloudflare remains independently optional", () => {
  assert.match(workflow, /deploy:\s*\n\s*if: vars\.DEPLOY_ENABLED == 'true' && vars\.PRIVATE_ORIGIN_GATEWAY_ENABLED == 'true'/);
  assert.match(workflow, /if: vars\.CLOUDFLARE_EDGE_ENABLED == 'true'/);
});

test("the push trigger is scoped to edge-origin and this workflow file only", () => {
  // Every commit to main must not redeploy this stack -- only a change
  // that could plausibly affect it.
  assert.match(workflow, /paths:\s*\n\s*- "docs\/ops\/edge-origin\/\*\*"\s*\n\s*- "\.github\/workflows\/ops-edge\.yml"/);
});

test("no SSH key material and no GitHub Actions secrets -- keyless Tailscale SSH + Infisical OIDC only (ADR 008)", () => {
  assert.doesNotMatch(workflow, /\$\{\{ secrets\./);
  assert.doesNotMatch(workflow, /SSH_KEY/);
  assert.doesNotMatch(workflow, /id_ed25519/);
  assert.match(workflow, /tailscale\/github-action@/);
});

test("tailnet auth is always available and the optional edge token keeps its distinct identity/path", () => {
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_SHELL_DEPLOY_IDENTITY_ID \}\}/);
  assert.match(workflow, /secret-path: "\/platform\/shell-deploy\/"/);
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_PLATFORM_EDGE_IDENTITY_ID \}\}/);
  assert.match(workflow, /secret-path: "\/platform\/edge\/"/);
  assert.doesNotMatch(workflow, /INFISICAL_PLATFORM_RESTIC_IDENTITY_ID/);
  assert.doesNotMatch(workflow, /INFISICAL_PLATFORM_BACKUP_IDENTITY_ID/);
});

test("every real expansion of the tunnel token is either a conditional test or redirected to a file, never left to print to the job log", () => {
  // Broader than an "echo"-only check (which independent review found a
  // mutation could slip past: printf '%s' "$CLOUDFLARE_TUNNEL_TOKEN" with no
  // redirect, left unredirected, would print the value to stdout without
  // ever containing the literal word "echo"). This walks every line that
  // actually expands the variable ($CLOUDFLARE_TUNNEL_TOKEN / ${...), not
  // just lines naming it in prose (line 77's error message), and requires
  // each one to be either a `[ -z/-n ... ]` test (never prints the value)
  // or to redirect its output into a file.
  const expansionLines = workflow.split("\n").filter((line) => /\$\{?CLOUDFLARE_TUNNEL_TOKEN\b/.test(line));
  assert.ok(expansionLines.length > 0, "expected at least one real expansion of the token to exist");
  for (const line of expansionLines) {
    const isConditionalTest = /\[\s*-[zn]\s/.test(line);
    const redirectsToFile = />\s*"/.test(line);
    assert.ok(
      isConditionalTest || redirectsToFile,
      `line expands the token without a file redirect or being a conditional test: ${line}`,
    );
  }
});

test("the tunnel token lands only in a chmod 600 .env, never in nginx.conf/public_paths.conf", () => {
  assert.match(workflow, /chmod 600 \.env/);
  // The fix for a mistake caught during review: nginx.conf/public_paths.conf
  // must NOT be chmod 600 -- they hold no secret, and an owner-only
  // permission would block the nginx container's own worker user (not
  // necessarily `deploy`) from reading the bind-mounted file.
  assert.doesNotMatch(workflow, /chmod 600 (nginx\.conf|public_paths\.conf)/);
});

test("the .env file is pre-created at 600 before its content ever lands, closing the first-deploy umask window", () => {
  // Independent review found: a plain `scp` creating a brand-new .env on a
  // box's first-ever deploy would transiently land at the deploy user's
  // default umask (commonly world-readable) for the moment between that scp
  // and a later chmod. touch+chmod BEFORE the content scp closes that
  // window entirely, rather than narrowing it.
  const touchChmod = workflow.indexOf("touch edge-origin/.env && chmod 600 edge-origin/.env");
  const contentScp = workflow.indexOf('scp "${ssh_options[@]}" "$RUNNER_TEMP/.env.edge"');
  assert.ok(touchChmod > -1 && contentScp > -1);
  assert.ok(touchChmod < contentScp, "the file must be created at 600 before its content is copied in");
});

test("no image is docker save|ssh|load'd -- both images are pulled directly on the box", () => {
  // Match actual command invocations, not the header comment's own prose
  // contrasting this workflow with the app units that DO ship images that
  // way (a legitimate "docker save|ssh|load" phrase in explanatory text).
  const nonCommentLines = workflow
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(nonCommentLines, /\bdocker save\b/);
  assert.doesNotMatch(nonCommentLines, /\bdocker load\b/);
  assert.match(workflow, /docker compose pull/);
});

test("the deploy step ships all four origin files, starts nginx alone first, and proves both listeners", () => {
  assert.match(workflow, /scp [\s\S]*?compose\.yml[\s\S]*?nginx\.conf[\s\S]*?private_spa_locations\.conf[\s\S]*?public_paths\.conf/);
  assert.match(workflow, /docker compose up -d --wait edge-origin/);
  assert.match(workflow, /curl -fsS http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(workflow, /curl -fsS http:\/\/127\.0\.0\.1:8081\/healthz/);
  assert.match(workflow, /docker compose --profile cloudflare stop cloudflared/);
});

test("the deploy step runs under strict mode", () => {
  assert.match(workflow, /set -euo pipefail/);
});

test("ops-edge.yml parses as valid bash", () => {
  const match = workflow.match(/run: \|\n((?:[ \t]+.*\n?)+)/g);
  assert.ok(match && match.length > 0, "could not extract any run: blocks");
  for (const block of match) {
    const script = block.replace(/^run: \|\n/, "");
    assert.doesNotThrow(() => execFileSync(process.env.BASH_PATH ?? "bash", ["-n"], { input: `#!/usr/bin/env bash\n${script}` }));
  }
});

test("cloudflared has no ports: or expose: -- outbound-only, never a listener", () => {
  const cloudflaredStart = compose.indexOf("  cloudflared:");
  assert.ok(cloudflaredStart > -1);
  const cloudflaredBlock = compose.slice(cloudflaredStart);
  assert.doesNotMatch(cloudflaredBlock, /ports:/);
  // expose: never publishes to the host either way, but asserting it too
  // (independent review's suggestion) keeps this test honest about the
  // service having no network-facing directive of any kind, not just the
  // one that would actually be dangerous.
  assert.doesNotMatch(cloudflaredBlock, /expose:/);
});

test("cloudflared's ingress is a single blanket rule -- no per-path tunnel config duplicating public_paths.conf", () => {
  // Token-based (dashboard-configured) tunnels need no local ingress
  // config file; asserting one never gets added here keeps the per-path
  // routing decision in exactly one place (nginx's public_paths.conf).
  assert.doesNotMatch(compose, /ingress:/);
  assert.doesNotMatch(compose, /config\.yml/);
});

test("cloudflared waits for edge-origin to be healthy before starting", () => {
  const cloudflaredStart = compose.indexOf("  cloudflared:");
  const cloudflaredBlock = compose.slice(cloudflaredStart);
  assert.match(cloudflaredBlock, /depends_on:\s*\n\s*edge-origin:\s*\n\s*condition: service_healthy/);
});

test("the optional tunnel profile fails closed when enabled without a token", () => {
  assert.match(workflow, /CLOUDFLARE_EDGE_ENABLED is true but CLOUDFLARE_TUNNEL_TOKEN was not supplied/);
  assert.match(compose, /profiles: \["cloudflare"\]/);
});

test("compose.yml still has the expected top-level service structure with cloudflared added", () => {
  // A structural regex smoke test, not YAML/docker-compose validation --
  // real YAML parsing is run ad hoc (python3 yaml.safe_load) during PR
  // verification, same as every other workflow file in this session; no
  // docker daemon is assumed available in every environment this runs in
  // (#165's own tests already documented that constraint).
  assert.match(compose, /services:\s*\n\s*edge-origin:/);
  assert.match(compose, /\n\s*cloudflared:\s*\n/);
});
