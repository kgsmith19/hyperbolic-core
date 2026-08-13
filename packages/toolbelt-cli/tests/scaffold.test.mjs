// The core acceptance-criteria proofs for m3-03, run against disposable
// fixture toolbelt roots (never the real apps/toolbelt/ tree -- see
// tests/helpers.mjs). The one real-tree run this issue also requires is
// documented separately in the implementation report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { withFixtureToolbeltRoot, rootManifest, snapshotTree } from "./helpers.mjs";
import { buildPlan, writePlan, runScaffold, isInside, lockPathFor, acquireLock } from "../src/scaffold.mjs";
import { checkManifestShape } from "../src/manifests-shared.mjs";
import { formatTimestamp, nextTimestamp } from "../src/timestamp.mjs";

function opts(overrides = {}) {
  return {
    id: "scratch-tool",
    name: "Scratch",
    kind: "ui",
    route: "/scratch",
    schema: undefined,
    noSchema: false,
    llm: false,
    dryRun: false,
    ...overrides,
  };
}

function basenameOf(path) {
  return basename(path);
}

// Mirrors src/scaffold.mjs's own internal safeReaddir exactly -- duplicated
// here (not imported; it is not exported) only so the RED test below can
// reconstruct the OLD, pre-fix per-directory-only algorithm for comparison.
function safeReaddirForTest(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// --- buildPlan --------------------------------------------------------

test("buildPlan for a ui tool includes tool.json, AGENTS.md, web/index.html, schema migration pair, test, and registration pair", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const plan = buildPlan(opts(), { toolbeltRoot: root });
    const relPaths = plan.files.map((f) => f.path.slice(root.length + 1));
    assert.ok(relPaths.includes("apps/scratch-tool/tool.json"));
    assert.ok(relPaths.includes("apps/scratch-tool/AGENTS.md"));
    assert.ok(relPaths.includes("apps/scratch-tool/web/index.html"));
    assert.ok(relPaths.some((p) => /^apps\/scratch-tool\/supabase\/migrations\/\d+_scratch_tool_create_schema\.sql$/.test(p)));
    assert.ok(relPaths.some((p) => /^apps\/scratch-tool\/supabase\/migrations\/\d+_scratch_tool_create_schema_down\.sql$/.test(p)));
    assert.ok(relPaths.includes("apps/scratch-tool/tests/registration.test.mjs"));
    assert.ok(relPaths.some((p) => /^supabase\/migrations\/\d+_register_scratch-tool\.sql$/.test(p)));
    assert.ok(relPaths.some((p) => /^supabase\/migrations\/\d+_register_scratch-tool_down\.sql$/.test(p)));
    assert.equal(plan.files.length, 8);
  });
});

test("buildPlan for a cli tool omits web/index.html", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const plan = buildPlan(opts({ kind: "cli", route: undefined }), { toolbeltRoot: root });
    const relPaths = plan.files.map((f) => f.path.slice(root.length + 1));
    assert.ok(!relPaths.some((p) => p.includes("web/")));
  });
});

test("buildPlan for --no-schema omits both schema migration files", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const plan = buildPlan(opts({ kind: "cli", route: undefined, noSchema: true }), { toolbeltRoot: root });
    const relPaths = plan.files.map((f) => f.path.slice(root.length + 1));
    assert.ok(!relPaths.some((p) => p.includes("create_schema")));
    assert.equal(plan.manifest.schemas.length, 0);
  });
});

test("buildPlan never touches the filesystem (dry-run-safe by construction)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    buildPlan(opts(), { toolbeltRoot: root });
    assert.deepEqual(snapshotTree(root), before);
  });
});

test("buildPlan's registration timestamp avoids colliding with an existing migration in the same directory", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "supabase/migrations/README.md": "n/a" },
    (root) => {
      // Pre-seed a migration at "now" so buildPlan is forced to bump past it.
      const now = formatTimestamp(new Date());
      writeFileSync(join(root, "supabase", "migrations", `${now}_register_someone-else.sql`), "-- up\n");
      const plan = buildPlan(opts(), { toolbeltRoot: root });
      const registerFile = plan.files.find((f) => /register_scratch-tool\.sql$/.test(f.path));
      const usedTs = registerFile.path.split("/").pop().split("_")[0];
      assert.notEqual(usedTs, now, "expected the generator to pick a different timestamp than the pre-existing one");
    },
  );
});

