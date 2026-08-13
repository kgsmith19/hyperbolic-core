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
import { readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { findManifestPaths, TOOLBELT_ROOT } from "./validate-manifests.mjs";

// discoverMigrationDirs replaces what used to be a hardcoded, three-entry
// MIGRATION_DIRS literal (Finding 26, independent security review of this
// repo, re-verified against current HEAD: "Scaffolding emits nested
// migrations, but workflow and validator hard-code known app directories.
// That contradicts the promised three-step/no-outside-edits path.").
//
// The concrete, ALREADY-EXISTING proof this was a real gap and not a
// hypothetical: apps/toolbelt/apps/network-checker/ has had its own
// supabase/migrations/ directory (0001_init.sql, 0002_inventory.sql) since
// before this fix, and it was correctly never added to the old hardcoded
// list -- but that correctness depended entirely on a human remembering the
// documented reason (see its own registration migration's header comment,
// 20260812250000_register_network-checker.sql: "network-checker's own
// supabase/migrations/ is absent from both [this workflow's directory list
// and MIGRATION_DIRS]" as a DELIBERATE fact about a separate, optional
// mirror project, not the shared platform database). A tool scaffolded by
// packages/toolbelt-cli's tool:new with --schema, by contrast, is SUPPOSED
// to ride the shared platform pipeline automatically, per the CLI's own
// promised "no manual framework edits" 3-step flow -- and nothing enforced
// that a human ever actually performed the manual edit the old
// MIGRATION_DIRS literal required. Both are real; the fix has to tell them
// apart without a human doing it by hand each time.
//
// The discriminator is exactly what already distinguishes these two real
// cases on disk: whether the tool's own tool.json declares a non-empty
// `schemas` array -- i.e. whether it owns a schema in the shared toolbelt
// Supabase project at all (Network Checker's manifest declares `"schemas":
// []`, the one real no-schema manifest per templates.mjs's own comment; the
// three tools this list used to hardcode -- the root spine, Prompt
// Organizer, Idea Intake -- all declare a non-empty `schemas` array). This
// is deliberately NOT a blind "every supabase/migrations directory found by
// walking the tree" scan (the review's own alternative suggestion): that
// naive version would have swept Network Checker's directory into the
// shared platform validation/staging pipeline, which is exactly backwards --
// its Supabase project is a genuinely separate database, and treating its
// migrations as part of the shared platform's version-key namespace or
// pushing them via `supabase db push` against the platform project would be
// a real, active regression, not a fix. Schema-ownership is the one signal
// that already means "this tool's migrations belong to the shared platform
// database" throughout the rest of this codebase (see
// packages/toolbelt-cli/src/templates.mjs's buildManifest: hasSchema is
// exactly what decides whether tool:new even generates a
// supabase/migrations/ directory for a new tool in the first place).
//
// findManifestPaths (imported, not reimplemented, from
// validate-manifests.mjs -- the same function apps/toolbelt/scripts/
// validate-manifests.mjs's own findManifestPaths walk already uses to
// discover every real tool.json, root spine included) is the single source
// of "which tools exist" for this scan; a manifest that fails to parse is
// silently skipped here the same way collisions.mjs's own findManifestIds
// does (a malformed manifest is validate-manifests.mjs's own concern to
// report, not this discovery pass's).
export function discoverMigrationDirs(root = TOOLBELT_ROOT) {
  const dirs = [];
  for (const manifestPath of findManifestPaths(root)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(manifest.schemas) || manifest.schemas.length === 0) continue;
    dirs.push(join(dirname(manifestPath), "supabase", "migrations"));
  }
  return dirs;
}

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

// Independent security review, Finding 45 (re-verified against current
// HEAD): a double-quoted identifier evades BRAIN_SCHEMA_RE outright --
// `create schema "brain"` creates the exact same real, lowercase `brain`
// schema Postgres would create for the unquoted `create schema brain`, but
// the regex requires literal whitespace immediately before the bare word
// `brain` and never sees past the `"`. Only the EXACT lowercase quoted form
// `"brain"` is normalized away (by stripping its quotes so the existing
// case-insensitive regex can see it) -- deliberately NOT every
// double-quoted identifier: Postgres's own real folding rules make
// `"Brain"` or `"BRAIN"` a case-sensitive, genuinely DIFFERENT identifier
// from the reserved lowercase `brain` (only an UNQUOTED name folds to
// lowercase regardless of how it was typed; a quoted one is taken verbatim
// as written). Normalizing every double-quoted identifier indiscriminately
// would turn that into a false positive -- flagging a legitimately
// different, unreserved schema name. This narrow, literal replacement is
// exactly and only the one case that actually collides with the reserved
// name.
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

