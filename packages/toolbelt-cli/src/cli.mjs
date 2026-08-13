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
    return 0;
  }

  stdout(`tool:new: generated apps/toolbelt/apps/${options.id}/`);
  for (const path of result.written) {
    stdout(`  created  ${toRepoRelative(toolbeltRoot, path)}`);
  }
  stdout("");
  stdout("Next: supabase db push (step 2/3, from this tool's own directory if it owns a schema)");
  stdout("      then supabase db push from apps/toolbelt/ to apply the registration migration (step 3/3)");
  return 0;
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
