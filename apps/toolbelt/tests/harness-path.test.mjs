// The shared Postgres harness moved to tests/support/. A stale import fails at load time, and only in CI, so this guard fails the Toolbelt lane locally first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
// Built from two halves so this file cannot match its own search.
const OLD_PATH = "toolbelt/tests/" + "postgres-harness";

test("no tracked file still names the old harness path", () => {
  let hits = "";
  try {
    hits = execFileSync("git", ["grep", "-l", OLD_PATH, "--", ".", ":!docs/archived", ":!**/migrations/**"], { cwd: REPO, encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1) throw error; // git grep exits 1 when nothing matches
  }
  assert.equal(hits, "", `stale harness path in:\n${hits}`);
});
