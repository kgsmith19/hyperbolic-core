/**
 * Persisted config overrides for `brain config set` (m4-13, 07 section
 * 7.8's `brain config [get|set <key> <value>]` verb). A small JSON file
 * under dataDir, one layer below env vars in loadConfig()'s own
 * precedence (env var > override file > built-in default) -- an operator
 * can persist a tweak without editing the container's env, but an
 * explicit env var always wins, matching every other Brain config
 * convention already established (ADR-05's deploy-time env-injection
 * posture is still the primary path; this is a lighter-weight knob layer
 * on top of it, not a replacement).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** The only keys `brain config set` may touch -- the same set
 * config.ts's loadConfig() reads an override for. Deliberately NOT every
 * BrainConfig field (dbPath/kernelRunPath/etc are deploy topology, not
 * operator-tunable policy dials). */
export const SETTABLE_KEYS = ["BRAIN_REPO_ALLOWLIST", "BRAIN_PER_RUN_USD_CEILING", "BRAIN_APPROVAL_TTL_DAYS"] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

export function isSettableKey(key: string): key is SettableKey {
  return (SETTABLE_KEYS as readonly string[]).includes(key);
}

function overridesPath(dataDir: string): string {
  return path.join(dataDir, "config-overrides.json");
}

export function readOverrides(dataDir: string): Partial<Record<SettableKey, string>> {
  const file = overridesPath(dataDir);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<Record<SettableKey, string>>;
  } catch {
    // A corrupted overrides file must never crash the whole daemon at
    // startup (loadConfig() is on the fail-fast path for genuinely
    // missing required config, but this file is optional and additive) --
    // falling back to "no overrides" is the safe default.
    return {};
  }
}

export function writeOverride(dataDir: string, key: SettableKey, value: string): void {
  mkdirSync(dataDir, { recursive: true });
  const current = readOverrides(dataDir);
  const next = { ...current, [key]: value };
  writeFileSync(overridesPath(dataDir), JSON.stringify(next, null, 2));
}
