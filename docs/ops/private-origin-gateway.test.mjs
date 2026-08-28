import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function runManualEdgeVerification(edgePreviousState, edgeIsRunning) {
  const match = runbook.match(
    /# Verify the restored edge-origin runtime matches its recorded state\.\n([\s\S]*?\nesac)/,
  );
  assert.ok(match, "manual rollback must include executable state-aware verification");
  const script = `set -euo pipefail
docker() {
  printf 'docker:%s\\n' "$*" >&2
  if [[ "$EDGE_IS_RUNNING" == "true" ]]; then printf 'edge-origin\\n'; fi
}
curl() {
  printf 'curl:%s\\n' "$*" >&2
}
edge_previous_state="$1"
${match[1]}
`;
  return spawnSync(
    process.env.BASH_PATH ?? "bash",
    ["-c", script, "manual-edge-verification", edgePreviousState],
    {
      encoding: "utf8",
      env: { ...process.env, EDGE_IS_RUNNING: String(edgeIsRunning) },
    },
  );
}

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
  assert.deepEqual(
    [...locationMap(privateSpa).keys()].sort(),
    ["/", "/assets/", "/life", "/life/", "/life/assets/"].sort(),
  );
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
  assert.match(publicServer, /root \/var\/empty\/hyperbolic-public-deny-by-default;/);
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

