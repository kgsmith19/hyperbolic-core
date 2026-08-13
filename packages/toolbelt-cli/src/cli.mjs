// tool:new's process-facing entry point: parse argv, validate, run the
// scaffold pipeline, print results, return an exit code. bin/tool.mjs is a
// thin wrapper that calls main() with real process.argv/console and sets
// process.exitCode -- kept separate so tests can call main() directly with
// captured output instead of spawning a subprocess every time.
import { join, relative, sep } from "node:path";
import { ArgError, parseArgs, validateOptions, USAGE } from "./args.mjs";
import { DEFAULT_TOOLBELT_ROOT } from "./paths.mjs";
import { runScaffold } from "./scaffold.mjs";

// fsImpl is an internal, undocumented passthrough to runScaffold/writePlan
// (see src/scaffold.mjs), used only by this package's own tests to inject a
// write-phase failure without real filesystem trickery (permission bits are
// unreliable to test against when running as root, which this sandbox
// does). Production callers (bin/tool.mjs) never pass it.
export function main(argv, { stdout = console.log, stderr = console.error, fsImpl } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      stderr(`tool:new: ${err.message}`);
      stderr(USAGE);
      return 2;
    }
    throw err;
  }

  const toolbeltRoot = options.toolbeltRootOverride || DEFAULT_TOOLBELT_ROOT;

  const validationErrors = validateOptions(options);
  if (validationErrors.length > 0) {
    stderr("tool:new: invalid arguments:");
    for (const e of validationErrors) stderr(`  - ${e}`);
    stderr(USAGE);
    return 2;
  }

  let result;
  try {
    result = runScaffold(options, { toolbeltRoot, dryRun: options.dryRun, fsImpl });
  } catch (err) {
    // Only an unexpected I/O failure during the write phase reaches here
    // (ordinary collisions return a result object, they never throw).
    // writePlan has already rolled back everything it wrote by the time this
    // catch runs -- see src/scaffold.mjs's writePlan.
    stderr(`tool:new: unexpected error while writing files (rolled back, nothing left behind): ${err.message}`);
    return 1;
  }

  if (!result.ok) {
    stderr(`tool:new: cannot generate apps/toolbelt/apps/${options.id}/ (exit 2):`);
    for (const reason of result.reasons) stderr(`  - ${reason}`);
    return 2;
  }

  if (result.dryRun) {
    stdout(`tool:new --dry-run: plan for apps/toolbelt/apps/${options.id}/ (nothing written)`);
    for (const file of result.plan.files) {
      stdout(`  would create  ${toRepoRelative(toolbeltRoot, file.path)}`);
    }
    stdout("");
    printLiveRegistryCaveat(stdout);
    return 0;
  }

  stdout(`tool:new: generated apps/toolbelt/apps/${options.id}/`);
  for (const path of result.written) {
    stdout(`  created  ${toRepoRelative(toolbeltRoot, path)}`);
  }
  stdout("");
  printLiveRegistryCaveat(stdout);
  stdout("");
  stdout("Next: supabase db push (step 2/3, from this tool's own directory if it owns a schema)");
  stdout("      then supabase db push from apps/toolbelt/ to apply the registration migration (step 3/3)");
  return 0;
}

// Finding 29 (independent security review of this repo, re-verified against
// current HEAD): "A DB-only existing app passes filesystem checks and
// generated upsert can overwrite it. Query an authoritative registry/signed
// snapshot before writes or narrow the acceptance contract explicitly."
//
// src/collisions.mjs's own module-level comment has always documented this
// honestly for a future maintainer reading the source: "This environment
// has no live Supabase access, so 'id taken in core.app' is approximated
// the only way actually checkable without a database connection... This is
// a real, documented limitation." The gap Finding 29 identifies is narrower
// than the underlying limitation itself: that source comment was never
// surfaced to the actual operator running `tool:new` and reading its exit-0
// output -- only to someone who happens to read collisions.mjs's source
// afterward. Wiring a live Supabase connection into a local scaffolding CLI
// would be a substantial, out-of-proportion architectural change for this
// finding, and cuts against this repo's established local-first,
// credentials-stay-local posture (apps/toolbelt/AGENTS.md: "Never commit a
// service-role key"). Per the review's own explicit alternative --
// "narrow the acceptance contract explicitly" -- this prints the same
// honesty level the source comment already has, on every success path
// (dry-run included: a dry-run's "no collision" plan is exactly as
// DB-unverified as a real scaffold's), so an operator relying on the exit
// code alone cannot miss it.
function printLiveRegistryCaveat(stdout) {
  stdout(
    "Note: the collision check above is on-disk/manifest-only (id taken on disk, id claimed by an " +
      "existing manifest, id already registered via an on-disk migration, or a schema-ownership " +
      "conflict) -- it does NOT query the live core.app registry, since this environment has no live " +
      "Supabase access. A DB-only existing app with no matching manifest or migration on disk would " +
      "not be caught here. Confirm there is no live-only conflict (e.g. by checking core.app directly) " +
      "before relying on this result.",
  );
}

// toolbeltRoot is conventionally two directories under the repo root
// (<repo>/apps/toolbelt, ADR-01's target tree); this holds for both the real
// tree and every fixture tree this package's own tests construct. Printing
// repo-relative paths matches how every other toolbelt script in this repo
// reports paths (e.g. scripts/validate-manifests.mjs's own console output).
function toRepoRelative(toolbeltRoot, path) {
  const repoRoot = join(toolbeltRoot, "..", "..");
  return relative(repoRoot, path).split(sep).join("/");
}
