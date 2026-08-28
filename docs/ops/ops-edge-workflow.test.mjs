// Structural assertions over .github/workflows/ops-edge.yml and the
// cloudflared addition to docs/ops/edge-origin/compose.yml (issue #169).
// Each test names the failure it catches.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/ops-edge.yml"), "utf8");
const compose = readFileSync(path.join(root, "docs/ops/edge-origin/compose.yml"), "utf8");
const temporaryDirectories = [];
const remoteMatch = workflow.match(/<<'REMOTE'\r?\n([\s\S]*?)\r?\n\s+REMOTE/);
assert.ok(remoteMatch, "could not extract origin activation remote script");
const remoteScript = remoteMatch[1].replace(/^ {10}/gm, "");

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function originRollbackFixture({
  edgeState,
  cloudflaredState,
  composePresent = true,
  failAt = "probe",
  projectOrphan = false,
  recoveryArtifacts = [],
  rollbackPresent = true,
  serveState = "legacy",
}) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "ops-edge-rollback-"));
  temporaryDirectories.push(fixtureRoot);
  const originDir = path.join(fixtureRoot, "edge-origin");
  const stageDir = path.join(originDir, ".staged-123-1");
  const rollbackDir = path.join(originDir, ".rollback");
  const stateDir = path.join(fixtureRoot, "states");
  const verifierLog = path.join(fixtureRoot, "verifier.log");
  const classifierLog = path.join(fixtureRoot, "classifier.log");
  const cleanupSignalMarker = path.join(fixtureRoot, "cleanup-signal-fired");
  const recoveryRenameMarker = path.join(fixtureRoot, "recovery-rename-fired");
  mkdirSync(stageDir, { recursive: true });
  if (rollbackPresent) mkdirSync(rollbackDir);
  mkdirSync(stateDir);
  if (rollbackPresent) {
    writeFileSync(
      path.join(rollbackDir, "committed-evidence"),
      "prior committed rollback evidence\n",
    );
  }
  for (const [index, artifact] of recoveryArtifacts.entries()) {
    const artifactPath = path.join(originDir, artifact.name);
    if (artifact.type === "directory") {
      mkdirSync(artifactPath);
      for (const [name, contents] of Object.entries(artifact.files ?? {})) {
        writeFileSync(path.join(artifactPath, name), contents);
      }
    } else if (artifact.type === "file") {
      writeFileSync(artifactPath, artifact.contents ?? "recovery evidence\n");
    } else if (artifact.type === "symlink") {
      const target = path.join(fixtureRoot, `recovery-target-${index}`);
      if (artifact.broken !== true) {
        writeFileSync(target, artifact.contents ?? "linked recovery evidence\n");
      }
      symlinkSync(target, artifactPath);
    } else {
      throw new Error(`unsupported recovery artifact type: ${artifact.type}`);
    }
  }
  for (const configFile of [
    "compose.yml",
    "nginx.conf",
    "private_spa_locations.conf",
    "public_paths.conf",
  ]) {
    if (configFile !== "compose.yml" || composePresent) {
      writeFileSync(path.join(originDir, configFile), `old ${configFile}\n`);
    }
    writeFileSync(path.join(stageDir, configFile), `candidate ${configFile}\n`);
  }
  writeFileSync(path.join(originDir, ".env"), "OLD_TOKEN=1\n");
  writeFileSync(path.join(stageDir, ".env"), "CANDIDATE_TOKEN=1\n");
  writeFileSync(
    path.join(stageDir, "verify-private-origin.sh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OPS_EDGE_VERIFIER_LOG"
[[ "$OPS_EDGE_FAIL_AT" != "verifier" ]]
`,
  );
  chmodSync(path.join(stageDir, "verify-private-origin.sh"), 0o755);
  writeFileSync(
    path.join(stageDir, "tailscale-serve-apply.sh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OPS_EDGE_CLASSIFIER_LOG"
case "$OPS_EDGE_SERVE_STATE" in
  gateway|legacy) printf '%s\\n' "$OPS_EDGE_SERVE_STATE" ;;
  *) printf 'error: unsupported Serve state\\n' >&2; exit 88 ;;
esac
`,
  );
  chmodSync(path.join(stageDir, "tailscale-serve-apply.sh"), 0o755);
  writeFileSync(path.join(stateDir, "edge-origin.state"), `${edgeState}\n`);
  writeFileSync(path.join(stateDir, "cloudflared.state"), `${cloudflaredState}\n`);

  const dockerLog = path.join(fixtureRoot, "docker.log");
  const bashEnv = path.join(fixtureRoot, "bash-env.sh");
  writeFileSync(dockerLog, "");
  writeFileSync(verifierLog, "");
  writeFileSync(classifierLog, "");
  writeFileSync(
    bashEnv,
    `service_state() {
  tr -d '\\n' < "$OPS_EDGE_STATE_DIR/$1.state"
}
set_service_state() {
  printf '%s\\n' "$2" > "$OPS_EDGE_STATE_DIR/$1.state"
}
existing_container() {
  if [[ "$(service_state "$1")" != "absent" ]]; then
    if [[ "$(service_state "$1")" == "duplicate" ]]; then
      printf '%s-old-container\\n%s-duplicate-container\\n' "$1" "$1"
    else
      printf '%s-old-container\\n' "$1"
    fi
  fi
}
docker_status() {
  case "$(service_state "$1")" in
    stopped) printf 'exited\\n' ;;
    *) service_state "$1"; printf '\\n' ;;
  esac
}
all_project_containers() {
  existing_container edge-origin
  existing_container cloudflared
  if [[ "$OPS_EDGE_PROJECT_ORPHAN" == "true" ]]; then
    printf 'project-orphan-container\\n'
  fi
}
snapshot_is_complete() {
  local snapshot_dir="$1"
  local config_file service state suffix
  [[ -s "$snapshot_dir/runtime-state" ]] || return 1
  for config_file in compose.yml nginx.conf private_spa_locations.conf public_paths.conf; do
    if [[ -e "$snapshot_dir/$config_file" ]]; then
      [[ ! -e "$snapshot_dir/$config_file.absent" ]] || return 1
    else
      [[ -e "$snapshot_dir/$config_file.absent" ]] || return 1
    fi
  done
  if [[ -e "$snapshot_dir/.env" ]]; then
    [[ ! -e "$snapshot_dir/.env.absent" ]] || return 1
  else
    [[ -e "$snapshot_dir/.env.absent" ]] || return 1
  fi
  for service in edge-origin cloudflared; do
    state="$(service_state "$service")"
    if [[ "$state" != "absent" ]]; then
      for suffix in container-id image-id image-ref retained-ref; do
        [[ -s "$snapshot_dir/$service.$suffix" ]] || return 1
      done
    fi
  done
}
find() {
  if [[ "$1" == ".staged-123-1" ]]; then
    case "$OPS_EDGE_FAIL_AT" in
      cleanup) return 95 ;;
      cleanup-signal)
        if [[ ! -e "$OPS_EDGE_CLEANUP_SIGNAL_MARKER" ]]; then
          : > "$OPS_EDGE_CLEANUP_SIGNAL_MARKER"
          kill -TERM "$BASHPID"
        fi
        ;;
    esac
  fi
  command find "$@"
}
mv() {
  if [[ "$*" == "-T -- .rollback .rollback.previous-123-1" &&
        "$OPS_EDGE_FAIL_AT" == "snapshot-first-rename" ]]; then
    return 94
  fi
  if [[ "$*" == "-T -- .rollback.staged-123-1 .rollback" ]]; then
    if ! snapshot_is_complete .rollback.staged-123-1; then
      printf 'fs snapshot-incomplete-at-promotion\\n' >> "$OPS_EDGE_DOCKER_LOG"
      return 98
    fi
    printf 'fs snapshot-complete-before-promotion\\n' >> "$OPS_EDGE_DOCKER_LOG"
    if [[ "$OPS_EDGE_FAIL_AT" == "snapshot-promote" ]]; then
      return 99
    fi
    if [[ "$OPS_EDGE_FAIL_AT" == "recovery-rename" ]]; then
      : > "$OPS_EDGE_RECOVERY_RENAME_MARKER"
      return 99
    fi
    if [[ "$OPS_EDGE_FAIL_AT" == "snapshot-promote-second-signal" ]]; then
      command mv "$@"
      kill -TERM "$BASHPID"
      return 143
    fi
  fi
  if [[ "$*" == "-T -- .rollback.previous-123-1 .rollback" &&
        "$OPS_EDGE_FAIL_AT" == "recovery-rename" &&
        -e "$OPS_EDGE_RECOVERY_RENAME_MARKER" ]]; then
    return 93
  fi
  if [[ "$*" == "-T -- .rollback .rollback.previous-123-1" &&
        "$OPS_EDGE_FAIL_AT" == "snapshot-promote-signal" ]]; then
    command mv "$@"
    kill -TERM "$BASHPID"
    return 143
  fi
  command mv "$@"
}
docker() {
  printf '%s\\n' "$*" >> "$OPS_EDGE_DOCKER_LOG"
  if [[ "$OPS_EDGE_FAIL_AT" == "nginx" &&
        "$*" == "compose -f .staged-123-1/compose.yml run -T --rm --no-deps edge-origin nginx -t" ]]; then
    return 96
  fi
  case "$*" in
    "ps --all --quiet --filter label=com.docker.compose.project=edge-origin")
      if [[ "$OPS_EDGE_FAIL_AT" == "project-discovery" ]]; then
        return 89
      fi
      all_project_containers
      ;;
    "ps --all --quiet --filter label=com.docker.compose.project=edge-origin --filter label=com.docker.compose.service=edge-origin")
      existing_container edge-origin
      ;;
    "ps --all --quiet --filter label=com.docker.compose.project=edge-origin --filter label=com.docker.compose.service=cloudflared")
      existing_container cloudflared
      ;;
    "inspect --format {{.State.Status}} edge-origin-old-container")
      if [[ "$OPS_EDGE_FAIL_AT" == "state-inspect" ]]; then
        return 90
      fi
      docker_status edge-origin
      ;;
    "inspect --format {{.State.Status}} cloudflared-old-container")
      docker_status cloudflared
      ;;
    "inspect --format {{.Image}} edge-origin-old-container")
      if [[ "$OPS_EDGE_FAIL_AT" == "image-inspect" ]]; then
        return 91
      fi
      printf 'sha256:edge-old\\n'
      ;;
    "inspect --format {{.Config.Image}} edge-origin-old-container")
      if [[ "$OPS_EDGE_FAIL_AT" != "image-metadata-empty" ]]; then
        printf 'nginx:old\\n'
      fi
      ;;
    "inspect --format {{.Image}} cloudflared-old-container")
      printf 'sha256:cloudflared-old\\n'
      ;;
    "inspect --format {{.Config.Image}} cloudflared-old-container")
      printf 'cloudflare/cloudflared:old\\n'
      ;;
    "image inspect sha256:edge-old" | "image inspect --format {{.Id}} hyperbolic-rollback/edge-origin:"*)
      if [[ "$OPS_EDGE_FAIL_AT" == "retained-ref-mismatch" &&
            "$*" == "image inspect --format {{.Id}} hyperbolic-rollback/edge-origin:edge-old" ]]; then
        printf 'sha256:wrong-image\\n'
      else
        printf 'sha256:edge-old\\n'
      fi
      ;;
    "image inspect sha256:cloudflared-old" | "image inspect --format {{.Id}} hyperbolic-rollback/cloudflared:"*)
      if [[ "$OPS_EDGE_FAIL_AT" == "snapshot-marker-conflict" &&
            "$*" == "image inspect sha256:cloudflared-old" ]]; then
        : > .rollback.staged-123-1/compose.yml.absent
      fi
      printf 'sha256:cloudflared-old\\n'
      ;;
    "compose --profile cloudflare up -d --wait --force-recreate")
      set_service_state edge-origin running
      set_service_state cloudflared running
      ;;
    "compose up -d --wait edge-origin --force-recreate --pull never")
      set_service_state edge-origin running
      ;;
    "compose --profile cloudflare up -d --wait --no-deps --force-recreate --pull never cloudflared")
      set_service_state cloudflared running
      ;;
    "compose stop edge-origin")
      set_service_state edge-origin stopped
      ;;
    "compose --profile cloudflare stop cloudflared")
      set_service_state cloudflared stopped
      ;;
    "compose up --no-start --no-deps --force-recreate --pull never edge-origin")
      set_service_state edge-origin stopped
      ;;
    "compose --profile cloudflare up --no-start --no-deps --force-recreate --pull never cloudflared")
      set_service_state cloudflared stopped
      ;;
    "compose rm --stop --force edge-origin")
      set_service_state edge-origin absent
      ;;
    "compose --profile cloudflare rm --stop --force cloudflared")
      set_service_state cloudflared absent
      ;;
  esac
}
curl() {
  [[ "$OPS_EDGE_FAIL_AT" == "probe" ]] && return 97
  if [[ "\${!#}" == "http://127.0.0.1:8081/" ]]; then
    printf '404'
  fi
  return 0
}
`,
  );
  assert.doesNotThrow(() =>
    execFileSync(process.env.BASH_PATH ?? "bash", ["-n", bashEnv]),
  );

  const result = spawnSync(
    process.env.BASH_PATH ?? "bash",
    ["-c", `. "$OPS_EDGE_FIXTURE_ENV"\n${remoteScript}`, "ops-edge-test", "true", "123-1"],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPS_EDGE_FIXTURE_ENV: bashEnv,
        OPS_EDGE_CLASSIFIER_LOG: classifierLog,
        OPS_EDGE_CLEANUP_SIGNAL_MARKER: cleanupSignalMarker,
        OPS_EDGE_DOCKER_LOG: dockerLog,
        OPS_EDGE_FAIL_AT: failAt,
        OPS_EDGE_PROJECT_ORPHAN: projectOrphan ? "true" : "false",
        OPS_EDGE_RECOVERY_RENAME_MARKER: recoveryRenameMarker,
        OPS_EDGE_SERVE_STATE: serveState,
        OPS_EDGE_STATE_DIR: stateDir,
        OPS_EDGE_VERIFIER_LOG: verifierLog,
      },
    },
  );
  const calls = readFileSync(dockerLog, "utf8").trim().split("\n").filter(Boolean);
  function describeRecoveryPath(candidate) {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      return { type: "symlink", target: readlinkSync(candidate) };
    }
    if (stat.isDirectory()) {
      return {
        type: "directory",
        files: Object.fromEntries(
          readdirSync(candidate).map((entry) => [
            entry,
            readFileSync(path.join(candidate, entry)),
          ]),
        ),
      };
    }
    return { type: "file", contents: readFileSync(candidate) };
  }
  const recoveryEvidence = Object.fromEntries(
    readdirSync(originDir)
      .filter((entry) => entry.startsWith(".rollback."))
      .map((entry) => [
        entry,
        describeRecoveryPath(path.join(originDir, entry)),
      ]),
  );
  return {
    activeConfigs: Object.fromEntries(
      [
        "compose.yml",
        "nginx.conf",
        "private_spa_locations.conf",
        "public_paths.conf",
      ].map((configFile) => [
        configFile,
        existsSync(path.join(originDir, configFile))
          ? readFileSync(path.join(originDir, configFile), "utf8")
          : null,
      ]),
    ),
    calls,
    classifierCalls: readFileSync(classifierLog, "utf8").trim().split("\n").filter(Boolean),
    finalStates: {
      edge: readFileSync(path.join(stateDir, "edge-origin.state"), "utf8").trim(),
      cloudflared: readFileSync(path.join(stateDir, "cloudflared.state"), "utf8").trim(),
    },
    verifierCalls: readFileSync(verifierLog, "utf8").trim().split("\n").filter(Boolean),
    stageExists: existsSync(stageDir),
    rollbackContents: existsSync(rollbackDir)
      ? Object.fromEntries(
          readdirSync(rollbackDir).map((entry) => [
            entry,
            readFileSync(path.join(rollbackDir, entry), "utf8"),
          ]),
        )
      : null,
    snapshotTemporaryPaths: readdirSync(originDir).filter((entry) =>
      entry.startsWith(".rollback."),
    ),
    recoveryEvidence,
    result,
  };
}

