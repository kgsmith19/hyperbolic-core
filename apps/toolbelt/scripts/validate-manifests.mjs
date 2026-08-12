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
// `--registry` additionally prints each manifest's canonical sha256 (the
// same hash docs/planning/05-c-toolbelt.md section 4.2 calls
// `core.app.manifest_hash`). That registry column does not exist yet -- it
// is added by m3-02-feat-toolbelt-registry-extension.md -- so this mode
// cannot yet fetch a row to compare against; see the printed note. It does
// not open a database connection at all in this milestone.
//
// `--root <dir>` overrides which directory is treated as the toolbelt root
// (apps/toolbelt/apps/*/tool.json are discovered beneath it). Defaults to
// the real apps/toolbelt/ this script lives in. Exists so a fixture tree
// can be validated end-to-end (see tests/validate-manifests.test.mjs and
// the m3-01 report's collision demonstration) without touching real files.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TOOLBELT_ROOT = join(__dirname, "..");
export const SCHEMA_PATH = join(TOOLBELT_ROOT, "tool.schema.json");

// The one documented exception (tool.schema.json's "schemas" property
// description): the root spine's own manifest may own `core` and `idea`
// together.
const ROOT_SPINE_EXCEPTION_SCHEMAS = new Set(["core", "idea"]);

export function findManifestPaths(root = TOOLBELT_ROOT) {
  const paths = [];
  const rootManifest = join(root, "tool.json");
  if (existsSync(rootManifest) && statSync(rootManifest).isFile()) {
    paths.push(rootManifest);
  }
  const appsDir = join(root, "apps");
  if (existsSync(appsDir)) {
    for (const name of readdirSync(appsDir).sort()) {
      const dir = join(appsDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const candidate = join(dir, "tool.json");
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        paths.push(candidate);
      }
    }
  }
  return paths;
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

// rootManifestPath is accepted for call-site compatibility (main() and
// existing callers pass it) but is no longer consulted: see
// checkSchemaOwnershipUniqueness's own comment for why the root spine's
// exception needs no runtime check.
export function validateAll(paths, { rootManifestPath, schemaPath } = {}) {
  void rootManifestPath;
  return [...checkManifestShape(paths, { schemaPath }), ...checkSchemaOwnershipUniqueness(paths)];
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
  const failures = validateAll(paths, { rootManifestPath });

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
    console.log("--registry: canonical sha256 per manifest (docs/planning/05-c-toolbelt.md section 4.2 manifest_hash)");
    for (const path of paths) {
      const manifest = loadJSON(path);
      console.log(`  ${String(manifest.id).padEnd(24)} sha256=${manifestHash(manifest)}  ${relative(process.cwd(), path)}`);
    }
    console.log("");
    console.log(
      "Registry comparison not yet available: core.app.manifest_hash does not exist until " +
        "m3-02-feat-toolbelt-registry-extension.md extends core.app. This mode computes and prints " +
        "the canonical hash above but does not connect to any database in this milestone; once the " +
        "column exists, it will fetch each registered row and fail on a mismatch against the hash above.",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
