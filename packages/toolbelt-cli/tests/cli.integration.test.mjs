// Spawns the real executable (bin/tool.mjs, the actual `npm run tool:new`
// entry point) against a disposable fixture toolbelt root via the internal
// --toolbelt-root flag -- proves the process wiring itself (shebang, argv
// parsing, exit codes) works end-to-end, not just the in-process main().
// Also times a real invocation for the 10-second budget
// (docs/planning/05-c-toolbelt.md section 10: "Scaffold CLI end-to-end ...
// <= 10 s").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFixtureToolbeltRoot, rootManifest, snapshotTree } from "./helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "tool.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

test("bin/tool.mjs generates a real tool end-to-end against a fixture root", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const result = runCli(["--toolbelt-root", root, "--id", "spawn-tool", "--name", "Spawn Tool", "--kind", "cli"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(root, "apps", "spawn-tool", "tool.json")));
    assert.match(result.stdout, /generated apps\/toolbelt\/apps\/spawn-tool\//);
  });
});

test("bin/tool.mjs exits 2 for a collision, leaving the fixture tree untouched", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/spawn-tool/tool.json": { id: "spawn-tool" } },
    (root) => {
      const before = snapshotTree(root);
      const result = runCli(["--toolbelt-root", root, "--id", "spawn-tool", "--name", "Spawn Tool", "--kind", "cli"]);
      assert.equal(result.status, 2);
      assert.deepEqual(snapshotTree(root), before);
    },
  );
});

test("bin/tool.mjs --dry-run exits 0 and writes nothing", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const result = runCli([
      "--toolbelt-root",
      root,
      "--id",
      "spawn-dry-tool",
      "--name",
      "Spawn Dry Tool",
      "--kind",
      "cli",
      "--dry-run",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--dry-run: plan/);
    assert.deepEqual(snapshotTree(root), before);
  });
});

test("bin/tool.mjs exits 2 with no output on stdout for an invalid invocation (usage goes to stderr)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const result = runCli(["--toolbelt-root", root]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid arguments/);
  });
});

// docs/planning/05-c-toolbelt.md section 10's latency budget: "Scaffold CLI
// end-to-end (tool:new on a scratch id) <= 10 s". This times the REAL
// subprocess (not the in-process main()), the same shape as the eventual
// `npm run tool:new -- ...` invocation.
test("a real scaffold invocation completes within the 10-second budget", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const startedAt = Date.now();
    const result = runCli([
      "--toolbelt-root",
      root,
      "--id",
      "timing-tool",
      "--name",
      "Timing Tool",
      "--kind",
      "hybrid",
      "--route",
      "/timing-tool",
      "--llm",
    ]);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsedMs < 10000, `tool:new took ${elapsedMs}ms, over the 10s budget`);
  });
});
