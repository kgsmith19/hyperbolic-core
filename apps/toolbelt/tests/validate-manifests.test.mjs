import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  TOOLBELT_ROOT,
  SCHEMA_PATH,
  findManifestPaths,
  checkManifestShape,
  checkSchemaOwnershipUniqueness,
  validateAll,
  canonicalize,
  canonicalJSON,
  manifestHash,
} from "../scripts/validate-manifests.mjs";

const VALIDATOR_CLI = join(TOOLBELT_ROOT, "scripts", "validate-manifests.mjs");

function baseManifest(overrides = {}) {
  return {
    id: "sample-tool",
    name: "Sample Tool",
    kind: "cli",
    version: "0.1.0",
    ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt/apps/sample-tool" },
    entry: { cli: { command: "python3 -m sample_tool" } },
    schemas: [],
    permissions: {
      db: { read: [], write: [] },
      networkEgress: [],
      llmHandler: { access: false },
    },
    lifecycle: { migrate: "supabase db push", health: "python3 -m sample_tool --health", register: "pending" },
    ...overrides,
  };
}

// Mirrors the real apps/toolbelt/tool.json this issue authors (see the m3-01
// report for the reasoning behind each judgment-call field).
function rootManifest(overrides = {}) {
  return baseManifest({
    id: "toolbelt",
    name: "Toolbelt Root Spine",
    kind: "headless",
    ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt" },
    entry: { headless: { command: "select core.purge_old_events();", schedule: "0 3 * * *" } },
    schemas: ["core", "idea"],
    permissions: {
      db: { read: ["core", "idea"], write: ["core", "idea"] },
      networkEgress: [],
      llmHandler: { access: false },
    },
    lifecycle: { migrate: "gh workflow run platform-migrations.yml", health: "node --test", register: "pending" },
    ...overrides,
  });
}

// layout: { "tool.json": {...}, "apps/tool-a/tool.json": {...}, ... } ->
// materializes a scratch toolbelt-root tree and hands its path to fn.
function withFixtureRoot(layout, fn) {
  const dir = mkdtempSync(join(tmpdir(), "toolbelt-manifest-fixture-"));
  try {
    for (const [relPath, contents] of Object.entries(layout)) {
      const fullPath = join(dir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [VALIDATOR_CLI, ...args], { encoding: "utf8" });
}

function registrationMigration(
  manifest,
  hash,
  { registeredId = manifest.id, embeddedManifest = manifest } = {},
) {
  const sqlManifest = JSON.stringify(embeddedManifest).replaceAll("'", "''");
  return `
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  '${registeredId}',
  '${manifest.name}',
  'core',
  'building',
  '${manifest.kind}',
  null,
  '${manifest.version}',
  null,
  '${sqlManifest}'::jsonb,
  '${hash}',
  now()
)
on conflict (id) do update set
  manifest = excluded.manifest,
  manifest_hash = excluded.manifest_hash;
`;
}

// --- findManifestPaths ------------------------------------------------

test("findManifestPaths finds the root manifest plus each apps/*/tool.json", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a" }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b" }),
    },
    (dir) => {
      const paths = findManifestPaths(dir);
      assert.equal(paths.length, 3);
      assert.ok(paths.every((p) => p.endsWith("tool.json")));
    },
  );
});

test("findManifestPaths tolerates a missing apps/ directory", () => {
  withFixtureRoot({ "tool.json": rootManifest() }, (dir) => {
    assert.equal(findManifestPaths(dir).length, 1);
  });
});

test("findManifestPaths ignores an apps/<id> directory with no tool.json", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a" }),
      "apps/no-manifest/README.md": "nothing to see here",
    },
    (dir) => {
      assert.equal(findManifestPaths(dir).length, 2);
    },
  );
});

test("CLI rejects a toolbelt tree whose root spine manifest is missing", () => {
  withFixtureRoot({ "apps/tool-a/tool.json": baseManifest({ id: "tool-a" }) }, (dir) => {
    const result = runCli(["--root", dir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /root spine manifest .*tool\.json is missing/);
  });
});

test("CLI rejects an app directory that has no tool.json", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/no-manifest/README.md": "this app is missing its manifest",
    },
    (dir) => {
      const result = runCli(["--root", dir]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /apps[/\\]no-manifest: missing tool\.json/);
    },
  );
});

