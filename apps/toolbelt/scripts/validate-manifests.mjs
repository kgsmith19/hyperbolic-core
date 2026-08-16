#!/usr/bin/env node
// Validates every tool.json manifest under apps/toolbelt against
// tool.schema.json (docs/planning/05-c-toolbelt.md section 3.2; TB-1a) and
// enforces the global schema-ownership uniqueness invariant (TB-5): no two
// manifests may claim the same string in their own `schemas` array (the
// database schemas that manifest OWNS -- writes DDL for), except the root
// spine's own manifest (apps/toolbelt/tool.json) is allowed to own `core`
// and `idea` together -- the one exception documented in tool.schema.json's
// own "schemas" property description.
//
// `--registry` verifies every manifest against the generated registration
// migration named by lifecycle.register. The migration is the authoritative
// local representation of the core.app row CI can inspect without database
// credentials: its row id, embedded manifest JSON, and manifest_hash must all
// match the manifest on disk.
//
// `--root <dir>` overrides which directory is treated as the toolbelt root
// (apps/toolbelt/apps/*/tool.json are discovered beneath it). Defaults to
// the real apps/toolbelt/ this script lives in. Exists so a fixture tree
// can be validated end-to-end (see tests/validate-manifests.test.mjs and
// the m3-01 report's collision demonstration) without touching real files.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TOOLBELT_ROOT = join(__dirname, "..");
export const SCHEMA_PATH = join(TOOLBELT_ROOT, "tool.schema.json");
// services/<id>/tool.json (tool.schema.json's own documented ownership.path
// exception, 08-llm-handlers.md forced decision 7): a sibling of apps/, not
// nested under apps/toolbelt, so it is discovered separately from
// findManifestPaths's own apps/toolbelt/apps/* walk below. Derived from
// TOOLBELT_ROOT rather than a `root`-relative computation so a fixture
// tree's own unrelated `--root <tmpdir>` (validate-manifests.test.mjs; the
// script's own header comment: "without touching real files") never
// accidentally pulls the real services/ directory into a fixture-scoped
// validation run -- see findManifestPaths/checkManifestCoverage's own
// `servicesRoot` default below, which only resolves to this constant when
// `root` is the real TOOLBELT_ROOT.
export const SERVICES_ROOT = join(TOOLBELT_ROOT, "..", "..", "services");

// A scaffold in flight stages its tool at `<toolDir>.tmp-<token>` and only
// renames it into place once every file is written (packages/toolbelt-cli's
// scaffold.mjs `writePlan`). A concurrent validator must not treat that
// half-built directory as a tool: its tool.json is written before
// backend/supabase/migrations exists, so discovering it makes
// validate-migrations.mjs demand a directory that is still being created.
//
// scaffold.mjs notes that `.tmp-*` names are excluded from every scanner "by
// construction" because the collision regexes require a leading digit run.
// That holds for the staged *files* (`.tmp-<token>-<basename>`), which do
// start with `.tmp-`. It does not hold for the staging *directory*, whose
// name is `<id>.tmp-<token>` — hence this explicit filter.
const STAGING_DIR_RE = /\.tmp-[0-9a-f]+$/;

export function isStagingDir(name) {
  return STAGING_DIR_RE.test(name);
}

function findServiceManifestPaths(servicesRoot) {
  const paths = [];
  if (servicesRoot && existsSync(servicesRoot)) {
    for (const name of readdirSync(servicesRoot).sort()) {
      // Skipped before statSync: a staging directory can be renamed away
      // mid-walk, and stat-ing it would throw ENOENT.
      if (isStagingDir(name)) continue;
      const dir = join(servicesRoot, name);
      if (!statSync(dir).isDirectory()) continue;
      const candidate = join(dir, "tool.json");
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        paths.push(candidate);
      }
    }
  }
  return paths;
}

export function findManifestPaths(root = TOOLBELT_ROOT, { servicesRoot = root === TOOLBELT_ROOT ? SERVICES_ROOT : undefined } = {}) {
  const paths = [];
  const rootManifest = join(root, "tool.json");
  if (existsSync(rootManifest) && statSync(rootManifest).isFile()) {
    paths.push(rootManifest);
  }
  const appsDir = join(root, "apps");
  if (existsSync(appsDir)) {
    for (const name of readdirSync(appsDir).sort()) {
      if (isStagingDir(name)) continue;
      const dir = join(appsDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const candidate = join(dir, "tool.json");
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        paths.push(candidate);
      }
    }
  }
  paths.push(...findServiceManifestPaths(servicesRoot));
  return paths;
}

