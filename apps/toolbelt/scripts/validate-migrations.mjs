#!/usr/bin/env node
// Validates platform-project migration directories before platform-migrations.yml
// applies them. Three checks, per docs/planning/06-supabase-schema.md section 7.2
// and docs/planning/05-a/../06 section 5.6:
//   1. every up migration has a paired _down.sql
//   2. no migration file creates the reserved `brain` schema (06 section 4.1)
//   3. no migration file contains a bare `platform.owner()` call outside a
//      scalar subquery, which would defeat the InitPlan caching the RLS
//      policies rely on (06 section 5.6)
// Also asserts no two migration files across all directories share a version key
// (the CLI's ledger is keyed by version; a collision breaks the shared ledger).
//
// NOT enforced here, and deliberately so: the destructive-migration backup
// precondition (10-cicd-deployment.md section 8.4, m6-03). A PR containing a
// destructive migration must cite the run id of a `platform-backup.yml` run that
// completed after the PR's base commit -- see docs/ops/runbook.md, "Platform
// project backup and restore". That is a review rule, not a script check: this
// validator sees migration files, never the PR body or GitHub run history, so
// pretending to enforce it here would be a check that always passes.
import { existsSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findManifestPaths } from "./validate-manifests.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TOOLBELT_ROOT = resolve(REPOSITORY_ROOT, "apps/toolbelt");

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Discovers the shared-ledger roots from manifests, never an app allowlist. */
export function discoverMigrationDirs(toolbeltRoot = TOOLBELT_ROOT) {
  const root = resolve(toolbeltRoot);
  const rootManifest = join(root, "tool.json");
  if (!existsSync(rootManifest) || !statSync(rootManifest).isFile()) {
    throw new Error(`${rootManifest}: required root tool manifest does not exist`);
  }
  const realRoot = realpathSync(root);
  const manifestPaths = findManifestPaths(root);
  const directories = [];

  for (const manifestPath of manifestPaths) {
    const realManifest = realpathSync(manifestPath);
    let manifest;
    try { manifest = JSON.parse(readFileSync(realManifest, "utf8")); }
    catch (error) { throw new Error(`${manifestPath}: cannot parse tool manifest (${error.message})`); }
    if (!Array.isArray(manifest.schemas)) {
      throw new Error(`${manifestPath}: schemas must be an array before migrations can be discovered`);
    }

    const isRoot = resolve(manifestPath) === rootManifest;
    // A schema-less manifest (services/<id>/tool.json's own documented
    // ownership.path exception, tool.schema.json; 08-llm-handlers.md
    // forced decision 7) has no migrations of its own to discover and is
    // NEVER expected to live inside the toolbelt root -- that is the whole
    // point of the exception -- so it must be skipped before the
    // toolbelt-root containment check below, not after: this check only
    // protects the shared ledger's migration-directory discovery, which a
    // schema-less manifest never participates in.
    if (!isRoot && manifest.schemas.length === 0) continue;
    if (!inside(realRoot, realManifest)) {
      throw new Error(`${manifestPath}: manifest escapes the toolbelt root`);
    }
    // A tool keeps ALL of its backend work under backend/, migrations
    // included, so its frontend/ and backend/ halves are separable at a
    // glance. The toolbelt root is not a tool -- it is the spine that owns
    // the shared core/idea schemas and has no frontend to separate from --
    // so its own migrations stay at its root.
    const migrationDir = isRoot
      ? resolve(dirname(manifestPath), "supabase", "migrations")
      : resolve(dirname(manifestPath), "backend", "supabase", "migrations");
    let realMigrationDir;
    try { realMigrationDir = realpathSync(migrationDir); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error(`${migrationDir}: required migration directory does not exist`);
      throw error;
    }
    if (!statSync(realMigrationDir).isDirectory()) {
      throw new Error(`${migrationDir}: required migration path is not a directory`);
    }
    if (!inside(realRoot, realMigrationDir)) {
      throw new Error(`${migrationDir}: migration directory escapes the toolbelt root`);
    }
    directories.push(migrationDir);
  }

  return [directories[0], ...directories.slice(1).sort()].filter((dir, index, all) => all.indexOf(dir) === index);
}

export const MIGRATION_DIRS = discoverMigrationDirs();

function listSqlFiles(dir, { existsOnly = true } = {}) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => join(dir, name));
  } catch (err) {
    if (existsOnly && err.code === "ENOENT") return [];
    throw err;
  }
}

export function checkDownPairing(dirs) {
  const failures = [];
  for (const dir of dirs) {
    const files = listSqlFiles(dir);
    const names = new Set(files.map((f) => basename(f)));
    for (const file of files) {
      const name = basename(file);
      if (name.endsWith("_down.sql")) continue;
      const stem = name.slice(0, -".sql".length);
      const downName = `${stem}_down.sql`;
      if (!names.has(downName)) {
        failures.push(`${file}: missing paired down migration ${downName}`);
      }
    }
  }
  return failures;
}

const BRAIN_SCHEMA_RE = /create\s+schema\s+(if\s+not\s+exists\s+)?brain\b/i;

// PostgreSQL folds an unquoted identifier to lowercase. The exact quoted
// spelling "brain" therefore names the same reserved schema and must not
// bypass the lint; differently-cased quoted identifiers are distinct.
function normalizeQuotedBrainIdentifier(sql) {
  return sql.replace(/"brain"/g, "brain");
}