test("the private origin deploy is production-gated while Cloudflare remains independently optional", () => {
  assert.match(workflow, /deploy:\s*\n\s*if: vars\.DEPLOY_ENABLED == 'true' && vars\.PRIVATE_ORIGIN_GATEWAY_ENABLED == 'true'/);
  assert.match(workflow, /if: vars\.CLOUDFLARE_EDGE_ENABLED == 'true'/);
});

test("the push trigger includes every origin input, including both shared scripts", () => {
  // Every commit to main must not redeploy this stack -- only a change
  // that could plausibly affect it.
  assert.match(
    workflow,
    /paths:\s*\n\s*- "docs\/ops\/edge-origin\/\*\*"\s*\n\s*- "docs\/ops\/verify-private-origin\.sh"\s*\n\s*- "docs\/ops\/tailscale-serve-apply\.sh"\s*\n\s*- "\.github\/workflows\/ops-edge\.yml"/,
  );
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

test("the staged .env file is pre-created at 600 before its content ever lands, closing the first-deploy umask window", () => {
  // Independent review found: a plain `scp` creating a brand-new .env on a
  // box's first-ever deploy would transiently land at the deploy user's
  // default umask (commonly world-readable) for the moment between that scp
  // and a later chmod. Creating the destination with install -m 600 BEFORE
  // the content scp closes that window entirely, rather than narrowing it.
  const createAtMode = workflow.indexOf(
    "install -m 600 /dev/null edge-origin/.staged-$deployment_id/.env",
  );
  const contentScp = workflow.indexOf('scp "${ssh_options[@]}" "$local_secret_file"');
  assert.ok(createAtMode > -1 && contentScp > -1);
  assert.ok(createAtMode < contentScp, "the file must be created at 600 before its content is copied in");
});

function assertLocalSecretLifecycle(source) {
  const exitTrap = source.indexOf("trap cleanup_remote_stage EXIT");
  const render = source.indexOf(`> "$local_secret_file"`);
  const transfer = source.indexOf(
    'scp "${ssh_options[@]}" "$local_secret_file" "deploy@$DEPLOY_HOST:edge-origin/.staged-$deployment_id/.env"',
  );
  const immediateDelete = source.indexOf('rm -f -- "$local_secret_file"', transfer);
  const remoteActivation = source.indexOf(
    'ssh "${ssh_options[@]}" "deploy@$DEPLOY_HOST" "bash -s --',
    transfer,
  );
  assert.ok(exitTrap > -1 && render > exitTrap, "EXIT/signal cleanup must be armed before secret creation");
  assert.ok(transfer > render, "the local secret must exist only until its transfer");
  assert.ok(
    immediateDelete > transfer && immediateDelete < remoteActivation,
    "the local secret must be deleted immediately after transfer",
  );
  assert.equal(
    (source.match(/rm -f -- "\$local_secret_file"/g) ?? []).length,
    2,
    "cleanup needs one EXIT-path deletion and one immediate post-transfer deletion",
  );
  assert.match(
    source,
    /cleanup_remote_stage\(\) \{[\s\S]*?rm -f -- "\$local_secret_file"[\s\S]*?\n\s*\}/,
  );
}

test("the runner-local tunnel token is deleted immediately and by every exit path", () => {
  assertLocalSecretLifecycle(workflow);
  const deleteLine = 'rm -f -- "$local_secret_file"';
  const lastDelete = workflow.lastIndexOf(deleteLine);
  for (const mutant of [
    workflow.replace("trap cleanup_remote_stage EXIT", "# EXIT cleanup removed"),
    workflow.replace(deleteLine, "# EXIT-path local secret deletion removed"),
    `${workflow.slice(0, lastDelete)}# immediate local secret deletion removed${workflow.slice(lastDelete + deleteLine.length)}`,
  ]) {
    assert.throws(() => assertLocalSecretLifecycle(mutant));
  }
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
  assert.match(workflow, /cd "\$stage_dir"\s*\n\s*docker compose pull edge-origin/);
  assert.match(workflow, /cd "\$stage_dir"\s*\n\s*docker compose --profile cloudflare pull/);
});

test("the deploy step ships all origin inputs, starts nginx alone first, and proves both listeners", () => {
  assert.match(workflow, /scp [\s\S]*?compose\.yml[\s\S]*?nginx\.conf[\s\S]*?private_spa_locations\.conf[\s\S]*?public_paths\.conf[\s\S]*?verify-private-origin\.sh[\s\S]*?tailscale-serve-apply\.sh/);
  assert.match(workflow, /docker compose up -d --wait edge-origin/);
  assert.match(workflow, /curl -fsS --max-time \d+ http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(workflow, /curl -fsS --max-time \d+ http:\/\/127\.0\.0\.1:8081\/healthz/);
  assert.match(workflow, /docker compose --profile cloudflare stop cloudflared/);
});

test("origin config is staged and nginx-tested before any active file is replaced", () => {
  assert.match(workflow, /stage_dir="\.staged-\$deployment_id"/);
  assert.match(workflow, /scp [\s\S]*?"deploy@\$DEPLOY_HOST:edge-origin\/\.staged-\$deployment_id\/"/);
  const nginxTest = workflow.indexOf('docker compose -f "$stage_dir/compose.yml" run -T --rm --no-deps edge-origin nginx -t');
  const activation = workflow.indexOf("activation_started=true");
  assert.ok(nginxTest > -1, "the staged compose/config set must pass real nginx -t");
  assert.ok(activation > nginxTest, "activation cannot begin before nginx -t succeeds");
});

test("activation backs up the exact prior files and restores them automatically on failure", () => {
  assert.match(workflow, /backup_dir="\.rollback"/);
  assert.match(workflow, /snapshot_stage_dir="\.rollback\.staged-\$deployment_id"/);
  assert.match(workflow, /snapshot_previous_dir="\.rollback\.previous-\$deployment_id"/);
  assert.match(workflow, /trap restore_previous EXIT/);
  assert.match(workflow, /trap 'exit 130' INT/);
  assert.match(workflow, /trap 'exit 143' TERM/);
  assert.match(workflow, /trap 'exit 129' HUP/);
  assert.match(workflow, /cp -a "\$config_file" "\$snapshot_stage_dir\/\$config_file"/);
  assert.match(workflow, /cp -a "\$backup_dir\/\$config_file" "\$config_file"/);
  assert.match(workflow, /"\$backup_dir\/\$config_file\.absent"/);
  assert.ok(
    (workflow.match(/--force-recreate/g) ?? []).length >= 2,
    "both activation and rollback must recreate nginx so bind mounts resolve the selected files",
  );
});

test("cleanup and rollback traps cover pull and nginx validation failures, including staged .env", () => {
  const exitTrap = workflow.indexOf("trap restore_previous EXIT");
  const pull = workflow.indexOf('docker compose pull edge-origin');
  const nginxTest = workflow.indexOf('docker compose -f "$stage_dir/compose.yml" run -T --rm --no-deps edge-origin nginx -t');
  assert.ok(exitTrap > -1 && pull > -1 && nginxTest > -1);
  assert.ok(exitTrap < pull, "EXIT cleanup must be armed before a pull can fail");
  assert.ok(exitTrap < nginxTest, "EXIT cleanup must be armed before nginx -t can fail");
  assert.match(workflow, /cleanup_stage\(\)[\s\S]*?find "\$stage_dir" -mindepth 1 -maxdepth 1 -type f -delete/);
  assert.match(workflow, /trap - EXIT INT TERM HUP/);
});

function assertVisibleOuterStageCleanup(source) {
  const cleanup = source.match(/cleanup_remote_stage\(\) \{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  const cleanupCommand = cleanup.match(
    /if ! ssh\b[\s\S]*?\n\s*"(?<command>find [^"\n]+)"; then/,
  )?.groups?.command;
  assert.match(cleanup, /local original_status="\$\?"/);
  assert.equal(
    cleanupCommand,
    "find 'edge-origin/.staged-$deployment_id' -mindepth 1 -maxdepth 1 -type f -delete && rmdir 'edge-origin/.staged-$deployment_id'",
  );
  assert.match(cleanup, /::warning::failed to remove remote stage edge-origin\/\.staged-\$deployment_id/);
  assert.match(cleanup, /exit "\$original_status"/);
}

test("best-effort outer stage cleanup warns visibly without replacing the original exit status", () => {
  assertVisibleOuterStageCleanup(workflow);
  for (const mutant of [
    workflow.replace("::warning::failed to remove remote stage", "silenced remote stage cleanup"),
    workflow.replace('exit "$original_status"', "exit 1"),
    workflow.replace("find 'edge-origin/.staged-$deployment_id'", "find 'edge-origin'"),
  ]) {
    assert.throws(() => assertVisibleOuterStageCleanup(mutant));
  }
});

test("rollback records and restores the exact images used by every previously existing service", () => {
  assert.match(workflow, /docker inspect --format '\{\{\.Image\}\}' "\$container_id" > "\$snapshot_stage_dir\/\$service\.image-id"/);
  assert.match(workflow, /docker inspect --format '\{\{\.Config\.Image\}\}' "\$container_id" > "\$snapshot_stage_dir\/\$service\.image-ref"/);
  assert.match(workflow, /capture_service_state edge-origin edge_previous_state/);
  assert.match(workflow, /capture_service_state cloudflared cloudflared_previous_state/);
  assert.match(workflow, /runtime-state/);

  const imageCapture = workflow.indexOf("capture_service_state edge-origin edge_previous_state");
  const firstPull = workflow.indexOf("docker compose pull edge-origin");
  assert.ok(imageCapture > -1 && imageCapture < firstPull, "the old image ID must be captured before mutable tags are pulled");

  assert.match(workflow, /case "\$image_ref" in[\s\S]*?\*@sha256:\* \| sha256:\*\)/);
  assert.match(workflow, /restore_image_reference\(\)[\s\S]*?docker image tag "\$image_id" "\$image_ref"/);
  const rollbackStart = workflow.indexOf("origin activation failed; restoring");
  const restoreTag = workflow.indexOf("restore_image_reference edge-origin", rollbackStart);
  const rollbackRecreate = workflow.indexOf(
    "docker compose up -d --wait edge-origin --force-recreate",
    rollbackStart,
  );
  assert.ok(restoreTag > rollbackStart, "rollback must restore the prior mutable image reference");
  assert.ok(restoreTag < rollbackRecreate, "restoring the prior image must precede rollback recreation");
});

test("rollback preflight discovers exact labelled containers and records full stable state", () => {
  assert.match(workflow, /edge_previous_state=(?:"absent"|absent)/);
  assert.match(workflow, /cloudflared_previous_state=(?:"absent"|absent)/);
  assert.match(
    workflow,
    /docker ps --all --quiet[\s\S]*?label=com\.docker\.compose\.project=edge-origin[\s\S]*?label=com\.docker\.compose\.service=\$service/,
  );
  assert.match(
    workflow,
    /docker ps --all --quiet[\s\S]*?label=com\.docker\.compose\.project=edge-origin/,
  );
  assert.match(
    workflow,
    /docker inspect --format '\{\{\.State\.Status\}\}' "\$container_id"/,
  );
  assert.doesNotMatch(workflow, /\.State\.Running/);
  assert.doesNotMatch(
    workflow,
    /docker compose(?: --profile cloudflare)? ps --all -q "\$service"/,
  );
  assert.match(workflow, /printf 'edge_previous_state=%s/);
  assert.match(workflow, /printf 'cloudflared_previous_state=%s/);
});

test("the absent-env rollback marker is created exactly once", () => {
  assert.equal(
    (workflow.match(/: > "\$snapshot_stage_dir\/\.env\.absent"/g) ?? []).length,
    1,
  );
});

function assertCrossRunRecoveryPreflight(source) {
  const staleScan = source.indexOf("recovery_artifacts=(.rollback.staged-* .rollback.previous-*)");
  const firstDockerRead = source.indexOf(
    'if ! project_container_output="$(docker ps --all --quiet',
  );
  assert.ok(staleScan > -1, "every recovery suffix must be scanned before the transaction starts");
  assert.ok(
    firstDockerRead > staleScan,
    "cross-run recovery evidence must fail before Docker inspection",
  );
  assert.match(source, /shopt -s nullglob[\s\S]*?recovery_artifacts=\(\.rollback\.staged-\* \.rollback\.previous-\*\)[\s\S]*?shopt -u nullglob/);
  assert.match(source, /stale rollback promotion recovery artifacts/);
  assert.match(source, /snapshot_stage_created_by_this_run=false/);
  assert.match(
    source,
    /mkdir "\$snapshot_stage_dir"\s+snapshot_stage_created_by_this_run=true/,
  );
  assert.match(
    source,
    /if \[\[ "\$snapshot_stage_created_by_this_run" == "true" && "\$snapshot_promotion_started" != "true" \]\]; then\s+cleanup_snapshot_directory "\$snapshot_stage_dir"/,
  );
}

test("cross-run rollback recovery evidence is a read-only preflight and cleanup is invocation-owned", () => {
  assertCrossRunRecoveryPreflight(workflow);
  for (const mutant of [
    workflow.replace(".rollback.previous-*", ".rollback.previous-$deployment_id"),
    workflow.replace("snapshot_stage_created_by_this_run=true", "snapshot_stage_created_by_this_run=false"),
  ]) {
    assert.throws(() => assertCrossRunRecoveryPreflight(mutant));
  }
});

function assertPreflightRejectedBeforeMutation(fixture, failure) {
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.match(fixture.result.stderr, failure);
  assert.doesNotMatch(
    fixture.calls.join("\n"),
    /^(?:image tag|compose .*\b(?:pull|run|up|stop|rm)\b)/m,
    "preflight failures must occur before image retention, pull, validation, or activation",
  );
  assert.deepEqual(fixture.rollbackContents, {
    "committed-evidence": "prior committed rollback evidence\n",
  });
  assert.deepEqual(
    fixture.snapshotTemporaryPaths,
    [],
    "read-only preflight failures must clean only the unpromoted snapshot",
  );
  for (const [configFile, contents] of Object.entries(fixture.activeConfigs)) {
    if (contents !== null) {
      assert.equal(
        contents,
        `old ${configFile}\n`,
        `${configFile} must remain active`,
      );
    }
  }
}

test("rollback preflight rejects every stale cross-run recovery artifact without touching its bytes", () => {
  const stagedBytes = Buffer.from([0x00, 0x41, 0xff, 0x0a]);
  const previousBytes = Buffer.from([0x50, 0x52, 0x49, 0x4f, 0x52, 0x0a]);
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "stopped",
    failAt: "",
    recoveryArtifacts: [
      {
        name: ".rollback.staged-122-9",
        type: "directory",
        files: { ".env": stagedBytes },
      },
      {
        name: ".rollback.previous-121-8",
        type: "file",
        contents: previousBytes,
      },
      {
        name: ".rollback.staged-120-7",
        type: "symlink",
        broken: true,
      },
    ],
  });

  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.match(fixture.result.stderr, /stale rollback promotion recovery artifacts/i);
  for (const artifact of [
    ".rollback.previous-121-8",
    ".rollback.staged-120-7",
    ".rollback.staged-122-9",
  ]) {
    assert.match(fixture.result.stderr, new RegExp(artifact.replaceAll(".", "\\.")));
  }
  assert.deepEqual(fixture.calls, [], "recovery evidence must be checked before Docker inspection or mutation");
  assert.deepEqual(
    fixture.recoveryEvidence[".rollback.staged-122-9"],
    { type: "directory", files: { ".env": stagedBytes } },
  );
  assert.deepEqual(
    fixture.recoveryEvidence[".rollback.previous-121-8"],
    { type: "file", contents: previousBytes },
  );
  assert.equal(
    fixture.recoveryEvidence[".rollback.staged-120-7"].type,
    "symlink",
  );
  assert.deepEqual(fixture.rollbackContents, {
    "committed-evidence": "prior committed rollback evidence\n",
  });
});

test("a pre-existing current-ID staged directory is never cleanup-owned by a later invocation", () => {
  const envBytes = Buffer.from("sole staged .env evidence\n");
  const fixture = originRollbackFixture({
    edgeState: "absent",
    cloudflaredState: "absent",
    failAt: "",
    rollbackPresent: false,
    recoveryArtifacts: [
      {
        name: ".rollback.staged-123-1",
        type: "directory",
        files: { ".env": envBytes },
      },
    ],
  });

  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.match(fixture.result.stderr, /stale rollback promotion recovery artifacts/i);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.rollbackContents, null);
  assert.deepEqual(
    fixture.recoveryEvidence[".rollback.staged-123-1"],
    { type: "directory", files: { ".env": envBytes } },
  );
});

for (const dockerState of ["paused", "restarting", "dead", "removing"]) {
  test(`rollback preflight rejects ${dockerState} before any mutation`, () => {
    assertPreflightRejectedBeforeMutation(
      originRollbackFixture({
        edgeState: dockerState,
        cloudflaredState: "absent",
        failAt: "",
      }),
      new RegExp(`unsupported Docker state.*edge-origin.*${dockerState}`, "i"),
    );
  });
}

test("rollback preflight rejects duplicate exact-label service containers", () => {
  assertPreflightRejectedBeforeMutation(
    originRollbackFixture({
      edgeState: "duplicate",
      cloudflaredState: "absent",
      failAt: "",
    }),
    /expected exactly one.*edge-origin container/i,
  );
});

test("rollback preflight rejects a compose-absent live service container", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "absent",
    composePresent: false,
    failAt: "",
  });
  assert.equal(fixture.activeConfigs["compose.yml"], null);
  assertPreflightRejectedBeforeMutation(
    fixture,
    /compose\.yml is absent.*edge-origin project container exists/i,
  );
});

