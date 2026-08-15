import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "bootstrap-github.sh");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

const REQUIRED_ARGS = [
  "--repo=kgsmith19/hyperbolic-core",
  "--deploy-host=vps.tail.ts.net",
  "--infisical-project-slug=hyperbolic-core",
  "--infisical-shell-deploy-identity=id-shell",
  "--infisical-llm-handler-deploy-identity=id-llm",
  "--infisical-brain-deploy-identity=id-brain",
  "--infisical-platform-migrations-identity=id-migrations",
  "--infisical-platform-backup-identity=id-backup",
  "--platform-age-public-key=age1exampleexampleexample",
];

function fakeGh() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bootstrap-github-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const log = path.join(root, "log.txt");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "gh $*" >> "${log}"\ncase "$1" in api) cat >/dev/null ;; esac\n`);
  chmodSync(path.join(bin, "gh"), 0o755);
  return { bin, log };
}

function run(env, ...args) {
  return spawnSync(script, args, { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin` } });
}

test("dry run is the default and touches nothing", () => {
  const env = fakeGh();
  const a = run(env, ...REQUIRED_ARGS);
  const b = run(env, "--dry-run", ...REQUIRED_ARGS);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.equal(readFileSync(env.log, "utf8"), "", "dry-run must never invoke gh");
});

test("missing required flags fails closed and names every one that's missing", () => {
  const env = fakeGh();
  const result = run(env, "--repo=kgsmith19/hyperbolic-core");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--deploy-host/);
  assert.match(result.stderr, /--platform-age-public-key/);
  assert.equal(readFileSync(env.log, "utf8"), "");
});

test("unknown flag fails closed", () => {
  const env = fakeGh();
  const result = run(env, "--unknown");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test("apply: sets all 8 required repository variables with the exact runbook.md names", () => {
  const env = fakeGh();
  const result = spawnSync(script, ["--apply", ...REQUIRED_ARGS], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin` } });
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(env.log, "utf8");
  for (const name of [
    "DEPLOY_HOST",
    "INFISICAL_PROJECT_SLUG",
    "INFISICAL_SHELL_DEPLOY_IDENTITY_ID",
    "INFISICAL_LLM_HANDLER_DEPLOY_IDENTITY_ID",
    "INFISICAL_BRAIN_DEPLOY_IDENTITY_ID",
    "INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID",
    "INFISICAL_PLATFORM_BACKUP_IDENTITY_ID",
    "PLATFORM_AGE_PUBLIC_KEY",
  ]) {
    assert.match(log, new RegExp(`gh variable set ${name} --repo kgsmith19/hyperbolic-core --body `), `${name} was not set`);
  }
  assert.doesNotMatch(log, /DEPLOY_ENABLED/, "DEPLOY_ENABLED must not be touched without --enable-deploy");
  assert.doesNotMatch(log, /PLATFORM_BACKUP_ENABLED/, "PLATFORM_BACKUP_ENABLED must not be touched without --enable-backup");
  assert.doesNotMatch(log, /branches\/main\/protection/, "branch protection must not be touched without --branch-protection");
});

test("apply: --enable-deploy and --enable-backup are opt-in go-live switches", () => {
  const env = fakeGh();
  spawnSync(script, ["--apply", ...REQUIRED_ARGS, "--enable-deploy", "--enable-backup"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin` } });
  const log = readFileSync(env.log, "utf8");
  assert.match(log, /gh variable set DEPLOY_ENABLED --repo kgsmith19\/hyperbolic-core --body true/);
  assert.match(log, /gh variable set PLATFORM_BACKUP_ENABLED --repo kgsmith19\/hyperbolic-core --body true/);
});

test("apply: --branch-protection requires exactly the three PR Gate checks on main", () => {
  const env = fakeGh();
  const result = spawnSync(script, ["--apply", ...REQUIRED_ARGS, "--branch-protection"], { encoding: "utf8", env: { ...process.env, PATH: `${env.bin}:/usr/bin:/bin` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(env.log, "utf8"), /gh api --method PUT repos\/kgsmith19\/hyperbolic-core\/branches\/main\/protection --input -/);
});

test("dry run with --branch-protection prints the exact JSON body without sending it", () => {
  const env = fakeGh();
  const result = run(env, ...REQUIRED_ARGS, "--branch-protection");
  const body = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.deepEqual(body.required_status_checks.contexts, ["Toolbelt PR Gate", "ACC PR Gate", "Shell PR Gate"]);
  assert.equal(body.required_status_checks.strict, true);
  assert.equal(readFileSync(env.log, "utf8"), "");
});
