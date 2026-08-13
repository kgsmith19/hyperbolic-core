#!/usr/bin/env node
// Stages every UP migration file from every directory
// apps/toolbelt/scripts/validate-migrations.mjs's discoverMigrationDirs()
// finds into one destination directory, in one global, deterministic order
// keyed by the shared <14-digit-timestamp>_<name>.sql version scheme this
// repo already uses.
//
// Closes Finding 3 (independent security review of this repo, re-verified
// against current HEAD): .github/workflows/platform-migrations.yml ran
// three SEPARATE `supabase db push --include-all --yes` calls, one per
// hardcoded directory entry, all against the same shared ledger table
// (supabase_migrations.schema_migrations, one physical database -- see that
// workflow's own header comment). The Supabase CLI reads migrations from a
// single fixed `<cwd>/supabase/migrations` path per invocation; it has no
// multi-directory mode. Three separate per-directory pushes was the only way
// the old workflow could reach three physical directories with that
// constraint, but it meant the ledger saw each directory's files in
// whatever order the three `run:` steps happened to execute in, not the one
// global logical order every filename already encodes -- and every
// directory's `--include-all` pass was handed its own `_down.sql` files
// too, which are operator-rollback artifacts (`psql -f`), never meant to
// reach the CLI's own push/ledger machinery at all.
//
// This script removes both hazards: it collects every up file (excluding
// every `*_down.sql`) from every configured directory, sorts the whole set
// by version once, and writes it into a single `<dest>/supabase/migrations/`
// tree so exactly one `supabase db push` (run with `<dest>` as its working
// directory) sees the whole repo's platform migration history as one
// sequence, in the order its own filenames declare.
//
// Also used (via --subset-file) to build a REDUCED staged directory
// containing only a caller-supplied set of already-applied version keys --
// platform-migrations.yml's apply-mode live-parity check (Finding 4) uses
// this to diff only the portion of the schema the ledger already claims is
// live, without the diff also (mis)reporting every genuinely new pending
// migration as "drift".
//
// A third mode (--stop-before-owner-dependency) stages only the files
// strictly before the first platform.owner() reference -- platform-migrations.yml
// pushes that truncated set first, runs the live owner preflight (Finding 5:
// "owner re-pin can run before its required preflight"), then re-stages the
// full set (this same destination, called again with no flag) so the second
// `supabase db push` picks up exactly the owner-repin-tier-and-later files
// the first push deliberately left out. See splitAtOwnerDependency() below.
//
// validate-migrations.mjs's own checkVersionCollisions already forbids two
// DISTINCT migrations across all directories from sharing a version key by
// the time this script runs in CI (platform-migrations.yml always runs that
// validation step first) -- this script assumes that invariant rather than
// re-deriving it, but still fails loudly (not silently) if two files with
// the exact same BASENAME land in the same staged set, as a last line of
// defense before two files collapse onto one path.

import { readdirSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverMigrationDirs } from "./validate-migrations.mjs";

const VERSION_RE = /^(\d+)_/;

// discoverMigrationDirs() (Finding 26's fix) returns ABSOLUTE paths --
// derived from validate-manifests.mjs's TOOLBELT_ROOT, itself resolved via
// import.meta.url, never process.cwd() -- which is already cwd-independent
// by construction. The resolve() call below is kept anyway as a defensive
// second layer: it is a no-op for an already-absolute `dir` (resolve()
// leaves it untouched; join() would not -- join(REPO_ROOT, "/already/absolute")
// does NOT collapse to "/already/absolute" the way resolve() does), so it
// stays correct for the default (discovered, absolute) directories AND for
// any caller -- this file's own tests included -- that still passes a
// relative or fixture (mkdtempSync-produced, already-absolute) directory
// string directly into collectStagedFiles(dirs) instead of relying on the
// default.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function listUpFiles(dir) {
  const resolvedDir = resolve(REPO_ROOT, dir);
  let names;
  try {
    names = readdirSync(resolvedDir);
  } catch (err) {
    // Mirrors validate-migrations.mjs's own listSqlFiles: a discovered
    // migration directory that does not exist yet on disk (e.g. a
    // schema-owning tool whose tool.json exists but has not yet run its
    // first `supabase db push` to create supabase/migrations/) stages zero
    // files from it rather than failing the whole run.
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((name) => name.endsWith(".sql") && !name.endsWith("_down.sql"))
    .map((name) => {
      const match = VERSION_RE.exec(name);
      if (!match) {
        throw new Error(
          `${join(resolvedDir, name)}: filename does not start with a <digits>_ version prefix; cannot be ordered for staging`,
        );
      }
      // sourceDir/path store the RESOLVED absolute path, not the original
      // (possibly repo-root-relative) `dir` -- so every downstream consumer
      // (writeStagedDir's copyFileSync, splitAtOwnerDependency's readFileSync)
      // stays correct no matter what process.cwd() is by the time they run.
      return { version: match[1], name, sourceDir: resolvedDir, path: join(resolvedDir, name) };
    });
}