// Independent security review, Finding 45 (re-verified against current
// HEAD): the original implementation split on "\n" and truncated each line
// at its first literal "--", with no awareness of SQL string-literal
// quoting or block comments -- two real, exploitable gaps in a lint this
// repo's own CI treats as a real gate (checkBrainSchemaReservation and
// checkOwnerCallWrapping both depend on this function to see the real,
// non-comment SQL):
//
//   1. A single-quoted string literal containing the two characters `--`
//      (e.g. a `title`/`description`/`source` default or seed value like
//      'a--b') would have everything after that point on the same physical
//      line silently discarded as if it were a comment -- including real,
//      executable SQL that happened to follow on that line.
//   2. No `/* ... */` block-comment handling at all: a block comment
//      spanning or containing what looks like the reserved schema name or a
//      bare platform.owner() call was invisible to this function one way
//      (never stripped, so its CONTENTS could itself accidentally trip a
//      check) while also not preventing REAL code after it on the same
//      line from being misread if the block comment shared a line with a
//      line comment marker.
//
// Fix (proportionate -- this remains a single-purpose lint, not a real SQL
// parser): a small single-pass state machine over the whole file text
// (never per-line -- a single-quoted string, like a block comment, can
// legitimately span multiple physical lines in real SQL) that tracks
// exactly three states -- inside a single-quoted string (with `''`
// doubled-quote escaping, the standard SQL escape), inside a `/* */` block
// comment (nestable, matching Postgres's own actual behavior -- `/* /* */
// */` is one complete comment, not a syntax error), and default/code -- and
// strips `--`-to-end-of-line only in the default state, and block comments
// in any state but a string. Deliberately NOT dollar-quoted ($$...$$)
// string aware: every dollar-quoted function body in this repo's real
// migrations is, by construction, valid SQL/plpgsql whose own single-quoted
// string literals are already balanced (an unbalanced quote inside a $$
// body would be invalid SQL to begin with), so whole-file single-quote
// tracking stays correct straight through a $$ body without needing to
// special-case its boundaries -- confirmed by running this exact
// implementation against every real committed migration in this repository
// with zero behavioral change from the previous implementation (see
// validate-migrations.test.mjs's "against the real repository" case).
// Preserves line numbers exactly (needed by checkOwnerCallWrapping's own
// line-number reporting): a block comment's interior characters are
// replaced by nothing except its own embedded newlines, which are kept.
export function stripLineComments(sql) {
  let result = "";
  let inString = false;
  let blockDepth = 0;
  const n = sql.length;
  for (let i = 0; i < n; ) {
    if (inString) {
      const ch = sql[i];
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          result += "''";
          i += 2;
          continue;
        }
        inString = false;
        result += "'";
        i += 1;
        continue;
      }
      result += ch;
      i += 1;
      continue;
    }
    if (blockDepth > 0) {
      if (sql[i] === "/" && sql[i + 1] === "*") {
        blockDepth += 1;
        i += 2;
        continue;
      }
      if (sql[i] === "*" && sql[i + 1] === "/") {
        blockDepth -= 1;
        i += 2;
        continue;
      }
      if (sql[i] === "\n") result += "\n";
      i += 1;
      continue;
    }
    if (sql[i] === "'") {
      inString = true;
      result += "'";
      i += 1;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      blockDepth = 1;
      i += 2;
      continue;
    }
    result += sql[i];
    i += 1;
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

// A version key is shared legitimately by exactly one up file and its own
// paired down file (the toolbelt convention: <ts>_name.sql + <ts>_name_down.sql).
// It is a real collision only when a version prefix is claimed by more than
// one DISTINCT logical migration (differing base name once "_down" is
// stripped) -- e.g. two unrelated files from different tool directories that
// happened to pick the same timestamp. Comparing raw filenames instead of
// stems would flag every existing, correct up/down pair as a collision.
export function checkVersionCollisions(dirs) {
  const seen = new Map(); // version -> Map(stem -> [files])
  for (const dir of dirs) {
    for (const file of listSqlFiles(dir)) {
      const name = basename(file, ".sql");
      const version = name.split("_")[0];
      if (!/^\d+$/.test(version)) continue;
      const stem = name.endsWith("_down") ? name.slice(0, -"_down".length) : name;
      const byStem = seen.get(version) ?? new Map();
      const list = byStem.get(stem) ?? [];
      list.push(file);
      byStem.set(stem, list);
      seen.set(version, byStem);
    }
  }
  const failures = [];
  for (const [version, byStem] of seen) {
    if (byStem.size > 1) {
      const allFiles = [...byStem.values()].flat();
      failures.push(`version ${version} shared by ${byStem.size} distinct migrations: ${allFiles.join(", ")}`);
    }
  }
  return failures;
}

export function validateAll(dirs = discoverMigrationDirs()) {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