test("rollback preflight rejects a compose-absent project-labelled orphan", () => {
  const fixture = originRollbackFixture({
    edgeState: "absent",
    cloudflaredState: "absent",
    composePresent: false,
    failAt: "",
    projectOrphan: true,
  });
  assert.equal(fixture.activeConfigs["compose.yml"], null);
  assertPreflightRejectedBeforeMutation(
    fixture,
    /compose\.yml is absent.*edge-origin project container exists/i,
  );
});

test("rollback preflight preserves committed evidence when project discovery fails", () => {
  assertPreflightRejectedBeforeMutation(
    originRollbackFixture({
      edgeState: "absent",
      cloudflaredState: "absent",
      failAt: "project-discovery",
    }),
    /could not discover existing edge-origin project containers/i,
  );
});

test("rollback preflight preserves committed evidence when state inspection fails", () => {
  assertPreflightRejectedBeforeMutation(
    originRollbackFixture({
      edgeState: "running",
      cloudflaredState: "absent",
      failAt: "state-inspect",
    }),
    /could not inspect Docker state for edge-origin/i,
  );
});

test("rollback preflight preserves committed evidence when image inspection fails", () => {
  assertPreflightRejectedBeforeMutation(
    originRollbackFixture({
      edgeState: "running",
      cloudflaredState: "absent",
      failAt: "image-inspect",
    }),
    /could not inspect Docker image metadata for edge-origin/i,
  );
});

