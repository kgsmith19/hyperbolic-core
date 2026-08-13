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
// `core.app.manifest_hash`) and, as of Finding 42 (independent security
// review, re-verified against current HEAD), actually queries the live
// `core.app` table over PostgREST and fails (non-zero exit) on any
// missing/extra/route/lifecycle/hash mismatch -- `core.app.manifest_hash`
// now exists (20260812230000_core_app_registry_extension.sql), which is
// exactly what this mode's own prior comment said it was waiting on; the
// old behavior (compute and print the hash, never compare, always exit 0)
// was a successful-looking stub that verified nothing.
//
// One real constraint this fix has to be honest about: core.app is NOT
// anon-key readable. 20260812160000_core_idea_owner_pin.sql re-pinned its
// RLS policy from "any authenticated caller" to "only the configured
// platform owner" (`for all to authenticated using ((select auth.uid()) =
// (select platform.owner()))`) -- an anonymous PostgREST caller, or any
// non-owner authenticated caller, gets a real 200 response with ZERO rows
// (RLS filters, it does not error), not an access-denied signal. This
// script therefore accepts an owner-authenticated bearer token via the
// TOOLBELT_OWNER_TOKEN environment variable (the same variable
// `TOOLBELT_OWNER_TOKEN` toolbelt-ci.yml's other steps already thread
// through for the identical reason) and falls back to the anon key itself
// as the bearer when unset -- which authenticates as `anon`, not
// `authenticated`, and will observably return zero rows under current RLS.
// compareRegistry() below treats a zero-row response together with a
// non-empty local manifest set as a distinct, explicitly-labeled condition
// ("likely RLS-filtered, not confirmed-empty") rather than silently
// asserting every registered id is missing -- still a real failure (this
// run could not confirm the registry matches, which is the honest thing to
// fail loudly on either way), just not a misleading one.
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
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.mjs";

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

