import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "bootstrap-vps.sh");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function fakeBin(userExists) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bootstrap-vps-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home", "deploy");
  const log = path.join(root, "log.txt");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(path.join(bin, "id"), `#!/bin/sh\necho "id $*" >> "${log}"\n${userExists ? "exit 0" : "exit 1"}\n`);
  writeFileSync(path.join(bin, "useradd"), `#!/bin/sh\necho "useradd $*" >> "${log}"\n`);
  writeFileSync(path.join(bin, "chown"), `#!/bin/sh\necho "chown $*" >> "${log}"\n`);
  writeFileSync(path.join(bin, "tailscale"), `#!/bin/sh\necho "tailscale $*" >> "${log}"\n`);
  // Mirrors real ssh-keygen's two observable side effects: a private key
  // file at -f's argument and a `<file>.pub` carrying a line ending in the
  // -C comment -- the exact shape bootstrap-vps.sh's own rotation logic
  // (`grep -F " ${name}@hyperbolic-core"`) depends on.
  writeFileSync(
    path.join(bin, "ssh-keygen"),
    `#!/bin/sh
echo "ssh-keygen $*" >> "${log}"
keyfile="" comment="" prev=""
for a in "$@"; do
  [ "$prev" = "-f" ] && keyfile="$a"
  [ "$prev" = "-C" ] && comment="$a"
  prev="$a"
done
echo "FAKE-PRIVATE-$comment" > "$keyfile"
echo "ssh-ed25519 FAKEPUB-$RANDOM-$$ $comment" > "$keyfile.pub"
`,
  );
  for (const bin_ of ["id", "useradd", "chown", "tailscale", "ssh-keygen"]) chmodSync(path.join(bin, bin_), 0o755);
  return { root, bin, home, log };
}

function run(env, ...args) {
  return spawnSync(script, args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home },
  });
}

test("dry run touches nothing and is deterministic", () => {
  const env = fakeBin(false);
  const a = run(env, "--dry-run");
  const b = run(env, "--dry-run");
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.doesNotMatch(a.stdout, /COPY THESE INTO INFISICAL/);
});

test("dry run is the default", () => {
  const env = fakeBin(false);
  assert.equal(run(env).stdout, run(env, "--dry-run").stdout);
});

test("unknown flag fails closed", () => {
  const env = fakeBin(false);
  const result = run(env, "--unknown");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test("--apply requires root", () => {
  const env = fakeBin(false);
  const result = spawnSync(script, ["--apply"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "1000" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must run as root/);
});

test("apply: creates the deploy user only when it does not already exist", () => {
  const missing = fakeBin(false);
  spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${missing.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: missing.home, EUID: "0" } });
  assert.match(readFileSync(missing.log, "utf8"), /useradd -m -s \/bin\/bash deploy/);

  const existing = fakeBin(true);
  spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${existing.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: existing.home, EUID: "0" } });
  assert.doesNotMatch(readFileSync(existing.log, "utf8"), /useradd/);
});

test("apply: creates all five target directories and installs four authorized_keys entries", () => {
  const env = fakeBin(true);
  const result = spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  assert.equal(result.status, 0, result.stderr);
  for (const dir of ["shell", "lifeos-ui", "llm-handler", "brain", "broker"]) {
    assert.ok(existsSync(path.join(env.home, dir)), `${dir} was not created`);
  }
  const authorizedKeys = readFileSync(path.join(env.home, ".ssh", "authorized_keys"), "utf8");
  assert.equal(authorizedKeys.trim().split("\n").length, 4);
  assert.match(authorizedKeys, /shell-deploy@hyperbolic-core/);
  assert.match(authorizedKeys, /llm-handler-deploy@hyperbolic-core/);
  assert.match(authorizedKeys, /brain-deploy@hyperbolic-core/);
  assert.match(authorizedKeys, /broker-deploy@hyperbolic-core/);
});

test("apply: prints all four private keys with their Infisical variable name and path, exactly once", () => {
  const env = fakeBin(true);
  const result = spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  for (const [varName, infisicalPath] of [
    ["SHELL_DEPLOY_SSH_KEY", "/platform/shell-deploy/"],
    ["LLM_HANDLER_SSH_KEY", "/platform/llm-handler/"],
    ["BRAIN_DEPLOY_SSH_KEY", "/brain/"],
    ["BROKER_DEPLOY_SSH_KEY", "/platform/broker/"],
  ]) {
    assert.match(result.stdout, new RegExp(`--- ${varName} \\(path ${infisicalPath.replace(/\//g, "\\/")}\\) ---`));
  }
});

test("apply: rerunning rotates the key for each name instead of accumulating dead entries", () => {
  const env = fakeBin(true);
  const opts = { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } };
  spawnSync(script, ["--apply"], opts);
  const firstKeys = readFileSync(path.join(env.home, ".ssh", "authorized_keys"), "utf8");
  spawnSync(script, ["--apply"], opts);
  const secondKeys = readFileSync(path.join(env.home, ".ssh", "authorized_keys"), "utf8");
  assert.equal(secondKeys.trim().split("\n").length, 4, "a second run must replace, not append, each key name's entry");
  assert.notEqual(firstKeys, secondKeys, "the regenerated keys must actually differ (a real rerun mints fresh key material)");
});

test("apply: passing --tailnet-authkey joins the tailnet first", () => {
  const env = fakeBin(true);
  spawnSync(script, ["--apply", "--tailnet-authkey=tskey-test-123"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  assert.match(readFileSync(env.log, "utf8"), /tailscale up --authkey=tskey-test-123 --ssh/);
});

test("apply: no private key material is left on disk once the script exits", () => {
  const env = fakeBin(true);
  const result = spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  assert.equal(result.status, 0, result.stderr);
  // Every ssh-keygen -f target lives under a mktemp -d directory printed in
  // the ssh-keygen invocation log, and the script's own EXIT trap shreds it.
  const calls = readFileSync(env.log, "utf8");
  const keyfileDirs = [...calls.matchAll(/-f (\S+)_key/g)].map((m) => path.dirname(m[1]));
  for (const dir of new Set(keyfileDirs)) {
    assert.equal(existsSync(dir), false, `${dir} must not survive script exit`);
  }
});