test("rollback preflight preserves committed evidence when image metadata is incomplete", () => {
  assertPreflightRejectedBeforeMutation(
    originRollbackFixture({
      edgeState: "running",
      cloudflaredState: "absent",
      failAt: "image-metadata-empty",
    }),
    /incomplete image metadata for edge-origin/i,
  );
});

test("rollback snapshot validation rejects conflicting file markers before promotion", () => {
  assertPreflightRejectedBeforeMutation(
    originRollbackFixture({
      edgeState: "running",
      cloudflaredState: "running",
      failAt: "snapshot-marker-conflict",
    }),
    /must contain exactly one marker for compose\.yml/i,
  );
});

test("retained image validation fails before promotion without replacing committed evidence", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "absent",
    failAt: "retained-ref-mismatch",
  });
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.match(
    fixture.result.stderr,
    /retained image reference for edge-origin does not resolve/i,
  );
  assert.deepEqual(fixture.rollbackContents, {
    "committed-evidence": "prior committed rollback evidence\n",
  });
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  assert.ok(
    fixture.calls.includes(
      "image tag sha256:edge-old hyperbolic-rollback/edge-origin:edge-old",
    ),
  );
  assert.doesNotMatch(
    fixture.calls.join("\n"),
    /^(?:fs snapshot-complete-before-promotion|compose .*\b(?:pull|run|up|stop|rm)\b)/m,
  );
});