test("Serve preflights nginx and converges to one root without a zero-route reset", () => {
  assert.match(serveApply, /curl -fsS --max-time 5 http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(serveApply, /command -v python3/);
  assert.match(serveApply, /--set-path=\/[\s\S]*?http:\/\/127\.0\.0\.1:8080/);
  assert.match(serveApply, /legacy_mounts=\(\/life\/ \/life\/api\/ \/api\/ \/api\/brain\/\)/);
  assert.match(serveApply, /tailscale serve --yes --https=443 "--set-path=\$mount" off/);
  assert.doesNotMatch(serveApply, /tailscale serve (?:reset|get-config|set-config)/);
  assert.doesNotMatch(serveApply, /handler does not exist/);
  assert.doesNotMatch(serveApply, /tailscale serve status(?! --json)/);

  const rootInstall = serveApply.indexOf('if ! "${root_command[@]}"');
  const targetedRemovals = serveApply.indexOf('for mount in "${legacy_mounts[@]}"; do', rootInstall);
  assert.ok(rootInstall > -1 && targetedRemovals > rootInstall, "the nginx root must exist before any legacy mount is removed");

  assert.match(serveApply, /initial_status="\$\(tailscale serve status --json\)"/);
  assert.match(serveApply, /present_mounts="\$\(validate_initial_json "\$initial_status"\)"/);
  assert.match(serveApply, /final_status="\$\(tailscale serve status --json\)"/);
  assert.match(serveApply, /set\(tcp\) != \{"443"\}/);
  assert.match(serveApply, /listener != \{"HTTPS": True\}/);
  assert.match(serveApply, /len\(web\) != 1/);
  assert.match(serveApply, /set\(handlers\) != \{"\/"\}/);
  assert.match(serveApply, /root != \{"Proxy": "http:\/\/127\.0\.0\.1:8080"\}/);
  for (const sibling of ["Services", "AllowFunnel", "Foreground"]) {
    assert.match(serveApply, new RegExp(`"${sibling}"`));
  }
  assert.match(serveApply, /the nginx root proxy remains active and later legacy routes were not changed/);
  for (const knownPriorTarget of ["8000", "8100", "8200", "lifeos-ui", "shell/current"]) {
    assert.match(serveApply, new RegExp(knownPriorTarget));
  }
});

test("the origin workflow starts nginx independently of the optional Cloudflare tunnel", () => {
  assert.match(edgeWorkflow, /if: vars\.DEPLOY_ENABLED == 'true' && vars\.PRIVATE_ORIGIN_GATEWAY_ENABLED == 'true'/);
  assert.match(edgeWorkflow, /docker compose pull edge-origin/);
  assert.match(edgeWorkflow, /docker compose up -d --wait edge-origin/);
  assert.match(edgeWorkflow, /DEPLOY_HOST must be a non-empty DNS name or IPv4 address/);
  assert.match(edgeWorkflow, /curl -fsS --max-time \d+ http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(edgeWorkflow, /private_spa_locations\.conf/);
  assert.match(edgeWorkflow, /if: vars\.CLOUDFLARE_EDGE_ENABLED == 'true'/);
});

test("Serve transport still ships the checked-in script and cannot mutate before its preflight", () => {
  assert.match(
    serveWorkflow,
    /scp .*docs\/ops\/tailscale-serve-apply\.sh .*docs\/ops\/verify-private-origin\.sh/,
  );
  assert.match(serveWorkflow, /chmod 0755 tailscale-serve-apply\.sh verify-private-origin\.sh/);
  assert.match(serveWorkflow, /\.\/tailscale-serve-apply\.sh --apply/);
  assert.doesNotMatch(serveWorkflow, /tailscale serve reset/);
  assert.doesNotMatch(serveWorkflow, /tailscale serve status(?! --json)/);
  const contentPreflight = serveApply.indexOf('"$private_origin_verifier" http://127.0.0.1:8080');
  const initialStatus = serveApply.indexOf('initial_status="$(tailscale serve status --json)"');
  assert.ok(contentPreflight > -1 && initialStatus > contentPreflight);
});

test("Serve apply and steady-state origin deploys delegate release verification after cutover", () => {
  assert.match(
    edgeWorkflow,
    /needs: deploy\n\s*if: needs\.deploy\.result == 'success' && needs\.deploy\.outputs\.serve_state == 'gateway'\n\s*uses: \.\/\.github\/workflows\/platform-smoke\.yml/,
    "origin smoke must run only when the read-only classifier proves cutover already exists",
  );
  assert.match(
    serveWorkflow,
    /\n  smoke:\s*\n\s*name: [^\n]+\n\s*needs: apply\n\s*if: needs\.apply\.result == 'success'\n\s*uses: \.\/\.github\/workflows\/platform-smoke\.yml\n\s*permissions:\n\s*contents: read\n\s*id-token: write/,
  );
  assert.match(
    runbook,
    /Ops Origin[^\n]+local loopback[^\n]+Ops Serve Apply[^\n]+Platform Smoke/,
    "the operator sequence must be origin loopback proof, Serve convergence, then live smoke",
  );
  assert.match(runbook, /--classify-status/);
  assert.match(runbook, /legacy[^\n]+skip[^\n]+Platform Smoke/i);
  assert.match(runbook, /gateway[^\n]+Platform Smoke/i);
});

test("the runbook states the automatic rollback boundary and gives metadata-based manual rollback", () => {
  assert.match(
    runbook,
    /Automatic origin rollback covers failures through the local loopback and private\/public route probes and this read-only Serve classification\./,
  );
  assert.match(
    runbook,
    /Platform Smoke is release-blocking but runs after the SSH rollback transaction has committed/,
  );
  assert.match(runbook, /operator-directed rollback/);
  for (const artifact of [
    ".rollback/runtime-state",
    ".rollback/edge-origin.image-id",
    ".rollback/edge-origin.image-ref",
    ".rollback/cloudflared.image-id",
    ".rollback/cloudflared.image-ref",
  ]) {
    assert.match(runbook, new RegExp(artifact.replaceAll(".", "\\.")));
  }
  assert.match(runbook, /docker image tag "\$image_id" "\$image_ref"/);
  assert.match(runbook, /docker compose up -d --wait edge-origin --force-recreate/);
  assert.match(runbook, /edge_previous_state="\$\(state edge_previous_state\)"/);
  assert.match(runbook, /cloudflared_previous_state="\$\(state cloudflared_previous_state\)"/);
  assert.doesNotMatch(runbook, /edge_was_running|cloudflared_was_running/);
  assert.match(
    runbook,
    /docker compose up --no-start --no-deps --force-recreate --pull never edge-origin/,
  );
  assert.match(
    runbook,
    /docker compose --profile cloudflare up --no-start --no-deps --force-recreate --pull never cloudflared/,
  );
  assert.match(runbook, /docker compose rm --stop --force edge-origin/);
  assert.match(runbook, /docker compose --profile cloudflare rm --stop --force cloudflared/);
  assert.match(
    runbook,
    /docker compose up -d --wait edge-origin --force-recreate --pull never/,
  );
  assert.match(
    runbook,
    /docker compose --profile cloudflare up -d --wait --no-deps --force-recreate --pull never cloudflared/,
  );
});

test("the runbook stops reruns on stale promotion recovery evidence and correlates its deployment", () => {
  assert.match(runbook, /\.rollback\.staged-\*/);
  assert.match(runbook, /\.rollback\.previous-\*/);
  assert.match(runbook, /stop[^.]+inspect[^.]+recover[^.]+before (?:re)?running `Ops Origin`/i);
  assert.match(runbook, /never\s+automatically\s+deletes?\s+ambiguous\s+rollback evidence/i);
  assert.match(runbook, /deployment_id[^.]+\.rollback\/runtime-state/i);
  assert.match(runbook, /promotion[^.]+before[^.]+Docker pull/i);
});

test("the runbook archives one secret-bearing rollback artifact into a private exact path", () => {
  const archiveBlock = [...runbook.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map((match) => match[1])
    .find((block) => block.includes("edge-origin-rollback-archive"));
  assert.ok(archiveBlock, "the private rollback archive procedure must be an exact bash block");
  const syntax = spawnSync(process.env.BASH_PATH ?? "bash", ["-n"], {
    encoding: "utf8",
    input: archiveBlock,
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(
    runbook,
    /rollback artifact[^.]+live secret-bearing\s+`?\.env`?/i,
  );
  assert.match(runbook, /do not use[^.]+default-readable[^.]+(?:tar|copy)/i);
  assert.match(runbook, /umask 077/);
  assert.match(
    runbook,
    /archive_dir='\/home\/deploy\/edge-origin-rollback-archive'/,
  );
  const artifactValidation = runbook.indexOf(
    '[[ "$artifact" =~ ^\\.rollback\\.(staged|previous)-[0-9]+-[0-9]+$ ]]',
  );
  const destinationConstruction = runbook.indexOf(
    'destination="$archive_dir/$artifact"',
  );
  assert.ok(
    artifactValidation > -1 && destinationConstruction > artifactValidation,
    "the exact artifact basename must be validated before destination construction",
  );
  assert.match(runbook, /install -d -m 0700 -- "\$archive_dir"/);
  assert.match(runbook, /mv -T -- "\$artifact" "\$destination"/);
  assert.match(runbook, /stat -c '%a' -- "\$archive_dir"/);
  assert.match(runbook, /chmod 0700 -- "\$archive_dir"/);
  assert.match(runbook, /\[\[ -e "\$artifact" \|\| -L "\$artifact" \]\]/);
  assert.match(
    runbook,
    /\[\[ ! -e "\$destination" && ! -L "\$destination" \]\]/,
  );
  assert.match(
    runbook,
    /\[\[ -d "\$destination" && ! -L "\$destination" \]\]/,
  );
  assert.match(
    runbook,
    /\[\[ -f "\$destination\/\.env" && ! -L "\$destination\/\.env" \]\]/,
  );
  assert.match(runbook, /stat -c '%a' -- "\$destination\/\.env"/);
  assert.match(runbook, /chmod 0600 -- "\$destination\/\.env"/);
  assert.match(
    archiveBlock,
    /\[\[ -f \.rollback\/runtime-state && ! -L \.rollback\/runtime-state && -r \.rollback\/runtime-state && -s \.rollback\/runtime-state \]\]/,
  );
  assert.match(
    runbook,
    /before `mv`[^.]+failure[^.]+source untouched/i,
  );
  assert.match(
    runbook,
    /after `mv`[^.]+failure[^.]+artifact at the\s+destination/i,
  );
  assert.match(
    runbook,
    /mode-0700 archive directory[^.]+not traversable by other users/i,
  );
  assert.match(
    runbook,
    /explicit post-move checks[^.]+`?\.env`? modes/i,
  );
  assert.doesNotMatch(
    runbook,
    /`umask 077`[^.]+prevents a default-readable destination/i,
  );
  assert.doesNotMatch(runbook, /(?:mv|cp|rm)\s+[^\n]*(?:\.rollback\.staged-\*|\.rollback\.previous-\*)/);
});

test("manual origin rollback verifies health only for a prior running edge", () => {
  const running = runManualEdgeVerification("running", true);
  assert.equal(running.status, 0, running.stderr);
  assert.match(running.stderr, /curl:-fsS --max-time 10 http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.doesNotMatch(running.stderr, /docker:/);

  for (const priorState of ["stopped", "absent"]) {
    const restored = runManualEdgeVerification(priorState, false);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(
      restored.stderr,
      /docker:ps --filter label=com\.docker\.compose\.project=edge-origin --filter label=com\.docker\.compose\.service=edge-origin --format \{\{\.ID\}\}/,
    );
    assert.doesNotMatch(restored.stderr, /curl:/);
  }
});

test("manual origin rollback fails if a prior stopped or absent edge is running", () => {
  for (const priorState of ["stopped", "absent"]) {
    const mismatch = runManualEdgeVerification(priorState, true);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /edge-origin is running after restoring prior state/);
    assert.doesNotMatch(mismatch.stderr, /curl:/);
  }
});