test("CLI rejects duplicate manifest ids that would target the same registry row", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "duplicate-tool" }),
      "apps/tool-b/tool.json": baseManifest({ id: "duplicate-tool" }),
    },
    (dir) => {
      const result = runCli(["--root", dir]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /manifest id "duplicate-tool" is declared by 2 manifests/);
      assert.match(result.stderr, /tool-a[/\\]tool\.json/);
      assert.match(result.stderr, /tool-b[/\\]tool\.json/);
    },
  );
});

// --- checkManifestShape (TB-1a) ----------------------------------------

test("checkManifestShape passes a conforming manifest", () => {
  withFixtureRoot({ "tool.json": rootManifest() }, (dir) => {
    assert.deepEqual(checkManifestShape(findManifestPaths(dir)), []);
  });
});

test("checkManifestShape rejects a manifest with a bad id pattern", () => {
  withFixtureRoot({ "tool.json": rootManifest({ id: "Not-Valid!" }) }, (dir) => {
    const failures = checkManifestShape(findManifestPaths(dir));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /\/id must match pattern/);
  });
});

test("checkManifestShape rejects a manifest whose ownership.owner is not the fixed const", () => {
  withFixtureRoot(
    { "tool.json": rootManifest({ ownership: { owner: "someone-else@example.com", path: "apps/toolbelt" } }) },
    (dir) => {
      const failures = checkManifestShape(findManifestPaths(dir));
      assert.equal(failures.length, 1);
      assert.match(failures[0], /ownership\/owner must be equal to constant/);
    },
  );
});

test("checkManifestShape rejects an invalid networkEgress hostname", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest({
        permissions: {
          db: { read: [], write: [] },
          networkEgress: ["not_a_valid_host!!"],
          llmHandler: { access: false },
        },
      }),
    },
    (dir) => {
      const failures = checkManifestShape(findManifestPaths(dir));
      assert.equal(failures.length, 1);
      assert.match(failures[0], /networkEgress\/0 must match format "hostname"/);
    },
  );
});

test("checkManifestShape reports malformed JSON with a clear message instead of throwing", () => {
  withFixtureRoot({ "tool.json": "{ not json" }, (dir) => {
    const failures = checkManifestShape(findManifestPaths(dir));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /invalid JSON/);
  });
});

// --- checkSchemaOwnershipUniqueness (TB-5) ------------------------------

test("checkSchemaOwnershipUniqueness passes when no two manifests share a schema", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a", schemas: ["alpha"] }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b", schemas: ["beta"] }),
    },
    (dir) => {
      const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
        rootManifestPath: join(dir, "tool.json"),
      });
      assert.deepEqual(failures, []);
    },
  );
});

test("checkSchemaOwnershipUniqueness allows the root spine to own core and idea together", () => {
  withFixtureRoot({ "tool.json": rootManifest() }, (dir) => {
    const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
      rootManifestPath: join(dir, "tool.json"),
    });
    assert.deepEqual(failures, []);
  });
});

test("checkSchemaOwnershipUniqueness (TB-5) fails when two manifests declare the same schema, naming both files", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a", schemas: ["widget"] }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b", schemas: ["widget"] }),
    },
    (dir) => {
      const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
        rootManifestPath: join(dir, "tool.json"),
      });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /schema "widget" is claimed by 2 manifests/);
      assert.match(failures[0], /tool-a[/\\]tool\.json/);
      assert.match(failures[0], /tool-b[/\\]tool\.json/);
    },
  );
});

test("checkSchemaOwnershipUniqueness does not let a non-root manifest ride the root's core/idea exception", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/rogue-tool/tool.json": baseManifest({ id: "rogue-tool", schemas: ["core"] }),
    },
    (dir) => {
      const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
        rootManifestPath: join(dir, "tool.json"),
      });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /schema "core" is claimed by 2 manifests/);
    },
  );
});

// Regression test for a mutation-testing finding (M3): two non-root
// manifests colluding on an exception-eligible schema name ("core"/"idea"),
// with no root manifest present in this fixture at all. A prior
// implementation computed the root exception by filtering owners down to
// "paths that are NOT root" -- proven correct here -- but a single-character
// inversion of that filter (accidentally counting "paths that ARE root"
// instead) silently exempted this exact scenario, because with no root
// manifest present, "zero root-owners" was indistinguishable from "zero
// non-root owners." checkSchemaOwnershipUniqueness no longer special-cases
// root at all (see its own comment), which closes this by construction: any
// 2+ claimants of one schema name are always a collision, full stop.
test("checkSchemaOwnershipUniqueness rejects two non-root manifests colluding on an exception-eligible schema name", () => {
  withFixtureRoot(
    {
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a", schemas: ["core"] }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b", schemas: ["core"] }),
    },
    (dir) => {
      const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
        rootManifestPath: join(dir, "tool.json"), // deliberately does not exist in this fixture
      });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /schema "core" is claimed by 2 manifests/);
      assert.match(failures[0], /tool-a[/\\]tool\.json/);
      assert.match(failures[0], /tool-b[/\\]tool\.json/);
    },
  );
});

