import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  MIGRATION_DIRS,
  discoverMigrationDirs,
  checkDownPairing,
  checkBrainSchemaReservation,
  checkOwnerCallWrapping,
  checkVersionCollisions,
  stripLineComments,
  validateAll,
} from "../scripts/validate-migrations.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(TEST_DIR, "..", "scripts", "validate-migrations.mjs");

function withFixtureDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "migrations-fixture-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("checkDownPairing passes when every up has a down", () => {
  withFixtureDir(
    {
      "20260101000000_thing.sql": "create table x();",
      "20260101000000_thing_down.sql": "drop table x;",
    },
    (dir) => {
      assert.deepEqual(checkDownPairing([dir]), []);
    },
  );
});

test("checkDownPairing fails when an up migration has no paired down", () => {
  withFixtureDir(
    {
      "20260101000000_thing.sql": "create table x();",
    },
    (dir) => {
      const failures = checkDownPairing([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /missing paired down migration/);
    },
  );
});

test("checkBrainSchemaReservation passes for unrelated schemas", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": "create schema idea;" },
    (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    },
  );
});

// Regression: caught by mutation testing, not by inspection. Dropping the
// \b word-boundary anchor from BRAIN_SCHEMA_RE survived the rest of this
// suite untouched, which meant nothing actually proved "brain" is matched
// as a whole schema name rather than a prefix. A tool legitimately named
// "brainstorm" (or any brain-prefixed name) must not be blocked by the
// brain reservation, which is exactly "brain" and nothing else.
test("checkBrainSchemaReservation does not flag a schema name that merely starts with 'brain'", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": "create schema brainstorm;" },
    (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    },
  );
});

// Regression: found by adversarial property-test design, not by inspection.
// A comment merely mentioning the reservation must not itself trip the
// lint -- only executable DDL creates a schema. The original implementation
// scanned raw file content, so this case failed until comment-stripping was
// added (see scripts/validate-migrations.mjs, checkBrainSchemaReservation).
test("checkBrainSchemaReservation ignores a comment that only mentions creating the brain schema", () => {
  withFixtureDir(
    {
      "20260101000000_thing.sql":
        "-- reminder: never create schema brain here, it is reserved for phase 7\nselect 1;",
    },
    (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    },
  );
});

test("checkBrainSchemaReservation fails when a file creates the brain schema", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": "create schema brain;" },
    (dir) => {
      const failures = checkBrainSchemaReservation([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /reserved 'brain' schema/);
    },
  );
  withFixtureDir(
    { "20260101000000_thing.sql": "CREATE SCHEMA IF NOT EXISTS brain;" },
    (dir) => {
      assert.equal(checkBrainSchemaReservation([dir]).length, 1);
    },
  );
});

test("checkBrainSchemaReservation recognizes the exact quoted lowercase brain identifier", () => {
  withFixtureDir({ "20260101000000_thing.sql": 'create schema "brain";' }, (dir) => {
    assert.equal(checkBrainSchemaReservation([dir]).length, 1);
  });
  withFixtureDir({ "20260101000000_thing.sql": 'create schema if not exists "brain";' }, (dir) => {
    assert.equal(checkBrainSchemaReservation([dir]).length, 1);
  });
  for (const distinctIdentifier of ['create schema "Brain";', 'create schema "BRAIN";']) {
    withFixtureDir({ "20260101000000_thing.sql": distinctIdentifier }, (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    });
  }
});

test("checkOwnerCallWrapping passes when platform.owner() is wrapped in a scalar subquery", () => {
  withFixtureDir(
    {
      "20260101000000_policy.sql":
        "create policy owner_rw on core.run using (user_id = (select platform.owner()));",
    },
    (dir) => {
      assert.deepEqual(checkOwnerCallWrapping([dir]), []);
    },
  );
});

test("checkOwnerCallWrapping fails on a bare platform.owner() call", () => {
  withFixtureDir(
    {
      "20260101000000_policy.sql":
        "create policy owner_rw on core.run using (user_id = platform.owner());",
    },
    (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /bare platform\.owner\(\) call/);
    },
  );
});

test("checkOwnerCallWrapping ignores mentions inside line comments", () => {
  withFixtureDir(
    {
      "20260101000000_policy.sql":
        "-- calls platform.owner() to resolve the pin\ncreate policy owner_rw on core.run using (user_id = (select platform.owner()));",
    },
    (dir) => {
      assert.deepEqual(checkOwnerCallWrapping([dir]), []);
    },
  );
});

test("SQL comment stripping preserves strings and removes nested block comments without losing line numbers", () => {
  assert.equal(
    stripLineComments("select 'a--b'; /* outer /* inner */ rest */\nselect platform.owner();"),
    "select 'a--b'; \nselect platform.owner();",
  );
  withFixtureDir(
    { "20260101000000_policy.sql": "/* line1\nline2\nline3 */\nselect 'it''s--fine', platform.owner();" },
    (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /:4: bare platform\.owner\(\) call/);
    },
  );
});

test("checkOwnerCallWrapping ignores the function's own CREATE/DROP/GRANT/REVOKE signature", () => {
  withFixtureDir(
    {
      "20260101000000_bootstrap.sql": [
        "create function platform.owner() returns uuid",
        "language sql stable security definer",
        "as $$ select owner_uuid from platform.config $$;",
        "revoke all on function platform.owner() from public;",
        "grant execute on function platform.owner() to anon, authenticated;",
      ].join("\n"),
      "20260101000000_bootstrap_down.sql": "drop function if exists platform.owner();",
    },
    (dir) => {
      assert.deepEqual(checkOwnerCallWrapping([dir]), []);
    },
  );
});

