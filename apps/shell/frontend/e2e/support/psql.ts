// The local-PostgreSQL primitives every e2e fixture in this directory needs.
//
// Four fixtures (registry, cost, prompt, intake) each stand up a real
// disposable database against this sandbox's already-running cluster, and
// each of them used to carry its own byte-identical copy of these helpers.
// The bodies are here once; what stays per-fixture is the part that is
// genuinely per-fixture -- which migrations to apply, which roles to
// bootstrap, and what fixture rows to seed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** e2e/support -> e2e -> frontend -> shell -> apps -> repo root. */
export const REPO_ROOT = path.resolve(HERE, "../../../../..");

/** Every psql call goes through the `postgres` OS user. `-n` so a sandbox
 *  without passwordless sudo fails immediately and loudly rather than
 *  blocking forever on a password prompt no test can answer. */
export function sudoPostgres(args: string[], input?: string): string {
  return execFileSync("sudo", ["-n", "-u", "postgres", ...args], { encoding: "utf8", input });
}

/** Run a multi-statement script. `-f -` rather than `-c` because `-c` wraps
 *  its argument in a single implicit transaction, which changes the meaning
 *  of any script containing its own BEGIN/COMMIT or a CREATE INDEX
 *  CONCURRENTLY. */
export function psqlText(dbName: string, sql: string): void {
  sudoPostgres(["psql", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", "-"], sql);
}

/** Run a script from disk. The file is read by THIS process, not by psql,
 *  because GitHub's runner checkout is not necessarily traversable by the
 *  `postgres` OS user -- so the checkout owner reads it and streams the exact
 *  bytes over stdin, preserving psql's file-processing mode either way. */
export function psqlFile(dbName: string, filePath: string): void {
  psqlText(dbName, readFileSync(filePath, "utf8"));
}

/** Run a single statement as one implicit transaction. */
export function psqlInline(dbName: string, sql: string): void {
  sudoPostgres(["psql", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-c", sql]);
}

/** Run a query and return its single value, unaligned and untupled. */
export function psqlScalar(dbName: string, sql: string): string {
  return sudoPostgres(["psql", "-d", dbName, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
}

/** A SQL string literal with embedded quotes doubled. */
export function pgQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A database name no concurrent run can collide with. Callers pass their own
 *  prefix so a stray database left behind by a crashed run still says which
 *  fixture created it. */
export function uniqueDbName(prefix: string): string {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}