// Collects every up file across `dirs`, sorted by version (ties broken by
// filename for determinism, though the version-collision invariant above
// means a real tie between two DISTINCT files should never occur by the
// time this runs in CI).
export function collectStagedFiles(dirs = discoverMigrationDirs()) {
  const files = dirs.flatMap(listUpFiles);
  files.sort((a, b) => {
    if (a.version !== b.version) return a.version < b.version ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const byName = new Map();
  for (const file of files) {
    const existing = byName.get(file.name);
    if (existing && existing.sourceDir !== file.sourceDir) {
      throw new Error(
        `staging collision: "${file.name}" exists in both ${existing.sourceDir} and ${file.sourceDir}`,
      );
    }
    byName.set(file.name, file);
  }
  return files;
}

// Narrows a staged-file list to only the versions present in `versions`
// (an iterable of version-key strings). Used to build the "already-applied
// per the ledger" subset for the apply-mode drift check -- see this file's
// header comment.
export function filterByVersions(files, versions) {
  const versionSet = versions instanceof Set ? versions : new Set(versions);
  return files.filter((file) => versionSet.has(file.version));
}

// Given the FULL staged-file universe (not a pre-filtered subset) and a
// requested version-key set, returns every requested version with no
// corresponding staged file. A caller-supplied subset that is entirely empty
// is the legitimate cold-ledger case filterByVersions already handles
// silently (no ledger rows yet -- nothing to diff, not an error); a
// NON-empty request that only partially matches is never expected and
// always worth surfacing, since platform-migrations.yml uses --subset-file
// for two different production-sensitive purposes: baseline mode's
// operator-typed version list (Finding 4's baseline/adopt mode -- a typo
// here must not silently produce an incomplete subset the live-parity diff
// then blesses as "empty" for the wrong reason) and apply mode's own
// ledger-read subset (a version recorded in the CLI's remote history table
// with no matching file on disk would mean a migration was applied and then
// renamed or deleted afterward -- also always a real problem, not a
// benign gap).
export function findUnmatchedVersions(files, versions) {
  const requested = versions instanceof Set ? versions : new Set(versions);
  const known = new Set(files.map((file) => file.version));
  return [...requested].filter((version) => !known.has(version));
}

// A staged file "depends on the owner" when its SQL body genuinely INVOKES
// platform.owner() to read its return value -- not merely mentions the
// function's own name. Two things must be stripped before testing, or the
// bootstrap migration that CREATES platform.owner() (20260812140000_platform_owner_bootstrap.sql)
// misclassifies itself as depending on it, which is a real, confirmed bug
// this comment exists to explain: that file's own prose ("the
// `platform.owner()` helper every owner-pinned RLS policy calls") and its
// `revoke all on function platform.owner() from public;` /
// `grant execute on function platform.owner() to ...;` grant statements
// both contain the literal substring "platform.owner(" while never once
// CALLING the function -- a GRANT/REVOKE names a function's signature, it
// does not execute it. Left uncaught, splitAtOwnerDependency() below would
// place the bootstrap file itself into ownerTierAndLater, meaning
// platform-migrations.yml's phase 1 (preOwner) would push a set that never
// creates platform.config at all -- and the owner preflight step (Finding
// 5) that must run between the two phases would then fail immediately with
// "relation platform.config does not exist" on the very first live apply,
// a deadlock, not merely a missed optimization. Found and fixed by tracing
// splitAtOwnerDependency() against the real repository's migration set
// during review, not a hypothetical:
//   1. Strip line comments the same way validate-migrations.mjs's own
//      stripLineComments does, so prose mentions never count.
//   2. Strip `function platform.owner(...)` -- the DECLARATION/grant form
//      (CREATE FUNCTION platform.owner(...), ... ON FUNCTION platform.owner()) --
//      leaving only genuine invocation sites (`(select platform.owner())`,
//      `= platform.owner()`, etc., every one of which lacks the word
//      "function" immediately before "platform").
function stripLineComments(sql) {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function stripOwnerFunctionDeclarations(sql) {
  return sql.replace(/\bfunction\s+platform\s*\.\s*owner\s*\([^)]*\)/gi, "");
}

const OWNER_DEPENDENCY_RE = /platform\s*\.\s*owner\s*\(/i;

function dependsOnOwner(sql) {
  return OWNER_DEPENDENCY_RE.test(stripOwnerFunctionDeclarations(stripLineComments(sql)));
}

// Splits a globally version-sorted staged-file list at the first file whose
// SQL body references platform.owner() -- the start of the owner-repin tier
// and every migration staged after it (Finding 5, independent security
// review, re-verified against current HEAD: "owner re-pin can run before
// its required preflight"). platform-migrations.yml uses this to push
// `preOwner` first, run the live owner preflight (platform.config holds its
// one row, resolving to a confirmed, unbanned auth.users row), and only
// then push `ownerTierAndLater`.
//
// Content-based, not a hardcoded version constant: every migration from the
// first platform.owner() reference onward is written assuming the operator's
// one-time config row already exists (RLS policies, security-definer owner
// gates, and later seed data that reads back `(select platform.owner())` all
// key off it -- see 20260812160000_core_idea_owner_pin.sql's own header
// comment). A hardcoded "everything >= this version" cutoff would silently
// stop being the real boundary the day a new owner-dependent migration lands
// with an unexpected version, or a new owner-independent one lands with a
// version inside the existing owner-tier range; scanning content instead
// stays correct by construction for every migration that will ever exist.
export function splitAtOwnerDependency(files) {
  const idx = files.findIndex((file) => dependsOnOwner(readFileSync(file.path, "utf8")));
  if (idx === -1) return { preOwner: files, ownerTierAndLater: [] };
  return { preOwner: files.slice(0, idx), ownerTierAndLater: files.slice(idx) };
}

// Writes `files` into `<destRoot>/supabase/migrations/`, preserving content
// byte-for-byte (copyFileSync, not a read/rewrite). Returns the migrations
// directory path so callers can point `supabase db push`'s working
// directory at `destRoot`.
export function writeStagedDir(files, destRoot) {
  const migrationsDir = join(destRoot, "supabase", "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  for (const file of files) {
    copyFileSync(file.path, join(migrationsDir, file.name));
  }
  return migrationsDir;
}

function parseSubsetFile(path) {
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
}

function main() {
  const args = process.argv.slice(2);
  const destRoot = args[0];
  if (!destRoot || destRoot.startsWith("--")) {
    console.error(
      "usage: stage-migrations.mjs <dest-dir> [--subset-file <path>] [--stop-before-owner-dependency]",
    );
    process.exit(2);
  }

  const subsetIdx = args.indexOf("--subset-file");
  const stopBeforeOwner = args.includes("--stop-before-owner-dependency");
  if (subsetIdx !== -1 && stopBeforeOwner) {
    console.error("--subset-file and --stop-before-owner-dependency are mutually exclusive");
    process.exit(2);
  }
  if (subsetIdx !== -1 && (!args[subsetIdx + 1] || args[subsetIdx + 1].startsWith("--"))) {
    console.error("--subset-file requires a path");
    process.exit(2);
  }
  const recognized = new Set([destRoot, "--stop-before-owner-dependency"]);
  if (subsetIdx !== -1) {
    recognized.add("--subset-file");
    recognized.add(args[subsetIdx + 1]);
  }
  const unknown = args.find((arg) => !recognized.has(arg));
  if (unknown) {
    console.error(`unknown argument: ${unknown}`);
    process.exit(2);
  }

  const all = collectStagedFiles();
  let files;
  if (stopBeforeOwner) {
    files = splitAtOwnerDependency(all).preOwner;
  } else if (subsetIdx === -1) {
    files = all;
  } else {
    const requested = parseSubsetFile(args[subsetIdx + 1]);
    const unmatched = findUnmatchedVersions(all, requested);
    if (unmatched.length > 0) {
      console.error(
        `--subset-file named ${unmatched.length} version(s) with no matching staged migration file:`,
      );
      for (const version of unmatched) console.error(`  ${version}`);
      process.exit(1);
    }
    files = filterByVersions(all, requested);
  }

  const migrationsDir = writeStagedDir(files, destRoot);
  console.log(`Staged ${files.length} migration(s) into ${migrationsDir}:`);
  for (const file of files) {
    console.log(`  ${file.version}  ${file.name}  (from ${file.sourceDir})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