// --- Finding 27: global timestamp allocation -------------------------
//
// Independent security review of this repo, re-verified against current
// HEAD: "Registration and schema versions are allocated independently,
// often in the same second. The Intake duplicate is a concrete failure.
// Allocate globally unique ordered versions for every emitted migration and
// concurrent scaffold."

// RED: reconstructs the OLD, pre-fix algorithm exactly (nextTimestamp
// checked ONLY against the one directory about to be written into, called
// independently for the registration timestamp and the schema timestamp)
// against a FIXED clock -- proving the two allocations collide whenever
// they are minted from the same wall-clock second, which is the ordinary
// case (two synchronous statements are always microseconds apart, not
// coincidentally always a full second apart).
test("RED: allocating registration and schema timestamps independently, each checked only against its own directory, collides when minted in the same wall-clock second", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const now = new Date(Date.UTC(2026, 7, 13, 12, 0, 0));
    const registrationDir = join(root, "supabase", "migrations");
    const toolMigrationsDir = join(root, "apps", "scratch-tool", "supabase", "migrations");
    const registerTs = nextTimestamp(safeReaddirForTest(registrationDir), now);
    const schemaTs = nextTimestamp(safeReaddirForTest(toolMigrationsDir), now);
    assert.equal(
      registerTs,
      schemaTs,
      "demonstrates the pre-fix bug shape: two per-directory-only timestamp allocations land on the identical version key",
    );
  });
});

// GREEN: buildPlan's actual, fixed algorithm, against the exact same fixed
// clock and fixture -- the registration and schema timestamps it allocates
// in ONE call must never collide with each other.
test("GREEN: buildPlan allocates a registration timestamp and a schema timestamp that never collide with each other, even when minted in the identical wall-clock second (Finding 27 fix)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const now = new Date(Date.UTC(2026, 7, 13, 12, 0, 0));
    const plan = buildPlan(opts(), { toolbeltRoot: root, now });
    const registerFile = plan.files.find((f) => /register_scratch-tool\.sql$/.test(f.path));
    const schemaFile = plan.files.find((f) => /create_schema\.sql$/.test(f.path));
    assert.ok(registerFile && schemaFile, "test assumes the default ui+schema opts() layout");
    const registerTs = basenameOf(registerFile.path).split("_")[0];
    const schemaTs = basenameOf(schemaFile.path).split("_")[0];
    assert.notEqual(
      registerTs,
      schemaTs,
      "registration and schema timestamps minted in the same buildPlan call must never collide",
    );
  });
});

test("buildPlan's timestamp allocation avoids colliding with a pre-existing migration in a DIFFERENT app's directory sharing the same wall-clock second", () => {
  const now = new Date(Date.UTC(2026, 7, 13, 12, 0, 0));
  const nowTs = formatTimestamp(now);
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "apps/other-tool/tool.json": {
        id: "other-tool",
        name: "Other",
        kind: "cli",
        version: "0.1.0",
        ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt/apps/other-tool" },
        entry: { cli: { command: "true" } },
        schemas: ["other_tool"],
        permissions: { db: { read: [], write: [] }, networkEgress: [], llmHandler: { access: false } },
        lifecycle: { migrate: "supabase db push", health: "true", register: "pending" },
      },
      [`apps/other-tool/supabase/migrations/${nowTs}_other_tool_create_schema.sql`]: "create schema other_tool;",
    },
    (root) => {
      const plan = buildPlan(opts(), { toolbeltRoot: root, now });
      const registerFile = plan.files.find((f) => /register_scratch-tool\.sql$/.test(f.path));
      const schemaFile = plan.files.find((f) => /create_schema\.sql$/.test(f.path));
      const registerTs = basenameOf(registerFile.path).split("_")[0];
      const schemaTs = basenameOf(schemaFile.path).split("_")[0];
      assert.notEqual(registerTs, nowTs, "must not collide with a pre-existing migration in a different app's directory");
      assert.notEqual(schemaTs, nowTs, "must not collide with a pre-existing migration in a different app's directory");
      assert.notEqual(registerTs, schemaTs, "must not collide with each other either");
    },
  );
});

// --- writePlan happy path ------------------------------------------------

test("writePlan writes every planned file with its exact content", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const plan = buildPlan(opts(), { toolbeltRoot: root });
    const written = writePlan(plan);
    assert.equal(written.length, plan.files.length);
    for (const file of plan.files) {
      assert.ok(existsSync(file.path));
    }
  });
});

test("writePlan's output manifest is schema-valid on disk (end-to-end, not just in-memory)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const plan = buildPlan(opts(), { toolbeltRoot: root });
    writePlan(plan);
    const manifestPath = join(root, "apps", "scratch-tool", "tool.json");
    assert.deepEqual(checkManifestShape([manifestPath]), []);
  });
});

