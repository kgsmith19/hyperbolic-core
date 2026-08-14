// Spawns the real executable (bin/tool.mjs, the actual `npm run tool:new`
// entry point) against a disposable fixture toolbelt root via the internal
// --toolbelt-root flag -- proves the process wiring itself (shebang, argv
// parsing, exit codes) works end-to-end, not just the in-process main().
// Also times a real invocation for the 10-second budget
// (docs/planning/05-c-toolbelt.md section 10: "Scaffold CLI end-to-end ...
// <= 10 s").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFixtureToolbeltRoot, rootManifest, snapshotTree } from "./helpers.mjs";
import { checkRegistryParity, findManifestPaths } from "../../../apps/toolbelt/scripts/validate-manifests.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "tool.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

// Like helpers.mjs's withFixtureToolbeltRoot, but awaits an ASYNC fn before
// cleanup runs. helpers.mjs's own version does `return fn(dir)` inside a
// try/finally -- fine for every other test in this package, whose fn bodies
// are entirely synchronous, but wrong for the two real-concurrency tests
// below: their fn returns a pending Promise (the spawned child processes
// are still racing), and a bare try/finally's `finally` fires as soon as
// the synchronous `return fn(dir)` statement completes, NOT once that
// Promise settles -- it would rmSync the fixture root out from under the
// still-running child processes. Kept local to this file rather than
// changing the shared helper (used by every other test file's entirely
// synchronous fn bodies, where this distinction never matters).
async function withFixtureToolbeltRootAsync(layout, fn) {
  const dir = mkdtempSync(join(tmpdir(), "toolbelt-cli-fixture-async-"));
  try {
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    for (const [relPath, contents] of Object.entries(layout)) {
      const fullPath = join(dir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
    }
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Like runCli, but asynchronous (spawn, not spawnSync) -- required so two
// invocations can be started back-to-back and actually overlap in wall-clock
// time, which is the only way to exercise a REAL cross-process race rather
// than a simulated one. Resolves once the child has exited.
function runCliAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("bin/tool.mjs generates a real tool end-to-end against a fixture root", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const result = runCli(["--toolbelt-root", root, "--id", "spawn-tool", "--name", "Spawn Tool", "--kind", "cli"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(root, "apps", "spawn-tool", "tool.json")));
    assert.match(result.stdout, /generated apps\/toolbelt\/apps\/spawn-tool\//);
  });
});

// Real-world regression: 156 unit tests in this package all passed while
// buildRegistrationUpSql generated a migration shape (`do $tool_new$ ...
// on conflict (id) do nothing ... raise exception` in a PL/pgSQL block)
// that apps/toolbelt/scripts/validate-manifests.mjs's own checkRegistryParity
// rejects outright ("registration is not an idempotent ON CONFLICT (id)
// upsert") -- because no test in this package had ever actually run that
// validator against the CLI's own generated output. This closes exactly
// that gap: a real scaffold, checked against the SAME validator CI runs.
test("a freshly scaffolded tool's registration migration passes the real checkRegistryParity validator CI actually runs", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const result = runCli(["--toolbelt-root", root, "--id", "parity-tool", "--name", "Parity Tool", "--kind", "cli"]);
    assert.equal(result.status, 0, result.stderr);

    const manifestPath = join(root, "apps", "parity-tool", "tool.json");
    assert.ok(existsSync(manifestPath));

    const failures = checkRegistryParity(findManifestPaths(root, { servicesRoot: undefined }), { root });
    assert.deepEqual(
      failures.filter((f) => f.includes("parity-tool")),
      [],
      `expected zero registry-parity failures for the freshly scaffolded tool, got: ${JSON.stringify(failures, null, 2)}`,
    );
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

// --- Finding 28: real concurrent same-id invocations ----------------------
//
// Independent security review of this repo, re-verified against current
// HEAD: "Two same-ID invocations can pass, overwrite registration, and one
// failure can delete the other's completed result." tests/scaffold.test.mjs
// already proves this via careful interleaving of the exported functions;
// this is the review's own preferred, strongest proof -- two REAL child
// processes, actually racing in wall-clock time via `spawn` (not
// `spawnSync`, which would serialize them by construction and prove
// nothing about concurrency at all).
test("two REAL concurrent child processes racing for the SAME id: exactly one completes, the other is cleanly refused (locked), and the winner's output is fully intact", async () => {
  await withFixtureToolbeltRootAsync({ "tool.json": rootManifest() }, async (root) => {
    const args = ["--toolbelt-root", root, "--id", "race-tool", "--name", "Race Tool", "--kind", "cli"];
    const [first, second] = await Promise.all([runCliAsync(args), runCliAsync(args)]);

    const results = [first, second];
    const succeeded = results.filter((r) => r.status === 0);
    const refused = results.filter((r) => r.status !== 0);

    assert.equal(succeeded.length, 1, `expected exactly one winner, got statuses: ${results.map((r) => r.status)}`);
    assert.equal(refused.length, 1);
    assert.match(refused[0].stderr, /already in progress|lock/i, `expected the loser to report lock contention, got: ${refused[0].stderr}`);

    // The winner's real output must be complete and valid -- not partially
    // written, not corrupted by the loser ever having touched it.
    assert.ok(existsSync(join(root, "apps", "race-tool", "tool.json")));
    const manifest = JSON.parse(readFileSync(join(root, "apps", "race-tool", "tool.json"), "utf8"));
    assert.equal(manifest.id, "race-tool");
    assert.ok(existsSync(join(root, "apps", "race-tool", "AGENTS.md")));
    assert.ok(existsSync(join(root, "apps", "race-tool", "tests", "registration.test.mjs")));

    // No stray lock file or temp artifact should survive either outcome.
    assert.equal(existsSync(join(root, "apps", "race-tool.lock")), false);
  });
});

test("two REAL concurrent child processes for DIFFERENT ids both succeed without contention (the lock is per-id, not global)", async () => {
  await withFixtureToolbeltRootAsync({ "tool.json": rootManifest() }, async (root) => {
    const [a, b] = await Promise.all([
      runCliAsync(["--toolbelt-root", root, "--id", "race-tool-a", "--name", "Race Tool A", "--kind", "cli"]),
      runCliAsync(["--toolbelt-root", root, "--id", "race-tool-b", "--name", "Race Tool B", "--kind", "cli"]),
    ]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.ok(existsSync(join(root, "apps", "race-tool-a", "tool.json")));
    assert.ok(existsSync(join(root, "apps", "race-tool-b", "tool.json")));
  });
});
