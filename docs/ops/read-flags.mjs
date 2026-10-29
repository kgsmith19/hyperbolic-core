// Flags-as-code resolver (hyperbolic-core#455).
//
// Operational on/off flags live in ops/flags.json and change by reviewed PR,
// not by a repository-settings write. A key present in the file is
// authoritative. A key absent from the file falls back to the matching repo
// variable (FALLBACK_<FLAG> in the environment), so adopting the file changes
// nothing until a PR sets a key. Only the literal "true" enables a fallback, the
// same rule the old `vars.X == 'true'` gates applied.
//
// A malformed file throws: silently treating a typo as "off" would quietly stop
// a backup, which is worse than a red run.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const KNOWN_FLAGS = ["cloud_ops_enabled", "lifeos_backup_enabled", "platform_backup_enabled", "restic_backup_enabled"];

export function resolveFlags(fileText, env) {
  let parsed;
  try {
    parsed = JSON.parse(fileText);
  } catch (error) {
    throw new Error(`ops/flags.json is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ops/flags.json must be a JSON object of flag names to true or false");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!KNOWN_FLAGS.includes(key)) {
      throw new Error(`ops/flags.json names an unknown flag "${key}"; known flags: ${KNOWN_FLAGS.join(", ")}`);
    }
    if (typeof value !== "boolean") {
      throw new Error(`ops/flags.json flag "${key}" must be true or false, not ${JSON.stringify(value)}`);
    }
  }
  const resolved = {};
  for (const flag of KNOWN_FLAGS) {
    if (Object.hasOwn(parsed, flag)) {
      resolved[flag] = parsed[flag] ? "true" : "false";
    } else {
      resolved[flag] = env[`FALLBACK_${flag.toUpperCase()}`] === "true" ? "true" : "false";
    }
  }
  return resolved;
}

// CLI: `node docs/ops/read-flags.mjs ops/flags.json` prints `flag=value` lines
// for $GITHUB_OUTPUT, and names each flag's source on stderr for the run log.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2] || "ops/flags.json";
  const text = readFileSync(file, "utf8");
  const resolved = resolveFlags(text, process.env);
  const fileKeys = Object.keys(JSON.parse(text));
  for (const flag of KNOWN_FLAGS) {
    const source = fileKeys.includes(flag) ? file : `vars.${flag.toUpperCase()} (absent from ${file})`;
    process.stderr.write(`${flag}=${resolved[flag]} from ${source}\n`);
    process.stdout.write(`${flag}=${resolved[flag]}\n`);
  }
}