// Regression test for a mutation-testing finding (M6): checkSchemaOwnershipUniqueness
// is exported and callable directly (as this suite itself does throughout),
// independent of checkManifestShape. Its `Array.isArray(manifest.schemas)`
// guard exists specifically so a malformed `schemas` field can never reach
// the `for...of` loop below unguarded -- replacing the guard with a bare
// truthiness check (`manifest.schemas || []`) still passed every other test
// in this file, because none of them call this function directly with a
// non-array `schemas`. A non-array, non-iterable value (e.g. a plain object)
// would throw `TypeError: ... is not iterable` and crash the whole
// validateAll/CLI run instead of being cleanly ignored here (checkManifestShape
// separately reports it as a shape failure).
test("checkSchemaOwnershipUniqueness does not throw when a manifest's schemas field is a non-array object", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/malformed-tool/tool.json": baseManifest({ id: "malformed-tool", schemas: { not: "an array" } }),
    },
    (dir) => {
      assert.doesNotThrow(() => {
        const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
          rootManifestPath: join(dir, "tool.json"),
        });
        // The malformed manifest contributes no schema claims -- it neither
        // collides with root's core/idea nor introduces a phantom owner.
        assert.deepEqual(failures, []);
      });
    },
  );
});

// --- semantic database permissions (TB-5) -------------------------------

test("CLI rejects a database write permission for a schema owned by another manifest", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({
        id: "tool-a",
        schemas: ["alpha"],
        permissions: {
          db: { read: ["core"], write: ["alpha", "core"] },
          networkEgress: [],
          llmHandler: { access: false },
        },
      }),
    },
    (dir) => {
      const result = runCli(["--root", dir]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /tool-a.*write permission for schema "core".*owned by.*tool\.json/s);
    },
  );
});

test("CLI rejects a database write permission for a schema with no owning manifest", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({
        id: "tool-a",
        schemas: ["alpha"],
        permissions: {
          db: { read: [], write: ["alpha", "orphan"] },
          networkEgress: [],
          llmHandler: { access: false },
        },
      }),
    },
    (dir) => {
      const result = runCli(["--root", dir]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /write permission for schema "orphan" but no manifest owns that schema/);
    },
  );
});

test("CLI allows reads from another owner's schema and writes to the manifest's own schema", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({
        id: "tool-a",
        schemas: ["alpha"],
        permissions: {
          db: { read: ["core"], write: ["alpha"] },
          networkEgress: [],
          llmHandler: { access: false },
        },
      }),
    },
    (dir) => {
      const result = runCli(["--root", dir]);
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

// --- canonicalization / hashing (feeds --registry mode) ------------------

test("canonicalJSON is stable across key order", () => {
  const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
  const b = { a: 2, c: { x: 2, y: 1 }, b: 1 };
  assert.equal(canonicalJSON(a), canonicalJSON(b));
});

test("canonicalize preserves array element order", () => {
  assert.deepEqual(canonicalize({ list: [3, 1, 2] }), { list: [3, 1, 2] });
});

test("manifestHash is deterministic and changes when content changes", () => {
  assert.equal(manifestHash(rootManifest()), manifestHash(rootManifest()));
  assert.notEqual(manifestHash(rootManifest()), manifestHash(rootManifest({ version: "0.2.0" })));
  assert.match(manifestHash(rootManifest()), /^[0-9a-f]{64}$/);
});

// --- validateAll against the real repository manifest set ----------------

test("validateAll passes against the real repository's current manifest set", () => {
  const paths = findManifestPaths(TOOLBELT_ROOT);
  assert.ok(paths.length >= 1);
  const failures = validateAll(paths, { rootManifestPath: join(TOOLBELT_ROOT, "tool.json"), schemaPath: SCHEMA_PATH });
  assert.deepEqual(failures, []);
});

// --- CLI end-to-end (spawns the real script; TB-1a, TB-5) -----------------

test("CLI exits 0 within the TB-1a 5-second budget against the real repository manifest set", () => {
  const startedAt = Date.now();
  const result = runCli([]);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsedMs < 5000, `manifests:check took ${elapsedMs}ms, over the TB-1a 5s budget`);
  assert.match(result.stdout, /Manifest validation passed/);
});

