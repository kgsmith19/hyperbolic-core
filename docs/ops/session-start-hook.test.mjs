// .claude/hooks/session-start.sh (#438): the cloud SessionStart adapter.
// Runs the real hook against a throwaway project with a recording fake `npm`
// and a local fake agent-extensions upstream, so every branch is exercised
// without network access or touching this checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hook = path.join(repoRoot, ".claude", "hooks", "session-start.sh");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(result.status, 0, result.stderr);
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "session-start-hook-"));
  temporaryDirectories.push(root);
  const log = path.join(root, "log.txt");
  writeFileSync(log, "");

  // Project under test: the real hook plus a lockfile.
  const project = path.join(root, "project");
  mkdirSync(path.join(project, ".claude", "hooks"), { recursive: true });
  copyFileSync(hook, path.join(project, ".claude", "hooks", "session-start.sh"));
  writeFileSync(path.join(project, "package-lock.json"), '{"lockfileVersion":3}\n');

  // Fake agent-extensions upstream whose session-start.sh records its call.
  const upstream = path.join(root, "upstream");
  mkdirSync(path.join(upstream, "bootstrap"), { recursive: true });
  writeFileSync(
    path.join(upstream, "bootstrap", "session-start.sh"),
    `#!/usr/bin/env bash\necho "session-start $*" >> "${log}"\necho "provision: present"\n`,
  );
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "init");

  // Recording fake npm: `npm ci` logs and creates node_modules.
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "${log}"\nmkdir -p node_modules\n`);
  chmodSync(path.join(bin, "npm"), 0o755);

  return { root, log, project, upstream, bin, home: path.join(root, "home") };
}

// A PATH holding every system tool except the named ones, plus `node`.
function pathWithout(fx, excluded) {
  const dir = path.join(fx.root, "restricted-bin");
  if (existsSync(dir)) return dir;
  mkdirSync(dir);
  for (const source of ["/usr/local/bin", "/usr/bin", "/bin"]) {
    if (!existsSync(source)) continue;
    for (const name of readdirSync(source)) {
      if (excluded.includes(name) || existsSync(path.join(dir, name))) continue;
      symlinkSync(path.join(source, name), path.join(dir, name));
    }
  }
  if (!existsSync(path.join(dir, "node"))) symlinkSync(process.execPath, path.join(dir, "node"));
  return dir;
}

function run(fx, { remote = true, extUrl, systemPath = process.env.PATH } = {}) {
  mkdirSync(fx.home, { recursive: true });
  const envFile = path.join(fx.root, "claude.env");
  const env = {
    PATH: `${fx.bin}:${systemPath}`,
    HOME: fx.home,
    CLAUDE_PROJECT_DIR: fx.project,
    CLAUDE_ENV_FILE: envFile,
    AGENT_EXTENSIONS_REPO_URL: extUrl ?? `file://${fx.upstream}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  if (remote) env.CLAUDE_CODE_REMOTE = "true";
  const result = spawnSync("bash", [path.join(fx.project, ".claude", "hooks", "session-start.sh")], { env, encoding: "utf8" });
  return { ...result, output: result.stdout + result.stderr, calls: readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean) };
}

test("outside cloud sessions the hook is a silent no-op", () => {
  const fx = fixture();
  const result = run(fx, { remote: false });
  assert.equal(result.status, 0);
  assert.equal(result.output, "");
  assert.deepEqual(result.calls, []);
});

test("a fresh cloud session clones extensions, runs session-start with the env file, then npm ci once", () => {
  const fx = fixture();
  const result = run(fx);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /extensions: ok \(cloned to /);
  assert.match(result.output, /deps: ok \(npm ci\)/);
  assert.deepEqual(result.calls, [
    `session-start --env-file ${path.join(fx.root, "claude.env")}`,
    "npm ci --no-audit --no-fund --loglevel=error",
  ]);
});

test("a second session skips npm ci while node_modules matches the lockfile", () => {
  const fx = fixture();
  run(fx);
  const second = run(fx);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /deps: present \(node_modules matches package-lock.json\)/);
  assert.equal(second.calls.filter((c) => c.startsWith("npm ")).length, 1);
});

test("a changed lockfile re-runs npm ci", () => {
  const fx = fixture();
  run(fx);
  writeFileSync(path.join(fx.project, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
  const second = run(fx);
  assert.match(second.output, /deps: ok \(npm ci\)/);
  assert.equal(second.calls.filter((c) => c.startsWith("npm ")).length, 2);
});

test("without sha256sum on PATH the lockfile stamp still prevents a repeat npm ci", () => {
  const fx = fixture();
  const systemPath = pathWithout(fx, ["sha256sum", "shasum", "openssl"]);
  const first = run(fx, { systemPath });
  assert.match(first.output, /deps: ok \(npm ci\)/, first.output);
  const second = run(fx, { systemPath });
  assert.match(second.output, /deps: present/, second.output);
  assert.equal(second.calls.filter((c) => c.startsWith("npm ")).length, 1);
});

test("an unreachable extensions remote degrades but never fails the session", () => {
  const fx = fixture();
  const result = run(fx, { extUrl: `file://${path.join(fx.root, "missing")}` });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /extensions: degraded/);
  assert.match(result.output, /session-start: degraded/);
  assert.match(result.output, /deps: ok \(npm ci\)/);
});

test("the hook leaves the lockfile byte-identical", () => {
  const fx = fixture();
  const lock = path.join(fx.project, "package-lock.json");
  const before = readFileSync(lock);
  run(fx);
  run(fx);
  assert.deepEqual(readFileSync(lock), before);
});