function assertRecoverablePromotionFailure(fixture) {
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.deepEqual(fixture.rollbackContents, {
    "committed-evidence": "prior committed rollback evidence\n",
  });
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  assert.ok(
    fixture.calls.includes("fs snapshot-complete-before-promotion"),
    "the complete staged snapshot must reach the promotion boundary",
  );
  assert.doesNotMatch(
    fixture.calls.join("\n"),
    /^compose .*\b(?:pull|run|up|stop|rm)\b/m,
    "promotion failure must occur before pull, validation, or activation",
  );
}

test("rollback snapshot promotion failure restores the prior committed evidence", () => {
  assertRecoverablePromotionFailure(
    originRollbackFixture({
      edgeState: "running",
      cloudflaredState: "running",
      failAt: "snapshot-promote",
    }),
  );
});

test("a first rollback-snapshot rename failure leaves prior evidence current", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "snapshot-first-rename",
  });
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.deepEqual(fixture.rollbackContents, {
    "committed-evidence": "prior committed rollback evidence\n",
  });
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  assert.doesNotMatch(
    fixture.calls.join("\n"),
    /^(?:fs snapshot-complete-before-promotion|compose .*\b(?:pull|run|up|stop|rm)\b)/m,
  );
});

test("a signal between rollback snapshot renames restores the prior committed evidence", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "snapshot-promote-signal",
  });
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.deepEqual(fixture.rollbackContents, {
    "committed-evidence": "prior committed rollback evidence\n",
  });
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  assert.doesNotMatch(
    fixture.calls.join("\n"),
    /^compose .*\b(?:pull|run|up|stop|rm)\b/m,
  );
});