// --- runScaffold: collisions, dry-run, success ----------------------------

test("runScaffold returns exitCode 2 and writes nothing when the id already exists on disk", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/scratch-tool/tool.json": { placeholder: true } },
    (root) => {
      const before = snapshotTree(root);
      const result = runScaffold(opts(), { toolbeltRoot: root });
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 2);
      assert.ok(result.reasons.length > 0);
      assert.deepEqual(snapshotTree(root), before, "no partial writes on a collision");
    },
  );
});

test("runScaffold --dry-run writes nothing and reports the plan", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const result = runScaffold(opts(), { toolbeltRoot: root, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.ok(result.plan.files.length > 0);
    assert.deepEqual(snapshotTree(root), before, "dry-run must write nothing");
  });
});

test("runScaffold succeeds and writes exactly the planned files for a clean id", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const result = runScaffold(opts(), { toolbeltRoot: root });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.written.length, result.plan.files.length);
    for (const p of result.written) assert.ok(existsSync(p));
  });
});

// --- writePlan rollback (adversarial: inject a failure partway through) ---

function fsImplThatFailsOnWriteNumber(n) {
  let count = 0;
  return {
    mkdirSync,
    writeFileSync: (path, content) => {
      count += 1;
      if (count === n) {
        throw new Error(`injected failure on write #${count} (${path})`);
      }
      writeFileSync(path, content);
    },
    rmSync,
  };
}

test("writePlan rolls back fully when a failure is injected on the FIRST write (nothing at all lands)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const plan = buildPlan(opts(), { toolbeltRoot: root });
    assert.throws(() => writePlan(plan, { fsImpl: fsImplThatFailsOnWriteNumber(1) }), /injected failure on write #1/);
    assert.deepEqual(snapshotTree(root), before, "a first-write failure must leave the tree exactly as it was");
    assert.equal(existsSync(plan.toolDir), false);
  });
});

test("writePlan rolls back a partially-written new tool directory when a failure is injected mid-way (write #3 of 8)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const plan = buildPlan(opts(), { toolbeltRoot: root });
    assert.equal(plan.files.length, 8, "test assumes the 8-file ui+schema layout; update the failure index if this changes");
    assert.throws(() => writePlan(plan, { fsImpl: fsImplThatFailsOnWriteNumber(3) }), /injected failure on write #3/);
    assert.deepEqual(snapshotTree(root), before, "no file from the new tool directory may remain");
    assert.equal(existsSync(plan.toolDir), false);
  });
});

test("writePlan rolls back a stray file already written into the PRE-EXISTING apps/toolbelt/supabase/migrations/ directory (failure on the LAST write, #8 of 8) without deleting that directory itself", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const plan = buildPlan(opts(), { toolbeltRoot: root });
    assert.equal(plan.files.length, 8);
    // Write #7 is the register-up file, write #8 is the register-down file --
    // both land in the pre-existing supabase/migrations/ directory, outside
    // plan.toolDir. Failing on #8 proves the single already-written stray
    // file (#7) gets individually removed, and that the pre-existing
    // directory itself survives (it holds other real files too, in the real
    // tree).
    assert.throws(() => writePlan(plan, { fsImpl: fsImplThatFailsOnWriteNumber(8) }), /injected failure on write #8/);
    assert.deepEqual(snapshotTree(root), before, "the stray registration file must be removed, and nothing else may change");
    assert.ok(existsSync(join(root, "supabase", "migrations")), "the pre-existing migrations directory itself must survive");
    assert.equal(existsSync(plan.toolDir), false);
  });
});

test("writePlan rolls back on every possible single injected failure point (1..8), each leaving the tree exactly as it started", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    for (let n = 1; n <= 8; n += 1) {
      const plan = buildPlan(opts({ id: `scratch-tool-${n}` }), { toolbeltRoot: root });
      assert.throws(() => writePlan(plan, { fsImpl: fsImplThatFailsOnWriteNumber(n) }));
      assert.deepEqual(snapshotTree(root), before, `tree must be unchanged after a failure injected at write #${n}`);
    }
  });
});