export function checkBrainSchemaReservation(dirs) {
  const failures = [];
  for (const dir of dirs) {
    for (const file of listSqlFiles(dir)) {
      // Comment-strip first: a comment merely mentioning the reservation
      // (e.g. "-- never create schema brain here") must not itself trip the
      // lint. Found by property-based testing, not assumed correct by
      // inspection -- see validate-migrations.property.test.mjs.
      const sql = normalizeQuotedBrainIdentifier(stripLineComments(readFileSync(file, "utf8")));
      if (BRAIN_SCHEMA_RE.test(sql)) {
        failures.push(`${file}: creates the reserved 'brain' schema (06-supabase-schema.md section 4.1 reservation)`);
      }
    }
  }
  return failures;
}

// Remove SQL line and nested block comments without treating comment markers
// inside a single-quoted string as syntax. Newlines are preserved so lint
// diagnostics continue to report source line numbers accurately.
export function stripLineComments(sql) {
  let result = "";
  let inString = false;
  let blockDepth = 0;

  for (let index = 0; index < sql.length; ) {
    const current = sql[index];
    const next = sql[index + 1];

    if (inString) {
      if (current === "'") {
        if (next === "'") {
          result += "''";
          index += 2;
          continue;
        }
        inString = false;
      }
      result += current;
      index += 1;
      continue;
    }

    if (blockDepth > 0) {
      if (current === "/" && next === "*") {
        blockDepth += 1;
        index += 2;
        continue;
      }
      if (current === "*" && next === "/") {
        blockDepth -= 1;
        index += 2;
        continue;
      }
      if (current === "\n") result += "\n";
      index += 1;
      continue;
    }

    if (current === "'") {
      inString = true;
      result += current;
      index += 1;
      continue;
    }
    if (current === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockDepth = 1;
      index += 2;
      continue;
    }

    result += current;
    index += 1;
  }
  return result;
}

// A "platform.owner()" occurrence is the function's own signature, not a
// call, when it follows CREATE [OR REPLACE] FUNCTION, DROP FUNCTION, or a
// GRANT/REVOKE ... ON FUNCTION clause -- all legitimate DDL that names the
// function without invoking it.
const OWNER_FUNCTION_SIGNATURE_RE =
  /(create\s+(or\s+replace\s+)?function|drop\s+function(\s+if\s+exists)?|on\s+function)\s+platform\s*\.\s*owner\s*\(\s*\)/gi;

// Matches platform.owner() NOT immediately preceded by "(select " (case-insensitive,
// tolerant of internal whitespace). A bare call defeats InitPlan caching (06 section 5.6).
const BARE_OWNER_CALL_RE = /platform\s*\.\s*owner\s*\(\s*\)/gi;

export function checkOwnerCallWrapping(dirs) {
  const failures = [];
  for (const dir of dirs) {
    for (const file of listSqlFiles(dir)) {
      const raw = readFileSync(file, "utf8");
      // Comment-strip only (never drop non-comment text), so line numbers
      // computed below still line up with the file on disk.
      const withoutComments = stripLineComments(raw);
      // Blank out matched signature text char-by-char (preserving any
      // embedded newlines) so line numbers computed below stay accurate
      // even if a signature ever spans multiple lines.
      const withoutSignatures = withoutComments.replace(OWNER_FUNCTION_SIGNATURE_RE, (m) =>
        Array.from(m, (c) => (c === "\n" ? "\n" : " ")).join(""),
      );
      let match;
      const re = new RegExp(BARE_OWNER_CALL_RE.source, "gi");
      while ((match = re.exec(withoutSignatures))) {
        const prefix = withoutSignatures.slice(Math.max(0, match.index - 40), match.index);
        if (!/\(\s*select\s+$/i.test(prefix)) {
          const line = withoutSignatures.slice(0, match.index).split("\n").length;
          failures.push(`${file}:${line}: bare platform.owner() call outside a scalar subquery; wrap as (select platform.owner())`);
        }
      }
    }
  }
  return failures;
}

// The Supabase ledger has one global row per version. Exactly one forward
// source file may claim a version; its paired down file is review-only and is
// not staged. This deliberately rejects byte/name-identical forward files in
// different owner directories too: staging by basename would otherwise
// overwrite one silently.
export function checkVersionCollisions(dirs) {
  const seen = new Map(); // version -> forward source files
  for (const dir of dirs) {
    for (const file of listSqlFiles(dir)) {
      const name = basename(file, ".sql");
      if (name.endsWith("_down")) continue;
      const version = name.split("_")[0];
      if (!/^\d+$/.test(version)) continue;
      const list = seen.get(version) ?? [];
      list.push(file);
      seen.set(version, list);
    }
  }
  const failures = [];
  for (const [version, files] of seen) {
    if (files.length > 1) {
      failures.push(`version ${version} shared by ${files.length} forward migrations: ${files.join(", ")}`);
    }
  }
  return failures;
}

export function checkRequiredDirectories(dirs) {
  const failures = [];
  for (const dir of dirs) {
    try {
      readdirSync(dir);
    } catch (err) {
      if (err.code === "ENOENT") {
        failures.push(`${dir}: required migration directory does not exist`);
        continue;
      }
      throw err;
    }
  }
  return failures;
}

export function validateAll(dirs = MIGRATION_DIRS) {
  const directoryFailures = checkRequiredDirectories(dirs);
  if (directoryFailures.length > 0) return directoryFailures;
  return [
    ...checkDownPairing(dirs),
    ...checkBrainSchemaReservation(dirs),
    ...checkOwnerCallWrapping(dirs),
    ...checkVersionCollisions(dirs),
  ];
}

function main() {
  const failures = validateAll();
  if (failures.length > 0) {
    console.error("Platform migration validation failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("Platform migration validation passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
