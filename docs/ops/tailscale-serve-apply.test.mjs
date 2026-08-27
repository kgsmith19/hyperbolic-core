import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "tailscale-serve-apply.sh");
const bash = process.env.BASH_PATH;
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function shellPath(value) {
  if (!bash) return value;
  return value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function commandArgs(args) {
  return bash ? [bash, [script, ...args]] : [script, args];
}

function run(...args) {
  const [command, commandArguments] = commandArgs(args);
  return execFileSync(command, commandArguments, { encoding: "utf8" }).trim();
}

function spawn(args, options = {}) {
  const [command, commandArguments] = commandArgs(args);
  return spawnSync(command, commandArguments, { encoding: "utf8", ...options });
}

function applyFixture({ failHealth = false, healthBody = '{"status":"ok"}' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tailscale-serve-apply-"));
  temporaryDirectories.push(root);
  const bashEnv = path.join(root, "bash-env.sh");
  const log = path.join(root, "tailscale.log");
  writeFileSync(
    bashEnv,
    `tailscale() { printf "%s\\n" "$*" >> "$TAILSCALE_TEST_LOG"; }\n` +
      `curl() { printf '%s' '${healthBody}'; return ${failHealth ? "1" : "0"}; }\n`,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = process.env.PATH ?? process.env.Path ?? "/usr/bin:/bin";
  env.BASH_ENV = shellPath(bashEnv);
  env.TAILSCALE_SERVE_TEST_ROOT = "1";
  env.TAILSCALE_TEST_LOG = shellPath(log);
  const result = spawn(["--apply"], { env });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    // An expected preflight failure occurs before the first tailscale call.
  }
  return { calls, result };
}

test("dry run reports the reset and exact one-root private-origin proxy", () => {
  assert.deepEqual(run("--dry-run").split("\n"), [
    "sudo tailscale serve reset",
    "sudo tailscale serve --bg --yes --https=443 --set-path=/ http://127.0.0.1:8080",
  ]);
});

test("dry run is the default and deterministic", () => {
  assert.equal(run(), run("--dry-run"));
  assert.equal(run(), run());
});

test("unknown and conflicting options fail closed", () => {
  for (const args of [["--unknown"], ["--apply", "--dry-run"]]) {
    const result = spawn(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
  }
});

test("an unhealthy nginx origin prevents every Serve mutation", () => {
  const { calls, result } = applyFixture({ failHealth: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private nginx origin health check failed/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("a different service returning 2xx on port 8080 prevents every Serve mutation", () => {
  const { calls, result } = applyFixture({ healthBody: "not-nginx" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected private nginx origin health response/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("apply preflights, resets the obsolete table, installs one root proxy, and reports status", () => {
  const { calls, result } = applyFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "serve status",
    "serve reset",
    "serve --bg --yes --https=443 --set-path=/ http://127.0.0.1:8080",
    "serve status",
  ]);
});
