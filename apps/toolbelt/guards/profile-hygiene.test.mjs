import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const GUARDS_PATH = "apps/toolbelt/guards";

function git(...args) {
  return spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
}

test("machine profile overlays are ignored while reusable config fixtures remain trackable", () => {
  const profile = git("check-ignore", "--quiet", "--no-index", `${GUARDS_PATH}/config.local-machine.json`);
  const example = git("check-ignore", "--quiet", "--no-index", `${GUARDS_PATH}/config.example.json`);
  const fixture = git("check-ignore", "--quiet", "--no-index", `${GUARDS_PATH}/config.fixture.json`);

  assert.equal(profile.status, 0, "an arbitrary machine profile must be ignored");
  assert.equal(example.status, 1, "config.example.json must remain available to track");
  assert.equal(fixture.status, 1, "config.fixture.json must remain available to track");
});

test("only portable Guards configuration is tracked", () => {
  const tracked = git("ls-files", "--", `${GUARDS_PATH}/config*.json`);

  assert.equal(tracked.status, 0, tracked.stderr);
  assert.deepEqual(tracked.stdout.trim().split(/\r?\n/), [
    `${GUARDS_PATH}/config.example.json`,
    `${GUARDS_PATH}/config.fixture.json`,
    `${GUARDS_PATH}/config.json`,
  ]);
});