export function checkManifestCoverage(root = TOOLBELT_ROOT, { servicesRoot = root === TOOLBELT_ROOT ? SERVICES_ROOT : undefined } = {}) {
  const failures = [];
  const rootManifest = join(root, "tool.json");
  if (!existsSync(rootManifest) || !statSync(rootManifest).isFile()) {
    failures.push(`${root}: root spine manifest ${rootManifest} is missing`);
  }

  const appsDir = join(root, "apps");
  if (existsSync(appsDir)) {
    if (!statSync(appsDir).isDirectory()) {
      failures.push(`${appsDir}: expected the apps path to be a directory`);
    } else {
      for (const name of readdirSync(appsDir).sort()) {
        if (isStagingDir(name)) continue;
        const appDir = join(appsDir, name);
        if (!statSync(appDir).isDirectory()) continue;
        const manifestPath = join(appDir, "tool.json");
        if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
          failures.push(`${appDir}: missing tool.json`);
        }
      }
    }
  }

  if (servicesRoot && existsSync(servicesRoot)) {
    for (const name of readdirSync(servicesRoot).sort()) {
      const serviceDir = join(servicesRoot, name);
      if (!statSync(serviceDir).isDirectory()) continue;
      const manifestPath = join(serviceDir, "tool.json");
      if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
        failures.push(`${serviceDir}: missing tool.json`);
      }
    }
  }

  return failures;
}

function loadJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compileValidator(schemaPath) {
  const schema = loadJSON(schemaPath);
  // strict:true plus ajv-formats: without ajv-formats, strict mode throws a
  // hard compile error on the schema's `"format": "hostname"` keyword
  // (unknown format); without strict mode, an unknown format is silently
  // ignored rather than validated, which would make permissions.networkEgress
  // accept malformed hostnames. Verified interactively against this exact
  // schema before wiring this in.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

// TB-1a: every discovered manifest shall conform to tool.schema.json.
export function checkManifestShape(paths, { schemaPath = SCHEMA_PATH } = {}) {
  const validate = compileValidator(schemaPath);
  const failures = [];
  for (const path of paths) {
    let manifest;
    try {
      manifest = loadJSON(path);
    } catch (err) {
      failures.push(`${path}: invalid JSON (${err.message})`);
      continue;
    }
    if (!validate(manifest)) {
      for (const err of validate.errors) {
        const at = err.instancePath || "(root)";
        failures.push(`${path}: ${at} ${err.message}`);
      }
    }
  }
  return failures;
}

// TB-5: no two manifests may declare the same string in their `schemas`
// array. Manifests that fail to parse are skipped here; checkManifestShape
// already reports the parse failure.
//
// The root spine's documented exception (it may own `core` and `idea`
// together, in ROOT_SPINE_EXCEPTION_SCHEMAS) needs no special-case branch
// here: a single manifest contributes at most one Set entry per schema it
// declares, so "root owns core and idea" produces two separate size-1 owner
// sets -- each already unique and skipped by the `length <= 1` guard below.
// Consequently `owningPaths.length > 1` for a given schema name always means
// two or more DISTINCT manifest files are claiming it, which is a genuine
// collision with no legitimate exception, root included.
//
// An earlier version of this function special-cased "root is one of the
// owners" as an additional exemption. Mutation testing proved that branch
// could never legitimately fire true (confirmed empirically: instrumented
// and observed zero firings across the full test suite, including
// validation against every real repository manifest) -- and when mutated,
// it silently let two NON-root manifests collude on an exception-eligible
// schema name ("core"/"idea") with no root manifest involved at all. Removed
// rather than left as dead code that could be miscentered onto in a future
// edit; see "collude on an exception-eligible schema name" below for the
// regression test that pins this down.
export function checkSchemaOwnershipUniqueness(paths) {
  const owners = new Map(); // schema name -> Set(manifest path)
  for (const path of paths) {
    let manifest;
    try {
      manifest = loadJSON(path);
    } catch {
      continue;
    }
    const schemas = Array.isArray(manifest.schemas) ? manifest.schemas : [];
    for (const schemaName of schemas) {
      if (!owners.has(schemaName)) owners.set(schemaName, new Set());
      owners.get(schemaName).add(path);
    }
  }

  const failures = [];
  for (const [schemaName, owningPathsSet] of owners) {
    const owningPaths = [...owningPathsSet].sort();
    if (owningPaths.length <= 1) continue;
    failures.push(
      `schema "${schemaName}" is claimed by ${owningPaths.length} manifests (exactly one owner is required): ${owningPaths.join(", ")}`,
    );
  }
  return failures.sort();
}

export function checkManifestIdUniqueness(paths) {
  const manifestsById = new Map();
  for (const path of paths) {
    let manifest;
    try {
      manifest = loadJSON(path);
    } catch {
      continue;
    }
    if (typeof manifest.id !== "string") continue;
    if (!manifestsById.has(manifest.id)) manifestsById.set(manifest.id, new Set());
    manifestsById.get(manifest.id).add(path);
  }

  const failures = [];
  for (const [id, manifestPathsSet] of manifestsById) {
    const manifestPaths = [...manifestPathsSet].sort();
    if (manifestPaths.length <= 1) continue;
    failures.push(
      `manifest id "${id}" is declared by ${manifestPaths.length} manifests (one core.app row per manifest is required): ${manifestPaths.join(", ")}`,
    );
  }
  return failures.sort();
}

// TB-5: schemas declare DDL/data ownership, while permissions.db.write
// declares the data plane a tool may mutate. A tool may read an owner's
// published schema, but it may only write schemas its own manifest owns.
export function checkDatabaseWritePermissions(paths) {
  const manifests = [];
  const owners = new Map();

  for (const path of paths) {
    let manifest;
    try {
      manifest = loadJSON(path);
    } catch {
      continue;
    }
    manifests.push({ path, manifest });
    const schemas = Array.isArray(manifest.schemas) ? manifest.schemas : [];
    for (const schemaName of schemas) {
      if (!owners.has(schemaName)) owners.set(schemaName, new Set());
      owners.get(schemaName).add(path);
    }
  }

  const failures = [];
  for (const { path, manifest } of manifests) {
    const writes = Array.isArray(manifest?.permissions?.db?.write) ? manifest.permissions.db.write : [];
    for (const schemaName of writes) {
      const schemaOwners = owners.get(schemaName);
      if (!schemaOwners || schemaOwners.size === 0) {
        failures.push(`${path}: declares write permission for schema "${schemaName}" but no manifest owns that schema`);
      } else if (!schemaOwners.has(path)) {
        failures.push(
          `${path}: declares write permission for schema "${schemaName}" owned by ${[...schemaOwners].sort().join(", ")}`,
        );
      }
    }
  }

  return failures.sort();
}

// rootManifestPath remains accepted for call-site compatibility and, when
// root is omitted, identifies the fixture root used for coverage checks.
export function validateAll(paths, { root, rootManifestPath, schemaPath } = {}) {
  const validationRoot = root ?? (rootManifestPath ? dirname(rootManifestPath) : TOOLBELT_ROOT);
  return [
    ...checkManifestCoverage(validationRoot),
    ...checkManifestShape(paths, { schemaPath }),
    ...checkManifestIdUniqueness(paths),
    ...checkSchemaOwnershipUniqueness(paths),
    ...checkDatabaseWritePermissions(paths),
  ];
}

// Canonical JSON (RFC 8785-style: object keys sorted recursively, array
// order preserved, no insignificant whitespace) so the sha256 below is
// stable regardless of on-disk key order or formatting. Whatever process
// later writes core.app.manifest_hash (m3-02's generated registration
// migration, or its scaffold-CLI successor in m3-03) MUST hash manifests
// the same way -- ideally by importing canonicalJSON/manifestHash from this
// module -- or the parity check this enables can never agree.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

export function manifestHash(manifest) {
  return createHash("sha256").update(canonicalJSON(manifest), "utf8").digest("hex");
}

function unescapeSqlString(value) {
  return value.replaceAll("''", "'");
}

function extractRegistryEntry(sql) {
  const insertMatches = sql.match(/insert\s+into\s+core\.app\b/gi) ?? [];
  if (insertMatches.length !== 1) {
    throw new Error(`expected exactly one INSERT INTO core.app statement, found ${insertMatches.length}`);
  }

  const idMatch =
    /insert\s+into\s+core\.app\s*\([^)]*\)\s*values\s*\(\s*'((?:[^']|'')*)'/is.exec(sql);
  if (!idMatch) {
    throw new Error("could not extract the registered core.app.id");
  }

  const manifestAndHashMatch =
    /'((?:[^']|'')*)'\s*::\s*jsonb\s*,\s*'([0-9a-f]{64})'\s*,\s*now\s*\(\s*\)/is.exec(sql);
  if (!manifestAndHashMatch) {
    throw new Error("could not extract adjacent manifest, manifest_hash, and registered_at values");
  }

  let manifest;
  try {
    manifest = JSON.parse(unescapeSqlString(manifestAndHashMatch[1]));
  } catch (err) {
    throw new Error(`embedded manifest is invalid JSON (${err.message})`);
  }

  const updateSetMatch =
    /on\s+conflict\s*\(\s*id\s*\)\s+do\s+update\s+set([\s\S]*?);/i.exec(sql);
  if (!updateSetMatch) {
    throw new Error("registration is not an idempotent ON CONFLICT (id) upsert");
  }
  if (!/\bmanifest\s*=\s*excluded\.manifest\b/i.test(updateSetMatch[1])) {
    throw new Error("upsert does not refresh manifest from excluded.manifest");
  }
  if (!/\bmanifest_hash\s*=\s*excluded\.manifest_hash\b/i.test(updateSetMatch[1])) {
    throw new Error("upsert does not refresh manifest_hash from excluded.manifest_hash");
  }

  return {
    id: unescapeSqlString(idMatch[1]),
    manifest,
    manifestHash: manifestAndHashMatch[2],
  };
}

