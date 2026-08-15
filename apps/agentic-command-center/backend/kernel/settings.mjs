// Per-task harness settings, generated from the contract and pinned by hash.
//
// The settings file does exactly two things: it registers the kernel guardhook
// on every tool the contract permits, and it declares the permission mode.
// It carries NO allow/deny lists of its own — decisions are read live from the
// contract and policy on every hook fire, so a GUI edit applies mid-run
// (AC-G9/AC-U2). Freezing decisions into this file would break that.
//
// permissions.defaultMode is bypassPermissions ON PURPOSE: headless runs have
// nobody to answer a prompt, so the built-in permission system can only say
// yes-to-everything or stall. The real boundary is --tools (which tools exist)
// plus the guardhook (which arguments they may carry) — the same doctrine as
// runner/runner.mjs:96-98.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { kernelRoot } from "./policy.mjs";
import { toolsFor } from "./contract.mjs";

const runsRoot = () => path.join(kernelRoot(), "runner", "kernel-runs");
export const runDir = (runId) => path.join(runsRoot(), runId);

// GU-2.1/05-g-guards.md section 5: every generated PreToolUse chain includes
// the shared Guards hook (apps/toolbelt/guards/guard.mjs) alongside the
// kernel's own guardhook, "so the rule surface never differs by launch
// path." apps/toolbelt/guards is a sibling app this repo does not import
// (AGENTS.md) -- resolved by filesystem path only, same non-breaking
// DEFAULT + env-override shape gui/server.mjs's guardsCliPath already
// established. ACC_GUARDS_CLI is already that file's own established name
// for cli.mjs (the status/toggle CLI) -- guardsCliPath below reuses it
// verbatim so both files agree on one override, rather than each having
// its own name for the same script. guard.mjs (the hook script itself) has
// no prior convention to collide with, so it gets its own new name.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const guardMjsPath = () => process.env.ACC_GUARDS_HOOK || path.join(HERE, "..", "..", "..", "toolbelt", "guards", "guard.mjs");
const guardsCliPath = () => process.env.ACC_GUARDS_CLI || path.join(HERE, "..", "..", "..", "toolbelt", "guards", "cli.mjs");

// No GUARDS_CONFIG/GUARDS_PROFILE override is injected into the hook's own
// command here: guard.mjs's own config-loader already resolves the correct
// per-machine overlay with neither set (GUARDS_PROFILE defaults to the
// lowercased hostname, README.md's own documented fallback) -- forcing an
// explicit value here would just recompute the identical default, and would
// diverge from the "same rule surface... never differs by launch path"
// goal the moment interactive registration and this generated one drifted
// out of sync on how they compute it.
export function generateSettings(contract, { guardhookPath }) {
  return {
    permissions: { defaultMode: "bypassPermissions", allow: [], deny: [] },
    hooks: {
      PreToolUse: [
        {
          matcher: toolsFor(contract).join("|"),
          hooks: [{ type: "command", command: `node "${guardhookPath}"`, timeout: 15 }],
        },
        {
          // Matcher fixed at Edit|Write|NotebookEdit|Read (05-g section 5),
          // independent of the contract's own tool allowlist above: this is
          // the SAME rule surface interactive registration already uses
          // (guards/README.md), not a per-contract one.
          matcher: "Edit|Write|NotebookEdit|Read",
          hooks: [{ type: "command", command: `node "${guardMjsPath()}"`, timeout: 15 }],
        },
      ],
    },
  };
}

export function sha256OfFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// "A disabled guard is never silent" (05-g section 5's failure-semantics
// paragraph): queries `guards status` the same way gui/server.mjs's own
// guardsExec already does, purely for run-metadata visibility -- this
// check's own failure or absence never blocks or alters the run itself,
// since guard.mjs's independent fail-closed behavior at decision time is
// the real safety net, not this observability read. Returns null (not
// false) when the status can't be determined, so a caller can tell
// "known disabled" apart from "unknown" rather than conflating the two
// into a false negative.
export function guardsEnabled() {
  try {
    const out = execFileSync(process.execPath, [guardsCliPath(), "status"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    return typeof parsed.enabled === "boolean" ? parsed.enabled : null;
  } catch {
    return null;
  }
}

export function writeRunFiles(contract, { runId, guardhookPath }) {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, "settings.json");
  const contractPath = path.join(dir, "contract.json");
  const pinPath = path.join(dir, "pin.json");
  fs.writeFileSync(settingsPath, JSON.stringify(generateSettings(contract, { guardhookPath }), null, 2));
  fs.writeFileSync(contractPath, JSON.stringify(contract));
  const sha256 = sha256OfFile(settingsPath);
  const guardsStatus = guardsEnabled();
  fs.writeFileSync(pinPath, JSON.stringify({ runId, settingsSha256: sha256, settingsPath, guardsEnabled: guardsStatus }));
  return { dir, settingsPath, contractPath, pinPath, sha256, guardsEnabled: guardsStatus };
}

// Fails closed: an unreadable pin or settings file is a failed check, never a
// pass. Called once before launch (AC-G5) and again on every hook fire (AC-G6).
export function verifySettingsPin(dir) {
  try {
    const pin = JSON.parse(fs.readFileSync(path.join(dir, "pin.json"), "utf8"));
    const actual = sha256OfFile(path.join(dir, "settings.json"));
    return { ok: actual === pin.settingsSha256, expected: pin.settingsSha256, actual };
  } catch (e) {
    return { ok: false, expected: null, actual: null, error: e.message };
  }
}

export function cleanupRun(runId) {
  fs.rmSync(runDir(runId), { recursive: true, force: true });
}