test("checkVersionCollisions passes for unique version keys", () => {
  withFixtureDir(
    {
      "20260101000000_a.sql": "select 1;",
      "20260101000001_b.sql": "select 1;",
    },
    (dir) => {
      assert.deepEqual(checkVersionCollisions([dir]), []);
    },
  );
});

test("checkVersionCollisions passes for a legitimate up/down pair sharing a timestamp", () => {
  withFixtureDir(
    {
      "20260101000000_thing.sql": "create table x();",
      "20260101000000_thing_down.sql": "drop table x;",
    },
    (dir) => {
      assert.deepEqual(checkVersionCollisions([dir]), []);
    },
  );
});

test("checkVersionCollisions fails when two DIFFERENT migrations share a version key", () => {
  withFixtureDir(
    {
      "20260101000000_a.sql": "select 1;",
      "20260101000000_b.sql": "select 1;",
    },
    (dir) => {
      const failures = checkVersionCollisions([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /shared by 2 forward migrations/);
    },
  );
});

test("checkVersionCollisions rejects identical forward basenames in different owner directories", () => {
  const dirA = mkdtempSync(join(tmpdir(), "migrations-identical-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "migrations-identical-b-"));
  try {
    writeFileSync(join(dirA, "20260101000000_same.sql"), "select 'owner-a';");
    writeFileSync(join(dirB, "20260101000000_same.sql"), "select 'owner-b';");
    const failures = checkVersionCollisions([dirA, dirB]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /shared by 2 forward migrations/);
    assert.match(failures[0], /migrations-identical-a/);
    assert.match(failures[0], /migrations-identical-b/);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("checkVersionCollisions detects collisions across multiple directories", () => {
  const dirA = mkdtempSync(join(tmpdir(), "migrations-fixture-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "migrations-fixture-b-"));
  try {
    writeFileSync(join(dirA, "20260101000000_a.sql"), "select 1;");
    writeFileSync(join(dirB, "20260101000000_b.sql"), "select 1;");
    const failures = checkVersionCollisions([dirA, dirB]);
    assert.equal(failures.length, 1);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("validateAll rejects a required migration directory that does not exist", () => {
  const missing = join(tmpdir(), "does-not-exist-migrations-dir-fixture");
  const failures = validateAll([missing]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /required migration directory does not exist/);
});

test("discoverMigrationDirs includes root plus every schema-owning manifest in stable order", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-discovery-"));
  try {
    // A tool keeps its migrations under backend/; only the spine at the
    // root keeps them directly beside its own manifest.
    const addManifest = (relativeDir, id, schemas) => {
      const dir = join(root, relativeDir);
      const migrations = relativeDir === "." ? [dir, "supabase", "migrations"] : [dir, "backend", "supabase", "migrations"];
      mkdirSync(join(...migrations), { recursive: true });
      writeFileSync(join(dir, "tool.json"), JSON.stringify({ id, schemas }));
    };
    addManifest(".", "toolbelt", ["core"]);
    addManifest("apps/zeta", "zeta", ["zeta"]);
    addManifest("apps/local-only", "local-only", []);
    addManifest("apps/alpha", "alpha", ["alpha"]);

    assert.deepEqual(discoverMigrationDirs(root), [
      join(root, "supabase", "migrations"),
      join(root, "apps", "alpha", "backend", "supabase", "migrations"),
      join(root, "apps", "zeta", "backend", "supabase", "migrations"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverMigrationDirs fails closed when a schema owner lacks its canonical directory", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-discovery-missing-"));
  try {
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    mkdirSync(join(root, "apps", "missing"), { recursive: true });
    writeFileSync(join(root, "tool.json"), JSON.stringify({ id: "toolbelt", schemas: ["core"] }));
    writeFileSync(join(root, "apps", "missing", "tool.json"), JSON.stringify({ id: "missing", schemas: ["missing"] }));
    assert.throws(() => discoverMigrationDirs(root), /required migration directory does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverMigrationDirs rejects a schema-owner migration symlink escaping the toolbelt root", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "migration-discovery-escape-"));
  const outside = mkdtempSync(join(tmpdir(), "migration-discovery-outside-"));
  try {
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    mkdirSync(join(root, "apps", "escape", "backend", "supabase"), { recursive: true });
    writeFileSync(join(root, "tool.json"), JSON.stringify({ id: "toolbelt", schemas: ["core"] }));
    writeFileSync(join(root, "apps", "escape", "tool.json"), JSON.stringify({ id: "escape", schemas: ["escape"] }));
    symlinkSync(outside, join(root, "apps", "escape", "backend", "supabase", "migrations"));
    assert.throws(() => discoverMigrationDirs(root), /escapes the toolbelt root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("validateAll passes against the repository's real migration directories", () => {
  const failures = validateAll();
  assert.deepEqual(failures, []);
});

test("canonical migration directories are absolute and independent of process cwd", () => {
  assert.ok(MIGRATION_DIRS.every(isAbsolute));

  const unrelatedCwd = mkdtempSync(join(tmpdir(), "migration-validator-cwd-"));
  try {
    const result = spawnSync(process.execPath, [VALIDATOR], {
      cwd: unrelatedCwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Platform migration validation passed/);
  } finally {
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }
});
