// Shared by guard.mjs and cli.mjs: resolves which config file(s) govern this
// machine and merges them. Design: docs/planning/05-g-guards.md section 3a.
//
// The tracked base config.json keeps the portable fields (enabled, secrets
// -- the parts that don't vary by machine). Machine-specific fields
// (runboxDir, protected, repos) live in a tracked overlay file
// config.<profile>.json colocated with it, where <profile> is GUARDS_PROFILE
// if set, else the lowercased hostname. GUARDS_CONFIG keeps its pre-existing
// meaning unchanged: an absolute pointer to one fully-resolved config,
// bypassing profile resolution entirely, so every existing caller (tests, a
// runner's subprocess calls) is unaffected.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const resolveProfile = (env = process.env) => env.GUARDS_PROFILE || os.hostname().toLowerCase();

// basePath/overlayPath resolve to the SAME file when GUARDS_CONFIG is set
// ("single"): every field, portable or not, is read from and written to
// that one file, exactly as before this module existed -- GUARDS_CONFIG
// takes priority over profile resolution, not the other way around.
export function resolveConfigPaths(here, env = process.env) {
  if (env.GUARDS_CONFIG) return { basePath: env.GUARDS_CONFIG, overlayPath: env.GUARDS_CONFIG, single: true };
  return {
    basePath: path.join(here, "config.json"),
    overlayPath: path.join(here, `config.${resolveProfile(env)}.json`),
    single: false,
  };
}

// Shallow merge, overlay keys over base keys. Base must exist and parse --
// an unreadable/malformed base throws so callers fail closed on it, same as
// today. A missing overlay silently merges as {}: base-only fails safe
// because the secret globs -- the read-blocking check -- live in the base;
// only the machine-specific protected/repos rules go quiet on an
// unrecognized machine, an explicit, accepted tradeoff (05-g section 3a).
export function loadConfig(here, env = process.env) {
  const { basePath, overlayPath, single } = resolveConfigPaths(here, env);
  let base;
  try {
    base = JSON.parse(readFileSync(basePath, "utf8"));
  } catch (e) {
    throw new Error(`${basePath}: ${e.message}`);
  }
  if (single || !existsSync(overlayPath)) return base;
  try {
    return { ...base, ...JSON.parse(readFileSync(overlayPath, "utf8")) };
  } catch (e) {
    throw new Error(`${overlayPath}: ${e.message}`);
  }
}