test("CLI --registry verifies every real manifest against its local registration migration", () => {
  const result = runCli(["--registry"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Registry parity passed for 6 manifests/);
  assert.match(result.stdout, /toolbelt\s+sha256=[0-9a-f]{64}/);
  assert.match(result.stdout, /sha256=[0-9a-f]{64}/);
  assert.doesNotMatch(result.stdout, /Registry comparison not yet available/);
});

test("CLI --registry exits non-zero when a manifest has no registration migration", () => {
  const manifest = rootManifest({
    lifecycle: {
      migrate: "gh workflow run platform-migrations.yml",
      health: "node --test",
      register: "20260101000000_register_toolbelt.sql",
    },
  });
  withFixtureRoot({ "tool.json": manifest }, (dir) => {
    const result = runCli(["--root", dir, "--registry"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /registration migration .* does not exist/);
  });
});

test("CLI --registry exits non-zero when the registered manifest hash is stale", () => {
  const register = "20260101000000_register_toolbelt.sql";
  const manifest = rootManifest({
    lifecycle: { migrate: "none", health: "node --test", register },
  });
  withFixtureRoot(
    {
      "tool.json": manifest,
      [`supabase/migrations/${register}`]: registrationMigration(manifest, "0".repeat(64)),
    },
    (dir) => {
      const result = runCli(["--root", dir, "--registry"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /registered manifest_hash .* does not match canonical sha256/);
    },
  );
});

test("CLI --registry exits non-zero when a migration registers the wrong core.app id", () => {
  const register = "20260101000000_register_toolbelt.sql";
  const manifest = rootManifest({ lifecycle: { migrate: "none", health: "node --test", register } });
  withFixtureRoot(
    {
      "tool.json": manifest,
      [`supabase/migrations/${register}`]: registrationMigration(manifest, manifestHash(manifest), {
        registeredId: "different-tool",
      }),
    },
    (dir) => {
      const result = runCli(["--root", dir, "--registry"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /registers core\.app\.id "different-tool".*declares "toolbelt"/s);
    },
  );
});

test("CLI --registry exits non-zero when the migration embeds a different manifest despite a current hash", () => {
  const register = "20260101000000_register_toolbelt.sql";
  const manifest = rootManifest({ lifecycle: { migrate: "none", health: "node --test", register } });
  const staleManifest = { ...manifest, version: "0.0.9" };
  withFixtureRoot(
    {
      "tool.json": manifest,
      [`supabase/migrations/${register}`]: registrationMigration(manifest, manifestHash(manifest), {
        embeddedManifest: staleManifest,
      }),
    },
    (dir) => {
      const result = runCli(["--root", dir, "--registry"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /embedded manifest does not match/);
    },
  );
});

test("CLI --registry rejects an upsert that does not refresh manifest_hash on conflict", () => {
  const register = "20260101000000_register_toolbelt.sql";
  const manifest = rootManifest({ lifecycle: { migrate: "none", health: "node --test", register } });
  const migration = registrationMigration(manifest, manifestHash(manifest)).replace(
    "  manifest_hash = excluded.manifest_hash;",
    "  version = excluded.version;",
  );
  withFixtureRoot(
    { "tool.json": manifest, [`supabase/migrations/${register}`]: migration },
    (dir) => {
      const result = runCli(["--root", dir, "--registry"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /upsert does not refresh manifest_hash from excluded\.manifest_hash/);
    },
  );
});

test("CLI --registry rejects a lifecycle.register path that escapes the migration directory", () => {
  const manifest = rootManifest({
    lifecycle: { migrate: "none", health: "node --test", register: "../outside.sql" },
  });
  withFixtureRoot({ "tool.json": manifest }, (dir) => {
    const result = runCli(["--root", dir, "--registry"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lifecycle\.register escapes the registry migration directory/);
  });
});

test("CLI (TB-5) exits non-zero over a fixture with a deliberate cross-manifest schema collision", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a", schemas: ["widget"] }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b", schemas: ["widget"] }),
    },
    (dir) => {
      const result = runCli(["--root", dir]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /schema "widget" is claimed by 2 manifests/);
    },
  );
});

test("CLI rejects an unrecognized argument with exit code 2", () => {
  const result = runCli(["--bogus"]);
  assert.equal(result.status, 2);
});
