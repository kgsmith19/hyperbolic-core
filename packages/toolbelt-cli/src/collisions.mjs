// Collision detection for `tool:new`'s exit-2 case: "id taken in core.app or
// on disk, or the schema collides across manifests" (docs/planning/
// 05-c-toolbelt.md section 5.1). This environment has no live Supabase
// access, so "id taken in core.app" is approximated the only way actually
// checkable without a database connection, spelled out per-check below. This
// is a real, documented limitation -- see the m3-03 implementation report for
// what remains genuinely unverified against a live core.app.
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { findManifestPaths, checkManifestShape, checkSchemaOwnershipUniqueness } from "./manifests-shared.mjs";

// Check 1 (on-disk directory): does apps/toolbelt/apps/<id>/ already exist?
export function toolDirExists(toolbeltRoot, id) {
  return existsSync(join(toolbeltRoot, "apps", id));
}

// Check 2 (manifest id scan): does any discovered tool.json -- including the
// root spine's own apps/toolbelt/tool.json, which is NOT under apps/<id>/ and
// so would be missed by toolDirExists alone -- already declare this id? This
// is the closest on-disk proxy for "id taken in core.app": every real
// registration has a manifest with a matching id (the schema requires
// id === the directory name, but the root spine is the one manifest with no
// apps/<id>/ directory at all, which is exactly why this second check exists
// as a distinct pass rather than being redundant with the first).
export function findManifestIds(toolbeltRoot) {
  const ids = new Map(); // id -> manifest path
  for (const path of findManifestPaths(toolbeltRoot)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // malformed manifests are checkManifestShape's concern, not this CLI's
    }
    if (typeof manifest.id === "string") ids.set(manifest.id, path);
  }
  return ids;
}

// Check 3 (registration migration scan): does apps/toolbelt/supabase/migrations/
// already contain an up migration for this id? Catches the edge case where a
// tool's manifest was removed from disk (or never restored) but its
// registration migration -- and therefore, presumably, its real core.app row
// -- still exists. Excludes *_down.sql files (a down file's own basename ends
// in "_down.sql" before the ".sql" this regex anchors on, so it never
// matches).
const REGISTER_UP_RE = /^\d+_register_(.+)\.sql$/;

export function findRegisteredIdsOnDisk(migrationsDir) {
  const ids = new Set();
  let names;
  try {
    names = readdirSync(migrationsDir);
  } catch {
    return ids;
  }
  for (const name of names) {
    if (!name.endsWith(".sql") || name.endsWith("_down.sql")) continue;
    const match = REGISTER_UP_RE.exec(name);
    if (match) ids.add(match[1]);
  }
  return ids;
}

// Check 4 (schema ownership, TB-5 reused): does the candidate manifest's
// `schemas` array collide with any existing manifest's `schemas` array?
// Reuses checkSchemaOwnershipUniqueness directly (imported via
// manifests-shared.mjs, never reimplemented) by materializing the candidate
// manifest to a real, disposable temp file -- that function's contract is
// "array of manifest file paths on disk", so this is the actual reuse path,
// not a lookalike reimplementation. The temp file is always removed before
// this function returns, success or failure.
export function findSchemaCollisions(toolbeltRoot, candidateManifest) {
  if (!Array.isArray(candidateManifest.schemas) || candidateManifest.schemas.length === 0) return [];

  const tmpDir = mkdtempSync(join(tmpdir(), "toolbelt-cli-schema-check-"));
  try {
    const candidatePath = join(tmpDir, "tool.json");
    writeFileSync(candidatePath, JSON.stringify(candidateManifest));
    const existingPaths = findManifestPaths(toolbeltRoot);
    const failures = checkSchemaOwnershipUniqueness([...existingPaths, candidatePath]);
    // Scope to failures actually attributable to the candidate's own schema
    // names, so a hypothetical pre-existing collision between two OTHER
    // manifests (not this CLI run's doing) is never misreported as caused by
    // this invocation.
    return failures.filter((failure) => candidateManifest.schemas.some((s) => failure.includes(`schema "${s}"`)));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Check 5 (defense in depth): does the candidate manifest itself conform to
// tool.schema.json? A failure here is a generator bug, not user error, but is
// still surfaced through the same exit-2 path rather than crashing -- see
// tests/templates.test.mjs for the positive proof this never fires for any
// real combination of flags this CLI can produce.
export function findShapeFailures(candidateManifest) {
  const tmpDir = mkdtempSync(join(tmpdir(), "toolbelt-cli-shape-check-"));
  try {
    const candidatePath = join(tmpDir, "tool.json");
    writeFileSync(candidatePath, JSON.stringify(candidateManifest));
    return checkManifestShape([candidatePath]).map((f) => `generated manifest failed its own schema check: ${f}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function relativeUnderRoot(root, path) {
  const rel = relative(root, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

// Aggregates every check above. Returns an array of human-readable reasons
// (empty when there is no collision at all). Performs NO filesystem writes
// outside its own short-lived temp files, which are always cleaned up before
// returning -- so a non-empty result here is exactly the exit-2 case with
// zero partial writes, by construction (the real write phase never starts).
export function detectCollisions({ toolbeltRoot, id, candidateManifest }) {
  const reasons = [];

  if (toolDirExists(toolbeltRoot, id)) {
    reasons.push(`apps/toolbelt/apps/${id}/ already exists on disk`);
  }

  const manifestIds = findManifestIds(toolbeltRoot);
  if (manifestIds.has(id)) {
    reasons.push(`id "${id}" is already claimed by ${relativeUnderRoot(toolbeltRoot, manifestIds.get(id))}`);
  }

  const registeredIds = findRegisteredIdsOnDisk(join(toolbeltRoot, "supabase", "migrations"));
  if (registeredIds.has(id)) {
    reasons.push(
      `id "${id}" already has a registration migration under apps/toolbelt/supabase/migrations/ ` +
        "(a matching core.app row may already exist; this cannot be checked directly against a live " +
        "database in this environment, so a matching on-disk registration migration is treated as a collision)",
    );
  }

  reasons.push(...findSchemaCollisions(toolbeltRoot, candidateManifest));
  reasons.push(...findShapeFailures(candidateManifest));

  return reasons;
}
