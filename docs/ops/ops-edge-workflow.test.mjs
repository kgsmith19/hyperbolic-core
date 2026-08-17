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

test("the deploy job is gated behind CLOUDFLARE_EDGE_ENABLED", () => {
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

test("the edge Infisical identity/path is distinct from every other pipeline's", () => {
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_PLATFORM_EDGE_IDENTITY_ID \}\}/);
  assert.match(workflow, /secret-path: "\/platform\/edge\/"/);
  assert.doesNotMatch(workflow, /INFISICAL_PLATFORM_RESTIC_IDENTITY_ID/);
  assert.doesNotMatch(workflow, /INFISICAL_PLATFORM_BACKUP_IDENTITY_ID/);
});

test("the tunnel token is never echoed and lands only in a chmod 600 .env, never in nginx.conf/public_paths.conf", () => {
  const joined = workflow.replace(/\\\n[ \t]*/g, " ");
  assert.doesNotMatch(joined, /echo[^\n]*\$\{?CLOUDFLARE_TUNNEL_TOKEN/);
  assert.match(workflow, /chmod 600 \.env/);
  // The fix for a mistake caught during review: nginx.conf/public_paths.conf
  // must NOT be chmod 600 -- they hold no secret, and an owner-only
  // permission would block the nginx container's own worker user (not
  // necessarily `deploy`) from reading the bind-mounted file.
  assert.doesNotMatch(workflow, /chmod 600 (nginx\.conf|public_paths\.conf)/);
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

test("the deploy step ships exactly the three edge-origin files plus the rendered .env, then waits healthy", () => {
  assert.match(workflow, /scp .* docs\/ops\/edge-origin\/compose\.yml docs\/ops\/edge-origin\/nginx\.conf docs\/ops\/edge-origin\/public_paths\.conf/);
  assert.match(workflow, /docker compose up -d --wait/);
  assert.match(workflow, /curl -fsS http:\/\/127\.0\.0\.1:8081\/healthz/);
});

test("the deploy step runs under strict mode", () => {
  assert.match(workflow, /set -euo pipefail/);
});

test("ops-edge.yml parses as valid bash", () => {
  const match = workflow.match(/run: \|\n((?:[ \t]+.*\n?)+)/g);
  assert.ok(match && match.length > 0, "could not extract any run: blocks");
  for (const block of match) {
    const script = block.replace(/^run: \|\n/, "");
    assert.doesNotThrow(() => execFileSync("bash", ["-n"], { input: `#!/usr/bin/env bash\n${script}` }));
  }
});

test("cloudflared has no ports: mapping -- outbound-only, never a listener", () => {
  const cloudflaredStart = compose.indexOf("  cloudflared:");
  assert.ok(cloudflaredStart > -1);
  const cloudflaredBlock = compose.slice(cloudflaredStart);
  assert.doesNotMatch(cloudflaredBlock, /ports:/);
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

test("the tunnel token is required, never defaulted to an empty/placeholder value", () => {
  // Left side is TUNNEL_TOKEN -- the env var name cloudflared itself reads
  // inside the container; the right side substitutes CLOUDFLARE_TUNNEL_TOKEN
  // from compose's own env (the value the deploy step rendered into .env).
  assert.match(compose, /TUNNEL_TOKEN=\$\{CLOUDFLARE_TUNNEL_TOKEN:\?/);
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
