// Shared entry-point plumbing every hook needs identically: resolving the
// repo root, reading the hook JSON off stdin, and telling whether this file
// is the process entry point. Hooks that must re-resolve root PER CALL for
// sandboxed-test isolation stay separate on purpose — see hooks/directive.mjs's
// own comment on why a cached const there would leak one test's ACC_ROOT into
// every later one, hooks/lane.mjs's on why it deliberately does NOT key off
// ACC_ROOT at all, and runner/runner.mjs's on why it anchors at runner/ under
// its own ACC_RUNNER_ROOT instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRoot(here) {
  return process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(here, "..");
}

/** Parse a JSON file, or hand back `dflt` if it is missing or malformed.
 *  The on-disk sibling of readStdinJson below: same swallow-and-default
 *  contract, because a hook that dies on a corrupt state file is worse than
 *  one that starts from the default.
 *
 *  A leading BOM is stripped rather than treated as malformed. policy.json is
 *  hand-edited on Windows, where several editors add one, and a BOM would
 *  otherwise make JSON.parse throw and silently hand back the default -- i.e.
 *  every policy dial reverting to its built-in value with no error anywhere.
 *  Six readers of that file each carried this same strip; this is the one
 *  they can share. */
export function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return dflt;
  }
}

export function readStdinJson(dflt = {}) {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return dflt;
  }
}

// True only when this file is the process entrypoint. Compare resolved paths
// on both sides: a bare fileURLToPath() left unresolved against a resolved
// argv[1] can disagree on some platforms, and `node -e` leaves argv[1] absent
// entirely (path.resolve("") is truthy, so this must check argv[1] first). No
// try/catch: every call site passes import.meta.url, always a valid file://
// URL, so fileURLToPath can't throw here — an unreachable catch is exactly
// what covgate's branch floor exists to flag (see lane.mjs's
// retryTransport comments for the two prior times this repo hit the same
// thing and removed the guard instead of testing around it).
export function isMainModule(url) {
  return !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(url));
}
