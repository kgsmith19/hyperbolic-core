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
import { createHash } from "node:crypto";
import { kernelRoot } from "./policy.mjs";
import { toolsFor } from "./contract.mjs";

export const runsRoot = () => path.join(kernelRoot(), "runner", "kernel-runs");
export const runDir = (runId) => path.join(runsRoot(), runId);

export function generateSettings(contract, { guardhookPath }) {
  return {
    permissions: { defaultMode: "bypassPermissions", allow: [], deny: [] },
    hooks: {
      PreToolUse: [{
        matcher: toolsFor(contract).join("|"),
        hooks: [{ type: "command", command: `node "${guardhookPath}"`, timeout: 15 }],
      }],
    },
  };
}

export function sha256OfFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
  fs.writeFileSync(pinPath, JSON.stringify({ runId, settingsSha256: sha256, settingsPath }));
  return { dir, settingsPath, contractPath, pinPath, sha256 };
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
