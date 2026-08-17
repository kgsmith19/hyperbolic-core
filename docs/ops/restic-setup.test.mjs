// Tests for restic-setup.sh (issue #164). Real filesystem, faked network
// tools on PATH -- same pattern as bootstrap-vps.test.mjs: this script's
// destructive/idempotent logic gets a real red/green test against a scratch
// filesystem rather than only being exercised for the first time against a
// real Storage Box.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "restic-setup.sh");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function sha256Hex(content) {
  return execFileSync("sha256sum", { input: content }).toString().split(" ")[0];
}

// The fake restic "binary" is a real shell script, not opaque bytes: once
// the install pipeline (curl -> verify -> bzip2 -> mv) puts it in place, the
// script under test invokes it for real (`version`, `cat config`, `init`),
// so it has to actually behave like restic, not just have the right hash.
// `version` reports whatever was "installed"; `cat config` succeeds only for
// repos named in alreadyInitialized; `init` records it.
function resticFakeScript(log, resticState) {
  return `#!/bin/sh
echo "restic $*" >> "${log}"
if [ "$1" = "version" ]; then
  echo "restic 0.18.1 compiled with go1.23"
  exit 0
fi
if [ "$1" = "cat" ] && [ "$2" = "config" ]; then
  repo="\${4##*/}"
  grep -qx "$repo" "${resticState}" && exit 0
  exit 1
fi
if [ "$1" = "init" ]; then
  repo="\${3##*/}"
  echo "$repo" >> "${resticState}"
  exit 0
fi
exit 1
`;
}

/**
 * Sets up a scratch root with faked curl/bzip2/sha256sum/restic on PATH.
 * `mismatch` controls whether the served SHA256SUMS line matches the
 * served archive bytes, to exercise the verification failure path.
 */
function fakeEnv({ mismatch = false, alreadyInstalled = false, alreadyInitialized = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "restic-setup-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const log = path.join(root, "log.txt");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(log, "");

  const resticState = path.join(root, "restic-state.txt");
  writeFileSync(resticState, Object.keys(alreadyInitialized).join("\n"));

  const archiveName = "restic_0.18.1_linux_amd64.bz2";
  const archiveBytes = resticFakeScript(log, resticState);
  const realHash = sha256Hex(archiveBytes);
  const servedHash = mismatch ? "0".repeat(64) : realHash;

  // Fake curl: serves a canned SHA256SUMS + archive from a local fixture dir
  // instead of the network, keyed on the requested URL's basename.
  const fixtures = path.join(root, "fixtures");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(path.join(fixtures, "SHA256SUMS"), `${servedHash}  ${archiveName}\n`);
  writeFileSync(path.join(fixtures, archiveName), archiveBytes);
  writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh
echo "curl $*" >> "${log}"
url=""
out=""
prev=""
for a in "$@"; do
  case "$prev" in --output) out="$a" ;; esac
  prev="$a"
  case "$a" in https://*) url="$a" ;; esac
done
name=$(basename "$url")
cp "${fixtures}/$name" "$out"
`,
  );

  // Real bzip2 is fine to use as-is (the fixture "archive" isn't actually
  // bzip2-compressed, so fake bzip2 too: it just strips the .bz2 suffix,
  // matching what real bzip2 -d -k would produce for a real archive).
  writeFileSync(
    path.join(bin, "bzip2"),
    `#!/bin/sh
echo "bzip2 $*" >> "${log}"
for a in "$@"; do
  case "$a" in
    *.bz2) src="$a" ;;
  esac
