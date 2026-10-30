// @hyperbolic/sqlite-kit (#506): the one way a Node sub-app opens its local
// SQLite database and applies its own migrations. node:sqlite is built into
// Node 22, so there is no native dependency to install.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATION_FILE = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;

/**
 * Open (creating if needed) a SQLite database with the platform's pragmas.
 * `root`, when given, is the only directory the file may live under.
 */
export function openDatabase(file, { root, busyTimeoutMs = 5000 } = {}) {
  const resolved = path.resolve(file);
  if (root !== undefined) {
    const base = path.resolve(root);
    const relative = path.relative(base, resolved);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`database path ${resolved} is outside its root ${base}`);
    }
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec(`pragma journal_mode = WAL; pragma foreign_keys = ON; pragma busy_timeout = ${Number(busyTimeoutMs) | 0};`);
  return db;
}

/** The migration files in `dir`, validated and ordered: [{version, name, file, sql, sha256}]. */
export function readMigrations(dir) {
  const entries = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  const migrations = [];
  for (const [index, file] of entries.entries()) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) throw new Error(`migration ${file} must be named NNNN_<name>.sql`);
    const version = Number(match[1]);
    if (version !== index + 1) {
      throw new Error(`migration ${file} is out of sequence: expected ${String(index + 1).padStart(4, "0")}`);
    }
    const sql = readFileSync(path.join(dir, file), "utf8");
    migrations.push({ version, name: match[2], file, sql, sha256: createHash("sha256").update(sql).digest("hex") });
  }
  return migrations;
}

/**
 * Apply every pending migration in `dir`, each in its own transaction.
 * Returns the versions applied by this call. An applied migration whose file
 * changed since, or a recorded version with no file, fails before anything runs.
 */
export function migrate(db, dir) {
  db.exec(`create table if not exists _migrations (
    version integer primary key,
    name text not null,
    sha256 text not null,
    applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) strict;`);
  const migrations = readMigrations(dir);
  const applied = db.prepare("select version, name, sha256 from _migrations order by version").all();
  for (const row of applied) {
    const file = migrations[row.version - 1];
    if (!file) throw new Error(`migration ${row.version} (${row.name}) was applied but its file is missing`);
    if (file.sha256 !== row.sha256) {
      throw new Error(`migration ${file.file} changed after it was applied (sha256 ${row.sha256.slice(0, 12)} -> ${file.sha256.slice(0, 12)})`);
    }
  }
  const done = [];
  for (const migration of migrations.slice(applied.length)) {
    db.exec("begin immediate");
    try {
      db.exec(migration.sql);
      db.prepare("insert into _migrations (version, name, sha256) values (?, ?, ?)").run(
        migration.version,
        migration.name,
        migration.sha256,
      );
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw new Error(`migration ${migration.file} failed: ${error.message}`, { cause: error });
    }
    done.push(migration.version);
  }
  return done;
}