test("a signal after the second snapshot rename but before the promoted flag restores prior evidence", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "snapshot-promote-second-signal",
  });
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.deepEqual(fixture.rollbackContents, {
    "committed-evidence": "prior committed rollback evidence\n",
  });
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  assert.doesNotMatch(
    fixture.calls.join("\n"),
    /^compose .*\b(?:pull|run|up|stop|rm)\b/m,
  );
});

test("a recovery rename failure preserves both prior and complete new evidence", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "recovery-rename",
  });
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.match(fixture.result.stderr, /prior rollback evidence remains recoverable/i);
  assert.equal(fixture.rollbackContents, null);
  assert.equal(
    fixture.recoveryEvidence[".rollback.previous-123-1"].files[
      "committed-evidence"
    ].toString(),
    "prior committed rollback evidence\n",
  );
  assert.equal(
    fixture.recoveryEvidence[".rollback.staged-123-1"].files[".env"].toString(),
    "OLD_TOKEN=1\n",
  );
  assert.match(
    fixture.recoveryEvidence[".rollback.staged-123-1"].files[
      "runtime-state"
    ].toString(),
    /^deployment_id=123-1$/m,
  );
  assert.doesNotMatch(
    fixture.calls.join("\n"),
    /^compose .*\b(?:pull|run|up|stop|rm)\b/m,
  );
});

test("a first deployment promotes a complete current rollback source before pull", () => {
  const fixture = originRollbackFixture({
    edgeState: "absent",
    cloudflaredState: "absent",
    failAt: "nginx",
    rollbackPresent: false,
  });
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  assert.equal(fixture.rollbackContents[".env"], "OLD_TOKEN=1\n");
  assert.match(fixture.rollbackContents["runtime-state"], /^deployment_id=123-1$/m);
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  const promotion = fixture.calls.indexOf("fs snapshot-complete-before-promotion");
  const pull = fixture.calls.indexOf("compose --profile cloudflare pull");
  assert.ok(promotion > -1 && pull > promotion);
});

test("the complete rollback snapshot becomes current before pull and drives recovery", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "nginx",
  });
  assert.notEqual(fixture.result.status, 0, fixture.result.stderr);
  const promotion = fixture.calls.indexOf(
    "fs snapshot-complete-before-promotion",
  );
  const edgeRetain = fixture.calls.indexOf(
    "image tag sha256:edge-old hyperbolic-rollback/edge-origin:edge-old",
  );
  const edgeRetainProof = fixture.calls.indexOf(
    "image inspect --format {{.Id}} hyperbolic-rollback/edge-origin:edge-old",
  );
  const cloudflaredRetain = fixture.calls.indexOf(
    "image tag sha256:cloudflared-old hyperbolic-rollback/cloudflared:cloudflared-old",
  );
  const cloudflaredRetainProof = fixture.calls.indexOf(
    "image inspect --format {{.Id}} hyperbolic-rollback/cloudflared:cloudflared-old",
  );
  const pull = fixture.calls.indexOf("compose --profile cloudflare pull");
  assert.ok(
    edgeRetain > -1 &&
      edgeRetainProof > edgeRetain &&
      cloudflaredRetain > edgeRetainProof &&
      cloudflaredRetainProof > cloudflaredRetain &&
      promotion > cloudflaredRetainProof &&
      pull > promotion,
    "both exact retained image references must resolve before snapshot promotion and pull",
  );
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  assert.deepEqual(
    Object.keys(fixture.rollbackContents).sort(),
    [
      ".env",
      "cloudflared.container-id",
      "cloudflared.image-id",
      "cloudflared.image-ref",
      "cloudflared.retained-ref",
      "compose.yml",
      "edge-origin.container-id",
      "edge-origin.image-id",
      "edge-origin.image-ref",
      "edge-origin.retained-ref",
      "nginx.conf",
      "private_spa_locations.conf",
      "public_paths.conf",
      "runtime-state",
    ].sort(),
  );
  for (const [configFile, contents] of Object.entries(fixture.activeConfigs)) {
    assert.equal(contents, `old ${configFile}\n`, configFile);
  }
});