export function checkRegistryParity(paths, { root = TOOLBELT_ROOT } = {}) {
  const failures = [];
  const migrationsDir = resolve(root, "supabase", "migrations");

  for (const manifestPath of paths) {
    let manifest;
    try {
      manifest = loadJSON(manifestPath);
    } catch {
      continue;
    }

    const register = manifest?.lifecycle?.register;
    if (typeof register !== "string") continue;

    const migrationPath = resolve(migrationsDir, register);
    if (!migrationPath.startsWith(`${migrationsDir}${sep}`)) {
      failures.push(`${manifestPath}: lifecycle.register escapes the registry migration directory: ${register}`);
      continue;
    }
    if (!existsSync(migrationPath) || !statSync(migrationPath).isFile()) {
      failures.push(`${manifestPath}: registration migration ${migrationPath} does not exist`);
      continue;
    }

    let registryEntry;
    try {
      registryEntry = extractRegistryEntry(readFileSync(migrationPath, "utf8"));
    } catch (err) {
      failures.push(`${migrationPath}: invalid registration migration (${err.message})`);
      continue;
    }

    if (registryEntry.id !== manifest.id) {
      failures.push(
        `${migrationPath}: registers core.app.id "${registryEntry.id}" but ${manifestPath} declares "${manifest.id}"`,
      );
    }
    if (canonicalJSON(registryEntry.manifest) !== canonicalJSON(manifest)) {
      failures.push(`${migrationPath}: embedded manifest does not match ${manifestPath}`);
    }

    const expectedHash = manifestHash(manifest);
    if (registryEntry.manifestHash !== expectedHash) {
      failures.push(
        `${migrationPath}: registered manifest_hash ${registryEntry.manifestHash} does not match canonical sha256 ${expectedHash} for ${manifestPath}`,
      );
    }
  }

  return failures.sort();
}

function parseArgs(argv) {
  const args = { registry: false, root: TOOLBELT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--registry") {
      args.registry = true;
    } else if (arg === "--root") {
      i += 1;
      if (i >= argv.length) throw new Error("--root requires a directory argument");
      args.root = argv[i];
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const startedAt = Date.now();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`manifests:check: ${err.message}`);
    process.exit(2);
  }

  const paths = findManifestPaths(args.root);
  if (paths.length === 0) {
    console.error(
      `manifests:check: no tool.json manifests found under ${args.root} ` +
        "(expected at least the root spine's own tool.json).",
    );
    process.exit(1);
  }

  const rootManifestPath = join(args.root, "tool.json");
  const failures = validateAll(paths, { root: args.root, rootManifestPath });
  if (args.registry) {
    failures.push(...checkRegistryParity(paths, { root: args.root }));
  }

  if (failures.length > 0) {
    console.error(`Manifest validation failed (${failures.length} problem${failures.length === 1 ? "" : "s"}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`Manifest validation passed for ${paths.length} manifest${paths.length === 1 ? "" : "s"} (${elapsedMs}ms).`);
  for (const path of paths) {
    console.log(`  - ${relative(process.cwd(), path)}`);
  }

  if (args.registry) {
    console.log("");
    console.log(`Registry parity passed for ${paths.length} manifest${paths.length === 1 ? "" : "s"}.`);
    for (const path of paths) {
      const manifest = loadJSON(path);
      console.log(`  ${String(manifest.id).padEnd(24)} sha256=${manifestHash(manifest)}  ${relative(process.cwd(), path)}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
