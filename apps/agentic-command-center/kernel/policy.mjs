// Kernel dials. Single source: policy.json "kernel". Every getter re-reads the
// file, because the GUI settings tab edits it live and a guardhook fire must
// see the edit on the very next tool call (AC-G9/AC-U2) — never cache.
//
// Unreadable-but-present policy THROWS rather than falling back to defaults:
// the kernel's whole job is enforcing limits, and silently enforcing guessed
// ones is worse than refusing to run. Absent file = defaults, which is the
// first-run case.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

export const policyPath = () => process.env.ACC_POLICY || path.join(REPO, "policy.json");
export const kernelRoot = () => path.resolve(process.env.ACC_ROOT || REPO);
export const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
export const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// harness has no in-code default (null): naming one here would be a
// harness-specific reference living outside kernel/adapters/, which AC-A8
// forbids. The shipped policy.json carries the real default; this null only
// surfaces for a policy file that omits the key entirely, and fails closed
// via kernel/adapter.mjs's name validation.
export const KERNEL_DEFAULTS = Object.freeze({
  harness: null,
  budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
  hardCaps: { wallClockMin: 240 },
  autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
  checkpointMin: 20,
  alwaysAllowTools: ["TodoWrite"],
  extraDenyWriteRoots: [],
});

export function loadKernelPolicy() {
  let raw = {};
  if (fs.existsSync(policyPath())) {
    let parsed;
    try {
      const text = stripBom(fs.readFileSync(policyPath(), "utf8"));
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`kernel policy unreadable: ${policyPath()} (${e.message})`);
    }
    raw = parsed.kernel || {};
  }
  return {
    ...KERNEL_DEFAULTS,
    ...raw,
    budget: { ...KERNEL_DEFAULTS.budget, ...(raw.budget || {}) },
    hardCaps: { ...KERNEL_DEFAULTS.hardCaps, ...(raw.hardCaps || {}) },
    autonomy: { ...KERNEL_DEFAULTS.autonomy, ...(raw.autonomy || {}) },
  };
}

// Written to regardless of contract: the guards repo (kernel code, ledger,
// policy, vault) and the user's whole .claude tree (settings + hook scripts).
// Derived, not literal, so a checkout at another path is still protected.
export function alwaysDenyWriteRoots() {
  return [REPO, path.join(os.homedir(), ".claude"), ...loadKernelPolicy().extraDenyWriteRoots].map(norm);
}

// The GUI's write path (gui/server.mjs). Validation and the atomic write live
// HERE, with the other policy IO — the server carries no business logic.
function req(cond, msg) { if (!cond) throw new Error(`kernel policy: ${msg}`); }
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const strList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim());

export function validateKernelBlock(k) {
  req(k && typeof k === "object", "block must be an object");
  req(typeof k.harness === "string" && k.harness.trim(), "harness must be a non-empty string");
  req(isNum(k.budget?.wallClockMin) && k.budget.wallClockMin > 0, "budget.wallClockMin must be > 0");
  req(Number.isInteger(k.budget?.toolCalls) && k.budget.toolCalls >= 1, "budget.toolCalls must be an integer >= 1");
  req(Number.isInteger(k.budget?.tokens) && k.budget.tokens >= 1, "budget.tokens must be an integer >= 1");
  req(isNum(k.hardCaps?.wallClockMin) && k.hardCaps.wallClockMin > 0, "hardCaps.wallClockMin must be > 0");
  req(isNum(k.checkpointMin) && k.checkpointMin > 0, "checkpointMin must be > 0");
  req(Number.isInteger(k.autonomy?.window) && k.autonomy.window >= 1, "autonomy.window must be an integer >= 1");
  req(isNum(k.autonomy?.rejectRate) && k.autonomy.rejectRate > 0 && k.autonomy.rejectRate <= 1, "autonomy.rejectRate must be in (0, 1]");
  req(isNum(k.autonomy?.factor) && k.autonomy.factor > 0 && k.autonomy.factor <= 1, "autonomy.factor must be in (0, 1]");
  req(Number.isInteger(k.autonomy?.runs) && k.autonomy.runs >= 1, "autonomy.runs must be an integer >= 1");
  req(strList(k.alwaysAllowTools), "alwaysAllowTools must be a list of non-empty strings");
  req(strList(k.extraDenyWriteRoots), "extraDenyWriteRoots must be a list of non-empty strings");
}

export function saveKernelPolicy(block) {
  validateKernelBlock(block);
  const file = policyPath();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`kernel policy: cannot edit ${file} (${e.message})`);
  }
  const pol = JSON.parse(stripBom(text));
  pol.kernel = {
    ...(pol.kernel || {}), // _note and any future keys survive
    harness: block.harness.trim(),
    budget: { wallClockMin: block.budget.wallClockMin, toolCalls: block.budget.toolCalls, tokens: block.budget.tokens },
    hardCaps: { ...((pol.kernel || {}).hardCaps || {}), wallClockMin: block.hardCaps.wallClockMin },
    autonomy: { window: block.autonomy.window, rejectRate: block.autonomy.rejectRate, factor: block.autonomy.factor, runs: block.autonomy.runs },
    checkpointMin: block.checkpointMin,
    alwaysAllowTools: block.alwaysAllowTools.map((s) => s.trim()),
    extraDenyWriteRoots: block.extraDenyWriteRoots.map((s) => s.trim()),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(pol, null, 2));
  fs.renameSync(tmp, file); // atomic on the same volume; no torn policy.json
  return loadKernelPolicy();
}