// Finding 42: the real network half of --registry. A thin wrapper around
// `fetch` -- no HTTP client dependency, matching this repo's
// "dependency-free unless a concrete need" convention and the exact
// raw-fetch pattern packages/platform-client/src/registry.ts and
// apps/toolbelt/tests/helpers.mjs's own `rest()` already use against this
// same project. `Accept-Profile: core` is required for PostgREST to select
// the `core` schema at all (core.app is not in the `public` schema); see
// tests/helpers.mjs's identical header. Separately exported (not inlined
// into main()) so tests can call it directly against a fixture server, and
// so main() can be tested with a fake implementation swapped in.
export async function fetchRegistryRows({
  supabaseUrl = SUPABASE_URL,
  anonKey = SUPABASE_ANON_KEY,
  token,
  fetchImpl = fetch,
} = {}) {
  const base = supabaseUrl.replace(/\/+$/, "");
  const url = `${base}/rest/v1/app?select=id,manifest_hash,route,kind,version,status`;
  const res = await fetchImpl(url, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token || anonKey}`,
      "Accept-Profile": "core",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`registry fetch failed: HTTP ${res.status} ${res.statusText} -- ${body.slice(0, 500)}`);
  }
  return res.json();
}

// Finding 42: the actual missing/extra/route/lifecycle/hash comparison
// --registry's own prior comment promised once core.app.manifest_hash
// existed. Pure (manifests + remote rows in, problem strings out) so it is
// fully unit-testable against a mocked/fixture response, independent of
// fetchRegistryRows's real network call -- see
// tests/validate-manifests.test.mjs's Finding 42 cases.
//
// "route" is this schema's own name for what the review calls "path" (the
// Shell route prefix a `ui`-kind tool claims, tool.schema.json's
// `entry.ui.route`; null for cli/headless/hybrid-with-no-ui). "lifecycle"
// is read as the two core.app columns actually derived from a manifest's
// own top-level `kind`/`version` fields (the manifest's `lifecycle` block
// itself -- migrate/health/register commands -- has no core.app column of
// its own to drift against; nothing in this table stores those verbatim).
export function compareRegistry(manifests, remoteRows) {
  const problems = [];
  const remoteById = new Map(remoteRows.map((row) => [row.id, row]));
  const localIds = new Set(manifests.map((m) => m.id));

  if (remoteRows.length === 0 && manifests.length > 0) {
    problems.push(
      "the registry query returned ZERO rows while local manifests exist -- core.app's RLS policy " +
        "(20260812160000_core_idea_owner_pin.sql) restricts reads to the configured platform owner's own " +
        "authenticated caller, so an anon-key-only or non-owner request returns 200 with an empty array, " +
        "not an error. This is either a genuinely empty registry or (far more likely in CI) a missing/" +
        "invalid TOOLBELT_OWNER_TOKEN -- treat every 'missing' entry below as INCONCLUSIVE, not confirmed, " +
        "until that is ruled out.",
    );
  }

  for (const manifest of manifests) {
    const remote = remoteById.get(manifest.id);
    if (!remote) {
      problems.push(`${manifest.id}: registered locally (tool.json on disk) but MISSING from the live registry (core.app)`);
      continue;
    }
    const expectedHash = manifestHash(manifest);
    if (remote.manifest_hash !== expectedHash) {
      problems.push(`${manifest.id}: manifest_hash mismatch -- local=${expectedHash} remote=${remote.manifest_hash ?? "<null>"}`);
    }
    const expectedRoute = manifest.entry?.ui?.route ?? null;
    const remoteRoute = remote.route ?? null;
    if (remoteRoute !== expectedRoute) {
      problems.push(`${manifest.id}: route (path) mismatch -- local=${expectedRoute ?? "<null>"} remote=${remoteRoute ?? "<null>"}`);
    }
    if (remote.kind !== manifest.kind) {
      problems.push(`${manifest.id}: kind (lifecycle) mismatch -- local=${manifest.kind} remote=${remote.kind}`);
    }
    if (remote.version !== manifest.version) {
      problems.push(`${manifest.id}: version (lifecycle) mismatch -- local=${manifest.version} remote=${remote.version}`);
    }
  }

  for (const remote of remoteRows) {
    if (!localIds.has(remote.id)) {
      problems.push(`${remote.id}: registered in the live registry (core.app) but has no corresponding tool.json manifest on disk (extra)`);
    }
  }

  return problems;
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

async function main() {
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
    const manifests = paths.map((path) => loadJSON(path));
    for (let i = 0; i < paths.length; i += 1) {
      const manifest = manifests[i];
      console.log(`  ${String(manifest.id).padEnd(24)} sha256=${manifestHash(manifest)}  ${relative(process.cwd(), paths[i])}`);
    }

    console.log("");
    console.log(`Querying the live registry: ${SUPABASE_URL}/rest/v1/app (core.app) ...`);
    const token = process.env.TOOLBELT_OWNER_TOKEN;
    if (!token) {
      console.log(
        "  note: TOOLBELT_OWNER_TOKEN is not set -- falling back to the anon key as the bearer token, " +
          "which authenticates as `anon`, not the platform owner. core.app's RLS policy " +
          "(20260812160000_core_idea_owner_pin.sql) restricts reads to the owner's own authenticated " +
          "caller, so this will very likely return zero rows regardless of the live registry's real " +
          "contents -- set TOOLBELT_OWNER_TOKEN for a meaningful comparison.",
      );
    }

    let remoteRows;
    try {
      remoteRows = await fetchRegistryRows({ token });
    } catch (err) {
      console.error(`  registry fetch failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  received ${remoteRows.length} row${remoteRows.length === 1 ? "" : "s"} from core.app`);

    const problems = compareRegistry(manifests, remoteRows);
    if (problems.length > 0) {
      console.error("");
      console.error(`--registry comparison failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log("");
    console.log(`--registry comparison passed: every manifest's local hash/route/kind/version matches its live core.app row.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`manifests:check: unexpected error: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