test("rollback recreates a previously stopped edge container and removes an absent cloudflared candidate", () => {
  const { calls, finalStates, result } = originRollbackFixture({
    edgeState: "stopped",
    cloudflaredState: "absent",
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.deepEqual(finalStates, { edge: "stopped", cloudflared: "absent" });

  const metadata = calls.indexOf("inspect --format {{.Image}} edge-origin-old-container");
  const pull = calls.indexOf("compose --profile cloudflare pull");
  const restoreTag = calls.indexOf("image tag sha256:edge-old nginx:old");
  const recreateStopped = calls.indexOf(
    "compose up --no-start --no-deps --force-recreate --pull never edge-origin",
  );
  const removeAbsent = calls.indexOf("compose --profile cloudflare rm --stop --force cloudflared");
  assert.ok(metadata > -1 && metadata < pull, "stopped-image metadata must be captured before pull");
  assert.ok(restoreTag > pull && restoreTag < recreateStopped, "old stopped image must be restored before create");
  assert.ok(
    removeAbsent > pull && removeAbsent < recreateStopped,
    "the absent cloudflared candidate must be removed before recreating prior stopped services",
  );
});

test("rollback removes an absent edge candidate and recreates a previously stopped cloudflared container", () => {
  const { calls, finalStates, result } = originRollbackFixture({
    edgeState: "absent",
    cloudflaredState: "stopped",
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.deepEqual(finalStates, { edge: "absent", cloudflared: "stopped" });

  const metadata = calls.indexOf("inspect --format {{.Image}} cloudflared-old-container");
  const pull = calls.indexOf("compose --profile cloudflare pull");
  const removeAbsent = calls.indexOf("compose rm --stop --force edge-origin");
  const restoreTag = calls.indexOf(
    "image tag sha256:cloudflared-old cloudflare/cloudflared:old",
  );
  const recreateStopped = calls.indexOf(
    "compose --profile cloudflare up --no-start --no-deps --force-recreate --pull never cloudflared",
  );
  assert.ok(metadata > -1 && metadata < pull, "stopped-image metadata must be captured before pull");
  assert.ok(
    removeAbsent > pull && removeAbsent < recreateStopped,
    "the absent edge candidate must be removed before recreating prior stopped services",
  );
  assert.ok(restoreTag > pull && restoreTag < recreateStopped, "old stopped image must be restored before create");
});

test("a preparation failure restores mutable image references for stopped services without changing runtime state", () => {
  const { calls, finalStates, result } = originRollbackFixture({
    edgeState: "stopped",
    cloudflaredState: "stopped",
    failAt: "nginx",
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.deepEqual(finalStates, { edge: "stopped", cloudflared: "stopped" });

  const failedNginx = calls.indexOf(
    "compose -f .staged-123-1/compose.yml run --rm --no-deps edge-origin nginx -t",
  );
  const edgeRetag = calls.indexOf("image tag sha256:edge-old nginx:old");
  const cloudflaredRetag = calls.indexOf(
    "image tag sha256:cloudflared-old cloudflare/cloudflared:old",
  );
  assert.ok(failedNginx > -1 && edgeRetag > failedNginx && cloudflaredRetag > failedNginx);
  assert.doesNotMatch(
    calls.slice(failedNginx + 1).join("\n"),
    /compose .*\b(?:up|rm|stop)\b/,
    "pre-activation cleanup must restore image references without changing container state",
  );
});

test("running-service rollback recreates both exact old images without pulling", () => {
  const { calls, finalStates, result } = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.deepEqual(finalStates, { edge: "running", cloudflared: "running" });

  for (const [retag, recreate] of [
    [
      "image tag sha256:edge-old nginx:old",
      "compose up -d --wait edge-origin --force-recreate --pull never",
    ],
    [
      "image tag sha256:cloudflared-old cloudflare/cloudflared:old",
      "compose --profile cloudflare up -d --wait --no-deps --force-recreate --pull never cloudflared",
    ],
  ]) {
    const retagIndex = calls.indexOf(retag);
    const recreateIndex = calls.indexOf(recreate);
    assert.ok(retagIndex > -1 && recreateIndex > retagIndex);
  }
});

function assertTransactionSafety(source) {
  const exitTrap = source.indexOf("trap restore_previous EXIT");
  const firstPull = source.indexOf("docker compose pull edge-origin");
  assert.ok(exitTrap > -1 && exitTrap < firstPull);
  assert.match(source, /trap 'exit 129' HUP/);
  const curlLines = source
    .split("\n")
    .filter((line) => /\bcurl\b/.test(line) && /127\.0\.0\.1:808[01]/.test(line));
  assert.ok(curlLines.length >= 3, "expected private health and both public-listener probes");
  for (const line of curlLines) {
    assert.match(line, /--max-time [1-9][0-9]*/);
  }
}

test("the transaction-safety oracle catches late traps, missing HUP handling, and unbounded probes", () => {
  assertTransactionSafety(workflow);
  const mutants = [
    workflow.replace("trap restore_previous EXIT", "# trap removed"),
    workflow.replaceAll("trap 'exit 129' HUP", "# HUP trap removed"),
    workflow.replace(/--max-time [1-9][0-9]*/, ""),
  ];
  for (const mutant of mutants) {
    assert.throws(() => assertTransactionSafety(mutant));
  }
});

function assertVerifierInsideRollback(source) {
  const rollbackArmed = source.indexOf("trap restore_previous EXIT");
  const verifier = source.indexOf('"$stage_dir/verify-private-origin.sh" http://127.0.0.1:8080');
  const activationStarted = source.lastIndexOf("activation_started=true", verifier);
  const disarmedBeforeVerifier = source.lastIndexOf("activation_started=false", verifier);
  const rollbackDisarmed = source.indexOf("activation_started=false", verifier);
  assert.ok(rollbackArmed > -1 && verifier > rollbackArmed, "rollback must be armed before verification");
  assert.ok(activationStarted > disarmedBeforeVerifier, "activation rollback must remain active during verification");
  assert.ok(rollbackDisarmed > verifier, "rollback cannot be disarmed until verification passes");
}

test("activation invokes the staged content verifier while rollback is armed", () => {
  assertVerifierInsideRollback(workflow);
  assert.match(workflow, /chmod 0755 "\$stage_dir\/verify-private-origin\.sh"/);
  for (const mutant of [
    workflow.replace('"$stage_dir/verify-private-origin.sh" http://127.0.0.1:8080', ":"),
    workflow.replace('"$stage_dir/verify-private-origin.sh" http://127.0.0.1:8080', 'activation_started=false\n          "$stage_dir/verify-private-origin.sh" http://127.0.0.1:8080'),
  ]) {
    assert.throws(() => assertVerifierInsideRollback(mutant));
  }
  assert.match(workflow, /public_status=.*curl[\s\S]*?http:\/\/127\.0\.0\.1:8081\//);
  assert.match(workflow, /\[\[ "\$public_status" != "404" \]\]/);
});

function assertClassifierInsideRollback(source) {
  const verifier = source.indexOf('"$stage_dir/verify-private-origin.sh" http://127.0.0.1:8080');
  const publicDeny = source.indexOf('[[ "$public_status" != "404" ]]', verifier);
  const classifier = source.indexOf('"$stage_dir/tailscale-serve-apply.sh" --classify-status', publicDeny);
  const activationStarted = source.lastIndexOf("activation_started=true", classifier);
  const disarmedBeforeClassifier = source.lastIndexOf("activation_started=false", classifier);
  const cleanup = source.indexOf("cleanup_stage", classifier);
  const rollbackDisarmed = source.indexOf("activation_started=false", classifier);
  assert.ok(verifier > -1 && publicDeny > verifier, "content and public probes must precede classification");
  assert.ok(classifier > publicDeny, "Serve classification must follow the candidate probes");
  assert.ok(activationStarted > disarmedBeforeClassifier, "activation rollback must remain active during classification");
  assert.ok(cleanup > classifier, "staging cannot be cleaned before classification");
  assert.ok(rollbackDisarmed > classifier, "rollback cannot be disarmed before classification");
}

test("Serve classification runs after candidate proof while origin rollback remains armed", () => {
  assertClassifierInsideRollback(workflow);
  assert.match(workflow, /chmod 0755 "\$stage_dir\/verify-private-origin\.sh" "\$stage_dir\/tailscale-serve-apply\.sh"/);
  for (const mutant of [
    workflow.replace('"$stage_dir/tailscale-serve-apply.sh" --classify-status', ":"),
    workflow.replace(
      '"$stage_dir/tailscale-serve-apply.sh" --classify-status',
      'activation_started=false\n          "$stage_dir/tailscale-serve-apply.sh" --classify-status',
    ),
  ]) {
    assert.throws(() => assertClassifierInsideRollback(mutant));
  }
});

function assertSuccessCleanupAfterRollbackDisarm(source) {
  const classifier = source.indexOf(
    '"$stage_dir/tailscale-serve-apply.sh" --classify-status',
  );
  const rollbackDisarmed = source.indexOf(
    "trap - EXIT INT TERM HUP",
    classifier,
  );
  const committed = source.indexOf(
    "activation_started=false",
    rollbackDisarmed,
  );
  const previousSnapshotCleanup = source.indexOf(
    'if ! cleanup_snapshot_directory "$snapshot_previous_dir"; then',
    committed,
  );
  const cleanupMatch = source
    .slice(classifier)
    .match(/\n\s+(?:if ! )?cleanup_stage(?:;|$)/m);
  const cleanup = cleanupMatch
    ? classifier + cleanupMatch.index
    : -1;
  assert.ok(classifier > -1);
  assert.ok(
    rollbackDisarmed > classifier &&
      committed > rollbackDisarmed &&
      previousSnapshotCleanup > committed &&
      cleanup > previousSnapshotCleanup &&
      cleanup > committed,
    "verified activation must disarm automatic rollback and retire the prior snapshot before stage cleanup",
  );
  assert.match(
    source.slice(cleanup),
    /warning: verified origin activation remains committed, but staged-file cleanup failed/,
  );
}

test("successful cleanup is best-effort only after automatic rollback is disarmed", () => {
  assertSuccessCleanupAfterRollbackDisarm(workflow);
  const orderedBoundary = `trap - EXIT INT TERM HUP
          activation_started=false`;
  const earlyCleanup = workflow.replace(
    orderedBoundary,
    `cleanup_stage
          trap - EXIT INT TERM HUP
          activation_started=false`,
  );
  assert.notEqual(
    earlyCleanup,
    workflow,
    "the cleanup-order mutation must alter the workflow",
  );
  assert.throws(() => assertSuccessCleanupAfterRollbackDisarm(earlyCleanup));
  assert.throws(() =>
    assertSuccessCleanupAfterRollbackDisarm(
      workflow.replace(
        "warning: verified origin activation remains committed, but staged-file cleanup failed",
        "cleanup failed",
      ),
    ),
  );
});

function assertCandidateConfigsRemainActive(fixture) {
  for (const [configFile, contents] of Object.entries(fixture.activeConfigs)) {
    assert.equal(contents, `candidate ${configFile}\n`, configFile);
  }
}

test("a successful activation survives and reports stage cleanup failure", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "cleanup",
    serveState: "gateway",
  });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assertCandidateConfigsRemainActive(fixture);
  assert.equal(fixture.stageExists, true);
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  assert.match(
    fixture.result.stderr,
    /verified origin activation remains committed, but staged-file cleanup failed/,
  );
  assert.doesNotMatch(
    fixture.result.stderr,
    /restoring|previous origin configuration restored/i,
  );
});

test("a signal during post-commit cleanup cannot re-enter automatic rollback", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "cleanup-signal",
    serveState: "gateway",
  });
  assert.notEqual(fixture.result.status, 0);
  assertCandidateConfigsRemainActive(fixture);
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  assert.doesNotMatch(
    fixture.result.stderr,
    /restoring|previous origin configuration restored/i,
  );
});

test("a content-verifier failure rolls the activated origin back", () => {
  const fixture = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "verifier",
  });
  const { finalStates, result, verifierCalls } = fixture;
  assert.notEqual(result.status, 0);
  assert.deepEqual(verifierCalls, ["http://127.0.0.1:8080"]);
  assert.deepEqual(finalStates, { edge: "running", cloudflared: "running" });
  assert.deepEqual(fixture.snapshotTemporaryPaths, []);
  for (const [configFile, contents] of Object.entries(fixture.activeConfigs)) {
    assert.equal(contents, `old ${configFile}\n`, configFile);
  }
  assert.match(result.stderr, /previous origin configuration restored/);
});