test("runScaffold surfaces the write-phase error (via exception) and the caller (cli.mjs) is expected to report it, not swallow it", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const failingFsImpl = fsImplThatFailsOnWriteNumber(2);
    assert.throws(() => runScaffold(opts(), { toolbeltRoot: root, fsImpl: failingFsImpl }), /injected failure on write #2/);
    // The per-id lock must be released even on this exception path (finally
    // in runScaffold), or the id would be permanently stuck "locked" after
    // any single write failure -- a strictly worse outcome than the bug
    // this fix closes.
    assert.equal(existsSync(lockPathFor(root, "scratch-tool")), false, "the lock must be released even when the write phase throws");
  });
});

// --- Finding 28: TOCTOU/destructive-rollback-under-concurrency fix --------
//
// Independent security review of this repo, re-verified against current
// HEAD: "Collision checks precede truncating writes; rollback recursively
// removes the tool directory. Two same-ID invocations can pass, overwrite
// registration, and one failure can delete the other's completed result.
// Use an exclusive lock, invocation-owned staging, atomic rename, and
// delete only owned paths."

// --- 28a: the exclusive per-id lock itself --------------------------------

test("acquireLock succeeds and creates the lock file when nothing else holds it", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const lockPath = lockPathFor(root, "scratch-tool");
    const lock = acquireLock(lockPath);
    assert.equal(lock.ok, true);
    assert.ok(existsSync(lockPath));
    lock.release();
    assert.equal(existsSync(lockPath), false);
  });
});

test("acquireLock refuses (ok: false) when the lock file already exists, and does not touch it", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const lockPath = lockPathFor(root, "scratch-tool");
    const first = acquireLock(lockPath);
    assert.equal(first.ok, true);
    const second = acquireLock(lockPath);
    assert.equal(second.ok, false);
    assert.ok(existsSync(lockPath), "the first lock holder's lock file must survive a refused second attempt");
    first.release();
  });
});

test("a lock's release() is safe to call more than once", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const lock = acquireLock(lockPathFor(root, "scratch-tool"));
    lock.release();
    assert.doesNotThrow(() => lock.release());
  });
});

// --- 28b: runScaffold's lock lifecycle ------------------------------------

test("runScaffold refuses immediately (locked, exitCode 2) when another invocation's lock is already held for the same id, and writes nothing", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const lock = acquireLock(lockPathFor(root, "scratch-tool")); // simulates a concurrent in-flight invocation
    assert.equal(lock.ok, true);
    const before = snapshotTree(root); // baseline INCLUDES the held lock file
    const result = runScaffold(opts(), { toolbeltRoot: root });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.equal(result.locked, true);
    assert.ok(result.reasons[0].includes("already in progress"));
    assert.deepEqual(snapshotTree(root), before, "a locked-out invocation must write nothing at all, not even a partial plan");
    assert.equal(existsSync(join(root, "apps", "scratch-tool")), false);
    lock.release();
  });
});

test("runScaffold for a DIFFERENT id proceeds without contention while another id's lock is held (per-id, not global)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const lock = acquireLock(lockPathFor(root, "some-other-id"));
    assert.equal(lock.ok, true);
    const result = runScaffold(opts(), { toolbeltRoot: root }); // id: "scratch-tool", unrelated to the locked id
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    lock.release();
  });
});

test("runScaffold releases its lock after a successful real write", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const result = runScaffold(opts(), { toolbeltRoot: root });
    assert.equal(result.ok, true);
    assert.equal(existsSync(lockPathFor(root, "scratch-tool")), false);
  });
});

test("runScaffold releases its lock after a collision (exitCode 2) result", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/scratch-tool/tool.json": { placeholder: true } },
    (root) => {
      const result = runScaffold(opts(), { toolbeltRoot: root });
      assert.equal(result.ok, false);
      assert.equal(existsSync(lockPathFor(root, "scratch-tool")), false);
    },
  );
});

test("runScaffold releases its lock after a --dry-run", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const result = runScaffold(opts(), { toolbeltRoot: root, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(existsSync(lockPathFor(root, "scratch-tool")), false);
  });
});

// --- 28c: invocation-owned staging + atomic reveal, owned-only rollback --
//
// These simulate the TOCTOU race directly at the buildPlan/writePlan level
// (the review's own suggested alternative to spawning real child processes:
// "simulate via careful interleaving of the exported functions in a single
// test if that's more tractable"). tests/cli.integration.test.mjs separately
// proves the same property end-to-end with two REAL concurrent child
// processes.

