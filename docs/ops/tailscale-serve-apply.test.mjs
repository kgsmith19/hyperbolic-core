import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "tailscale-serve-apply.sh");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function run(...args) {
  return execFileSync(script, args, { encoding: "utf8" }).trim();
}

function applyFixture(lifeIndex) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tailscale-serve-apply-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const deploy = path.join(root, "deploy");
  const log = path.join(root, "tailscale.log");
  mkdirSync(path.join(deploy, "shell", "current"), { recursive: true });
  mkdirSync(path.join(deploy, "lifeos-ui", "current"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(deploy, "shell", "current", "healthz"), '{"status":"ok"}\n');
  writeFileSync(path.join(deploy, "lifeos-ui", "current", "index.html"), lifeIndex);
  writeFileSync(path.join(bin, "tailscale"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TAILSCALE_TEST_LOG"\n');
  writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "tailscale"), 0o755);
  chmodSync(path.join(bin, "curl"), 0o755);
  const result = spawnSync(script, ["--apply"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: "child-v8",
      PATH: `${bin}:/usr/bin:/bin`,
      TAILSCALE_SERVE_TEST_ROOT: deploy,
      TAILSCALE_TEST_LOG: log,
    },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    // A preflight failure before the first tailscale call intentionally leaves no log.
  }
  return { calls, result };
}

test("dry run emits the exact five fixed, private-origin routes", () => {
  assert.deepEqual(run("--dry-run").split("\n"), [
    "tailscale serve --bg --yes --https=443 --set-path=/ /home/deploy/shell/current",
    "tailscale serve --bg --yes --https=443 --set-path=/life/ /home/deploy/lifeos-ui/current",
    "tailscale serve --bg --yes --https=443 --set-path=/life/api/ http://127.0.0.1:8000",
    "tailscale serve --bg --yes --https=443 --set-path=/api/ http://127.0.0.1:8200",
    "tailscale serve --bg --yes --https=443 --set-path=/api/brain/ http://127.0.0.1:8100",
  ]);
});

test("dry run is the default and is deterministic", () => {
  assert.equal(run(), run("--dry-run"));
  assert.equal(run(), run());
});

test("unknown and conflicting options fail closed", () => {
  for (const args of [["--unknown"], ["--apply", "--dry-run"]]) {
    const result = spawnSync(script, args, { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
  }
});

test("apply fails before mutation when tailscale is unavailable", () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), "tailscale-serve-test-"));
  temporaryDirectories.push(bin);
  symlinkSync("/bin/bash", path.join(bin, "bash"));
  const result = spawnSync(script, ["--apply"], {
    encoding: "utf8",
    env: { PATH: bin },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tailscale is not installed/);
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("apply rejects a LifeOS bundle that was not built for /life/ before mutation", () => {
  const { calls, result } = applyFixture('<script src="/assets/app.js"></script>');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not built for the \/life\/ base path/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("apply refuses before mutation when Handler A's healthz is unreachable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tailscale-serve-apply-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const deploy = path.join(root, "deploy");
  mkdirSync(path.join(deploy, "shell", "current"), { recursive: true });
  mkdirSync(path.join(deploy, "lifeos-ui", "current"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(deploy, "shell", "current", "healthz"), '{"status":"ok"}\n');
  writeFileSync(path.join(deploy, "lifeos-ui", "current", "index.html"), '<script src="/life/assets/app.js"></script>');
  writeFileSync(path.join(bin, "tailscale"), '#!/bin/sh\nexit 0\n');
  // Every OTHER curl call (LifeOS API's own healthz) must keep succeeding;
  // only the Handler A port (8200) fails, isolating this preflight check.
  writeFileSync(path.join(bin, "curl"), '#!/bin/sh\ncase "$*" in *:8200/*) exit 1 ;; esac\nexit 0\n');
  chmodSync(path.join(bin, "tailscale"), 0o755);
  chmodSync(path.join(bin, "curl"), 0o755);
  const result = spawnSync(script, ["--apply"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: "child-v8",
      PATH: `${bin}:/usr/bin:/bin`,
      TAILSCALE_SERVE_TEST_ROOT: deploy,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Handler A health check failed/);
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("apply refuses before mutation when the Brain's healthz is unreachable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tailscale-serve-apply-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const deploy = path.join(root, "deploy");
  mkdirSync(path.join(deploy, "shell", "current"), { recursive: true });
  mkdirSync(path.join(deploy, "lifeos-ui", "current"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(deploy, "shell", "current", "healthz"), '{"status":"ok"}\n');
  writeFileSync(path.join(deploy, "lifeos-ui", "current", "index.html"), '<script src="/life/assets/app.js"></script>');
  writeFileSync(path.join(bin, "tailscale"), '#!/bin/sh\nexit 0\n');
  // Every OTHER curl call (LifeOS API, Handler A) must keep succeeding;
  // only the Brain port (8100) fails, isolating this preflight check.
  writeFileSync(path.join(bin, "curl"), '#!/bin/sh\ncase "$*" in *:8100/*) exit 1 ;; esac\nexit 0\n');
  chmodSync(path.join(bin, "tailscale"), 0o755);
  chmodSync(path.join(bin, "curl"), 0o755);
  const result = spawnSync(script, ["--apply"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: "child-v8",
      PATH: `${bin}:/usr/bin:/bin`,
      TAILSCALE_SERVE_TEST_ROOT: deploy,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Brain health check failed/);
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("apply preflights, applies exactly five routes, and reports final status", () => {
  const { calls, result } = applyFixture('<script src="/life/assets/app.js"></script>');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map((call) => call.replace(/\/tmp\/tailscale-serve-apply-[^/]+\/deploy/g, "/home/deploy")), [
    "serve status",
    "serve --bg --yes --https=443 --set-path=/ /home/deploy/shell/current",
    "serve --bg --yes --https=443 --set-path=/life/ /home/deploy/lifeos-ui/current",
    "serve --bg --yes --https=443 --set-path=/life/api/ http://127.0.0.1:8000",
    "serve --bg --yes --https=443 --set-path=/api/ http://127.0.0.1:8200",
    "serve --bg --yes --https=443 --set-path=/api/brain/ http://127.0.0.1:8100",
    "serve status",
  ]);
});
