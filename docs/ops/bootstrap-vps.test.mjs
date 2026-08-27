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
  // A fake ssh-keygen stays on PATH deliberately, even though the script
  // must never call it anymore (issue #191): if a key-generation step ever
  // sneaks back in, the invocation lands in the log and the keyless
  // negative test below fails on evidence, not on a PATH lookup error.
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
  // Fake docker (issue #187 slice B): `network inspect platform-internal`
  // succeeds only when the test dropped a marker file, so tests can exercise
  // both halves of the idempotent create-if-missing guard.
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >> "${log}"
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then
  [ -e "${root}/platform-internal-exists" ] && exit 0 || exit 1
fi
exit 0
`,
  );
  for (const bin_ of ["id", "useradd", "chown", "tailscale", "ssh-keygen", "docker"]) chmodSync(path.join(bin, bin_), 0o755);
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

test("apply: creates all five target directories deploy workflows expect to own", () => {
  const env = fakeBin(true);
  const result = spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  assert.equal(result.status, 0, result.stderr);
  for (const dir of ["shell", "lifeos-ui", "llm-handler", "brain", "broker"]) {
    assert.ok(existsSync(path.join(env.home, dir)), `${dir} was not created`);
  }
});

test("apply: provisions no SSH key material at all -- keyless Tailscale SSH is the only deploy auth (ADR 008, issue #191)", () => {
  // Before issue #191 this script generated four deploy keypairs, installed
  // their public halves into authorized_keys, and printed the private halves
  // for Infisical. Deploy auth is now the tailnet ACL granting tag:ci SSH to
  // deploy@ -- so a rerun of this script must neither invoke ssh-keygen nor
  // create authorized_keys, and nothing resembling key material may reach
  // stdout. This is the same "no SSH key material" contract
  // deploy-workflow.test.mjs pins on deploy.yml itself.
  const env = fakeBin(true);
  const result = spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(env.log, "utf8"), /ssh-keygen/);
  assert.equal(existsSync(path.join(env.home, ".ssh", "authorized_keys")), false, "no authorized_keys may be created");
  assert.doesNotMatch(result.stdout, /COPY THESE INTO INFISICAL|PRIVATE|SSH_KEY/);
  const scriptSource = readFileSync(script, "utf8");
  assert.doesNotMatch(scriptSource, /ssh-keygen|authorized_keys|SSH_KEY|id_ed25519/);
});

test("apply: creates the shared platform-internal Docker network with --internal when it does not exist (issue #187 slice B)", () => {
  const env = fakeBin(true);
  const result = spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(env.log, "utf8");
  assert.match(log, /docker network inspect platform-internal/);
  assert.match(log, /docker network create --internal platform-internal/);
});

test("apply: an already-existing platform-internal network is left alone (idempotent rerun)", () => {
  const env = fakeBin(true);
  writeFileSync(path.join(env.root, "platform-internal-exists"), "");
  const result = spawnSync(script, ["--apply"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(env.log, "utf8");
  assert.match(log, /docker network inspect platform-internal/);
  assert.doesNotMatch(log, /docker network create/);
});

test("dry run prints the guarded platform-internal network-create plan without executing docker", () => {
  const env = fakeBin(false);
  const result = run(env, "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docker network inspect platform-internal/);
  assert.match(result.stdout, /docker network create --internal platform-internal/);
  assert.doesNotMatch(readFileSync(env.log, "utf8"), /docker/);
});

test("apply: passing --tailnet-authkey joins the tailnet first, with Tailscale SSH enabled on the box", () => {
  const env = fakeBin(true);
  spawnSync(script, ["--apply", "--tailnet-authkey=tskey-test-123"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin`, NODE_TEST_CONTEXT: "child-v8", BOOTSTRAP_VPS_TEST_ROOT: env.home, EUID: "0" } });
  assert.match(readFileSync(env.log, "utf8"), /tailscale up --authkey=tskey-test-123 --ssh/);
});
