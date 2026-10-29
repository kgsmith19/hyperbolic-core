import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { migrate, openDatabase, readMigrations } from "./index.mjs";

/** A scratch directory with a migrations/ folder holding `files`. */
function withMigrations(files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sqlite-kit-"));
  const migrations = path.join(dir, "migrations");
  mkdirSync(migrations);
  const write = (file, sql) => writeFileSync(path.join(migrations, file), sql);
  for (const [file, sql] of Object.entries(files)) write(file, sql);
  return { dir, migrations, write, db: () => openDatabase(path.join(dir, "app.db")) };
}

test("openDatabase sets WAL, foreign keys and busy timeout, and creates parent directories", () => {
  const { dir } = withMigrations();
  const db = openDatabase(path.join(dir, "nested", "app.db"));
  assert.equal(db.prepare("pragma journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("pragma foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("pragma busy_timeout").get().timeout, 5000);
});

test("openDatabase refuses a path outside its declared root", () => {
  const { dir } = withMigrations();
  assert.throws(() => openDatabase(path.join(dir, "..", "escape.db"), { root: dir }), /outside its root/);
  assert.throws(() => openDatabase(dir, { root: dir }), /outside its root/);
  assert.doesNotThrow(() => openDatabase(path.join(dir, "ok.db"), { root: dir }));
});

test("migrate applies pending files in order, records checksums, and is idempotent", () => {
  const s = withMigrations({
    "0001_init.sql": "create table thing (id integer primary key, name text not null) strict;",
    "0002_seed.sql": "insert into thing (name) values ('a');",
  });
  const db = s.db();
  assert.deepEqual(migrate(db, s.migrations), [1, 2]);
  assert.deepEqual(migrate(db, s.migrations), [], "a second run applies nothing");
  assert.equal(db.prepare("select count(*) as n from thing").get().n, 1);
  const rows = db.prepare("select version, name, sha256 from _migrations order by version").all();
  assert.deepEqual(rows.map((r) => [r.version, r.name]), [[1, "init"], [2, "seed"]]);
  assert.equal(rows[1].sha256, createHash("sha256").update("insert into thing (name) values ('a');").digest("hex"));
  s.write("0003_more.sql", "insert into thing (name) values ('b');");
  assert.deepEqual(migrate(db, s.migrations), [3]);
});

test("migrate fails closed when an applied migration's file changed", () => {
  const s = withMigrations({ "0001_init.sql": "create table thing (id integer primary key) strict;" });
  const db = s.db();
  migrate(db, s.migrations);
  s.write("0001_init.sql", "create table thing (id integer primary key, extra text) strict;");
  assert.throws(() => migrate(db, s.migrations), /changed after it was applied/);
});

test("migrate fails closed on a gap, a duplicate number or a badly named file", () => {
  for (const files of [
    { "0001_a.sql": "select 1;", "0003_c.sql": "select 1;" },
    { "0001_a.sql": "select 1;", "0001_b.sql": "select 1;" },
    { "1_a.sql": "select 1;" },
    { "0001_Bad Name.sql": "select 1;" },
  ]) {
    const s = withMigrations(files);
    assert.throws(() => migrate(s.db(), s.migrations), /out of sequence|must be named/, Object.keys(files).join(","));
  }
});

test("a failing migration rolls back only itself and leaves earlier ones applied", () => {
  const s = withMigrations({
    "0001_init.sql": "create table thing (id integer primary key) strict;",
    "0002_broken.sql": "insert into thing (id) values (1); insert into nowhere values (1);",
  });
  const db = s.db();
  assert.throws(() => migrate(db, s.migrations), /0002_broken\.sql failed/);
  assert.equal(db.prepare("select count(*) as n from thing").get().n, 0, "the failed migration's insert rolled back");
  assert.deepEqual(db.prepare("select version from _migrations").all().map((r) => r.version), [1]);
});

test("a recorded migration whose file is gone fails closed", () => {
  const s = withMigrations({ "0001_init.sql": "select 1;", "0002_two.sql": "select 1;" });
  const db = s.db();
  migrate(db, s.migrations);
  rmSync(path.join(s.migrations, "0002_two.sql"));
  assert.throws(() => migrate(db, s.migrations), /applied but its file is missing/);
});

test("readMigrations exposes version, name and the file's sha256", () => {
  const s = withMigrations({ "0001_init.sql": "select 1;" });
  assert.deepEqual(readMigrations(s.migrations).map(({ version, name, sha256 }) => ({ version, name, sha256 })), [
    { version: 1, name: "init", sha256: createHash("sha256").update("select 1;").digest("hex") },
  ]);
});