function assertGatewayOnlySmoke(source) {
  assert.match(
    source,
    /\n  smoke:\s*\n\s*name: [^\n]+\n\s*needs: deploy\n\s*if: needs\.deploy\.result == 'success' && needs\.deploy\.outputs\.serve_state == 'gateway'\n\s*uses: \.\/\.github\/workflows\/platform-smoke\.yml\n\s*permissions:\n\s*contents: read\n\s*id-token: write/,
  );
}

test("known legacy activation succeeds without scheduling pre-cutover tailnet smoke", () => {
  const { classifierCalls, result } = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "",
    serveState: "legacy",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(classifierCalls, ["--classify-status"]);
  assert.match(result.stdout, /^__OPS_ORIGIN_SERVE_STATE__=legacy$/m);
  assertGatewayOnlySmoke(workflow);
});

test("an exact gateway activation exposes the output that schedules steady-state smoke", () => {
  const { classifierCalls, result } = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "",
    serveState: "gateway",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(classifierCalls, ["--classify-status"]);
  assert.match(result.stdout, /^__OPS_ORIGIN_SERVE_STATE__=gateway$/m);
  assertGatewayOnlySmoke(workflow);
});

test("an unknown Serve state fails origin activation and restores the previous runtime", () => {
  const { classifierCalls, finalStates, result } = originRollbackFixture({
    edgeState: "running",
    cloudflaredState: "running",
    failAt: "",
    serveState: "unknown",
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(classifierCalls, ["--classify-status"]);
  assert.deepEqual(finalStates, { edge: "running", cloudflared: "running" });
  assert.match(result.stderr, /previous origin configuration restored/);
  assert.doesNotMatch(result.stdout, /__OPS_ORIGIN_SERVE_STATE__=/);
});

test("origin smoke is gated only by a successful exact gateway classification", () => {
  assertGatewayOnlySmoke(workflow);
  assert.match(workflow, /outputs:\s*\n\s*serve_state: \$\{\{ steps\.activate\.outputs\.serve_state \}\}/);
  const remoteEnd = workflow.indexOf("\n          REMOTE");
  const outputWrite = workflow.indexOf(`printf 'serve_state=%s\\n' "$serve_state" >> "$GITHUB_OUTPUT"`);
  assert.ok(remoteEnd > -1 && outputWrite > remoteEnd, "job output must be written only after SSH succeeds");
  for (const mutant of [
    workflow.replace(" && needs.deploy.outputs.serve_state == 'gateway'", ""),
    workflow.replace("needs.deploy.outputs.serve_state == 'gateway'", "needs.deploy.outputs.serve_state != ''"),
  ]) {
    assert.throws(() => assertGatewayOnlySmoke(mutant));
  }
  assert.doesNotMatch(workflow, /\n\s*probe\(\) \{/);
});

test("the deploy step runs under strict mode", () => {
  assert.match(workflow, /set -euo pipefail/);
});

test("ops-edge.yml parses as valid bash", () => {
  const match = workflow.match(/run: \|\r?\n((?:[ \t]+.*\r?\n?)+)/g);
  assert.ok(match && match.length > 0, "could not extract any run: blocks");
  for (const block of match) {
    const script = block.replace(/^run: \|\r?\n/, "");
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