done
dst="\${src%.bz2}"
cp "$src" "$dst"
`,
  );

  writeFileSync(path.join(bin, "restic"), archiveBytes);

  for (const tool of ["curl", "bzip2", "restic"]) chmodSync(path.join(bin, tool), 0o755);

  const installDir = path.join(root, "usr-local-bin");
  mkdirSync(installDir, { recursive: true });
  if (alreadyInstalled) {
    writeFileSync(path.join(installDir, "restic"), archiveBytes);
    chmodSync(path.join(installDir, "restic"), 0o755);
  }

  const keyFile = path.join(root, "storagebox-key");
  writeFileSync(keyFile, "fake-private-key");
  chmodSync(keyFile, 0o600);

  return { root, bin, home, log, keyFile, resticState, archiveBytes };
}

function runApply(env, extraArgs = [], extraEnv = {}) {
  return spawnSync(
    "bash",
    [
      script,
      "--apply",
      "--storagebox-host=u123456.your-storagebox.de",
      "--storagebox-user=u123456-sub1",
      `--ssh-key-file=${env.keyFile}`,
      ...extraArgs,
    ],
    {
      env: {
        PATH: `${env.bin}:/usr/bin:/bin`,
        HOME: env.home,
        NODE_TEST_CONTEXT: "1",
        RESTIC_SETUP_TEST_ROOT: env.root,
        RESTIC_PASSWORD: "test-password",
        ...extraEnv,
      },
      encoding: "utf8",
    },
  );
}

test("dry-run (default) prints the plan and touches nothing", () => {
  const result = spawnSync("bash", [script, "--storagebox-host=h", "--storagebox-user=u", "--ssh-key-file=/tmp/k"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\] install_steps/);
  assert.match(result.stdout, /\[dry-run\] write_ssh_config/);
  assert.match(result.stdout, /\[dry-run\] init_one/);
});

test("required flags are enforced", () => {
  const result = spawnSync("bash", [script, "--apply"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--storagebox-host, --storagebox-user, and --ssh-key-file are all required/);
});

test("a matching checksum installs restic and both repos initialize", () => {
  const env = fakeEnv();
  const result = runApply(env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const installed = readFileSync(path.join(env.root, "usr-local-bin", "restic"), "utf8");
  assert.equal(installed, env.archiveBytes);
  const state = readFileSync(env.resticState, "utf8").trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(state, ["lifeos", "platform"]);
});

test("a checksum mismatch fails closed and never installs the binary", () => {
  // This is the test that proves the verification step is not a no-op: an
  // archive whose bytes don't match its own manifest entry must halt the
  // script before anything touches /usr/local/bin.
  const env = fakeEnv({ mismatch: true });
  const result = runApply(env);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(env.root, "usr-local-bin", "restic")) &&
    readFileSync(path.join(env.root, "usr-local-bin", "restic"), "utf8") === env.archiveBytes, false);
});

test("an already-installed matching version skips the download entirely", () => {
  const env = fakeEnv({ alreadyInstalled: true });
  const result = runApply(env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /already installed .* skipping install/);
  const log = readFileSync(env.log, "utf8");
  assert.doesNotMatch(log, /curl/);
});

test("an already-initialized repository is skipped, not re-initialized", () => {
  const env = fakeEnv({ alreadyInitialized: { platform: true } });
  const result = runApply(env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /repository 'platform' already initialized/);
  assert.match(result.stdout, /initialized restic repository 'lifeos'/);
});

test("RESTIC_PASSWORD is required before any repository init runs", () => {
  const env = fakeEnv();
  const result = runApply(env, [], { RESTIC_PASSWORD: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESTIC_PASSWORD must be set/);
});

test("the SSH config alias is idempotent: re-running replaces, never duplicates, the block", () => {
  const env = fakeEnv();
  runApply(env);
  const first = readFileSync(path.join(env.root, "ssh", "config"), "utf8");
  assert.equal((first.match(/Host hetzner-storagebox/g) ?? []).length, 1);
  assert.match(first, /Port 23/);
  assert.match(first, /HostName u123456\.your-storagebox\.de/);

  runApply(env, ["--storagebox-host=u999999.your-storagebox.de"]);
  const second = readFileSync(path.join(env.root, "ssh", "config"), "utf8");
  assert.equal((second.match(/Host hetzner-storagebox/g) ?? []).length, 1);
  assert.match(second, /HostName u999999\.your-storagebox\.de/);
  assert.doesNotMatch(second, /u123456\.your-storagebox\.de/);
});

test("the ssh config file and directory are created owner-only", () => {
  const env = fakeEnv();
  runApply(env);
  const configPath = path.join(env.root, "ssh", "config");
  const configDir = path.join(env.root, "ssh");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(configDir).mode & 0o777, 0o700);
});

test("a custom --repos list is honored instead of the platform,lifeos default", () => {
  const env = fakeEnv();
  const result = runApply(env, ["--repos=solo"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const state = readFileSync(env.resticState, "utf8").trim().split("\n").filter(Boolean);
  assert.deepEqual(state, ["solo"]);
});
