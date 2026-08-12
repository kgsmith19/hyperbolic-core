import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDownPairing,
  checkBrainSchemaReservation,
  checkOwnerCallWrapping,
  checkVersionCollisions,
  validateAll,
} from "../scripts/validate-migrations.mjs";

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
      assert.match(failures[0], /shared by 2 distinct migrations/);
    },
  );
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

test("validateAll tolerates a migration directory that does not exist yet", () => {
  const missing = join(tmpdir(), "does-not-exist-migrations-dir-fixture");
  assert.deepEqual(validateAll([missing]), []);
});

test("validateAll passes against the repository's real migration directories", () => {
  const failures = validateAll();
  assert.deepEqual(failures, []);
});
