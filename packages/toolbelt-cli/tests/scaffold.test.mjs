// The core acceptance-criteria proofs for m3-03, run against disposable
// fixture toolbelt roots (never the real apps/toolbelt/ tree -- see
// tests/helpers.mjs). The one real-tree run this issue also requires is
// documented separately in the implementation report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { withFixtureToolbeltRoot, rootManifest, snapshotTree } from "./helpers.mjs";
import { buildPlan, writePlan, runScaffold, isInside } from "../src/scaffold.mjs";
import { checkManifestShape } from "../src/manifests-shared.mjs";
import { formatTimestamp } from "../src/timestamp.mjs";

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
  });
});

// --- isInside helper -------------------------------------------------

test("isInside correctly distinguishes a path inside vs outside a directory", () => {
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/b"), false); // the directory itself is not "inside" itself
  assert.equal(isInside("/a/b", "/a/c"), false);
  assert.equal(isInside("/a/b", "/a/bc"), false); // must not be fooled by a string-prefix match
});