test("writePlan never deletes a different, already-completed same-id invocation's directory when a second invocation's write fails (Finding 28's core scenario)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const now = new Date(Date.UTC(2026, 7, 13, 12, 0, 0));
    // Both plans are built from the exact same on-disk snapshot (a fixed
    // clock, and NEITHER has written anything yet) -- this is precisely the
    // TOCTOU window Finding 28 describes: two same-id invocations that both
    // observe "nothing exists yet" before either one writes.
    const planA = buildPlan(opts(), { toolbeltRoot: root, now });
    const planB = buildPlan(opts(), { toolbeltRoot: root, now });
    assert.equal(planA.toolDir, planB.toolDir, "test assumes both plans target the identical final directory (same id)");

    const writtenA = writePlan(planA); // the "winner": completes for real
    assert.ok(writtenA.every((p) => existsSync(p)));
    const manifestPathA = join(planA.toolDir, "tool.json");
    const contentAfterA = readFileSync(manifestPathA, "utf8");

    // The "loser": its own plan, built before A wrote anything, now tries
    // to reveal into a path A has already claimed. Its own staging phase
    // succeeds (it never touches A's real files -- separate temp names),
    // but the reveal-phase rename onto the now-non-empty real toolDir fails
    // NATURALLY (Node's own renameSync semantics: ENOTEMPTY), with no
    // injected failure needed.
    assert.throws(() => writePlan(planB), /ENOTEMPTY|EEXIST|ENOTDIR/);

    // The winner's real directory must be completely untouched: same
    // content, nothing deleted, nothing overwritten.
    assert.equal(readFileSync(manifestPathA, "utf8"), contentAfterA, "the winning invocation's tool.json must survive byte-for-byte");
    for (const p of writtenA) {
      assert.ok(existsSync(p), `${p} must still exist after the losing invocation's failed write`);
    }

    // The loser must leave no stray temp artifacts behind either.
    const leftoverTmp = readdirSync(join(root, "apps")).filter((n) => n.includes(".tmp-"));
    assert.deepEqual(leftoverTmp, [], "the losing invocation's staging directory must be fully cleaned up");
    const leftoverRegTmp = readdirSync(join(root, "supabase", "migrations")).filter((n) => n.startsWith(".tmp-"));
    assert.deepEqual(leftoverRegTmp, [], "the losing invocation's temp registration files must be fully cleaned up");
  });
});

test("runScaffold's lock makes the Finding 28 race impossible end-to-end: a second same-id runScaffold call while the first would still be holding its lock is refused, never corrupting or deleting the first's result", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    // Simulates "invocation A is still inside its own check+write sequence"
    // by holding A's lock manually (the same lock runScaffold itself would
    // hold for the whole sequence), then completing A's writes for real,
    // THEN letting a concurrent B arrive while that lock is still held.
    const lockA = acquireLock(lockPathFor(root, "scratch-tool"));
    assert.equal(lockA.ok, true);
    const writtenA = writePlan(buildPlan(opts(), { toolbeltRoot: root }));
    assert.ok(writtenA.every((p) => existsSync(p)));

    const resultB = runScaffold(opts(), { toolbeltRoot: root }); // arrives while A's lock is still held
    assert.equal(resultB.ok, false);
    assert.equal(resultB.locked, true);

    lockA.release();
    for (const p of writtenA) {
      assert.ok(existsSync(p), `${p} (invocation A's real output) must survive invocation B's refused, locked-out attempt`);
    }
  });
});

test("a write-phase failure for one id never touches a different, already-completed id's directory", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const resultA = runScaffold(opts({ id: "tool-aaa" }), { toolbeltRoot: root });
    assert.equal(resultA.ok, true);
    const snapshotAfterA = snapshotTree(root);

    const failingFsImpl = fsImplThatFailsOnWriteNumber(3);
    assert.throws(() => runScaffold(opts({ id: "tool-bbb" }), { toolbeltRoot: root, fsImpl: failingFsImpl }));

    assert.deepEqual(
      snapshotTree(root).filter((p) => p.startsWith("apps/tool-aaa/") || p === "apps/tool-aaa"),
      snapshotAfterA.filter((p) => p.startsWith("apps/tool-aaa/") || p === "apps/tool-aaa"),
      "tool-aaa's completed directory must be completely unaffected by tool-bbb's unrelated write failure",
    );
    assert.equal(existsSync(join(root, "apps", "tool-bbb")), false);
  });
});

// --- isInside helper -------------------------------------------------

test("isInside correctly distinguishes a path inside vs outside a directory", () => {
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/b"), false); // the directory itself is not "inside" itself
  assert.equal(isInside("/a/b", "/a/c"), false);
  assert.equal(isInside("/a/b", "/a/bc"), false); // must not be fooled by a string-prefix match
});
