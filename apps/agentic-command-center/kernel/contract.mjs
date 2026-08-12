// The task contract: the only thing that grants a run any authority at all.
// An incomplete contract is refused before a harness process exists, because
// a run whose success cannot be checked is not a run worth starting.
import fs from "node:fs";
import { loadKernelPolicy, alwaysDenyWriteRoots, norm, stripBom } from "./policy.mjs";

export const REQUIRED_FIELDS = Object.freeze([
  "goal", "constraints", "allowedActions", "budget", "acceptanceCriteria", "rollbackPlan",
]);
export const VERIFY_METHODS = Object.freeze(["command", "file_exists", "file_contains", "git_clean"]);

const ACTION_KEYS = Object.freeze(["readRoots", "writeRoots", "bashPatterns", "networkHosts", "vaultKeys", "subagents"]);

export function loadContract(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (e) {
    throw new Error(`kernel: contract unreadable: ${file} (${e.message})`);
  }
}

export function validateContract(contract) {
  const errors = [];
  const c = contract || {};
  for (const field of REQUIRED_FIELDS) {
    if (c[field] === undefined || c[field] === null) errors.push(`contract is missing required field "${field}"`);
  }

  const actions = c.allowedActions;
  if (actions && typeof actions === "object") {
    for (const key of ACTION_KEYS) {
      if (actions[key] !== undefined && !Array.isArray(actions[key])) {
        errors.push(`allowedActions.${key} must be an array`);
      }
    }
    // OI-019: norm() (kernel/policy.mjs) is path.resolve() underneath, which
    // throws a TypeError on anything that isn't a string. Two independent,
    // reachable sources of that: a writeRoots entry that isn't a string (the
    // Array.isArray check above never checks element types) and, inside
    // alwaysDenyWriteRoots() itself, a hand-edited/corrupted policy.json
    // extraDenyWriteRoots entry (saveKernelPolicy validates this as a
    // strList before ever writing it, but a direct file edit bypasses that).
    // Left uncaught, either one propagated straight out of validateContract
    // — called from runTask (kernel/run.mjs) with no try/catch around it,
    // crashing the WHOLE kernel process before a single ledger entry
    // existed, worse than any other input this function already refuses
    // cleanly. A contract this function cannot even evaluate is refused,
    // exactly like every other malformed shape here — not a crash.
    try {
      const denied = alwaysDenyWriteRoots();
      for (const root of actions.writeRoots || []) {
        const target = norm(root);
        if (denied.some((d) => target === d || target.startsWith(d + "/") || d.startsWith(target + "/"))) {
          errors.push(`allowedActions.writeRoots entry "${root}" overlaps a protected path — refused before launch`);
        }
      }
    } catch (e) {
      errors.push(`allowedActions.writeRoots or policy extraDenyWriteRoots could not be checked (${e.message})`);
    }
  }

  const criteria = c.acceptanceCriteria;
  if (Array.isArray(criteria)) {
    if (criteria.length === 0) errors.push("acceptanceCriteria is empty — a run whose outcome cannot be checked is refused");
    const seen = new Set();
    for (const [i, crit] of criteria.entries()) {
      const label = crit?.id || `#${i}`;
      if (!crit?.id) errors.push(`acceptance criterion ${label} has no id`);
      else if (seen.has(crit.id)) errors.push(`duplicate acceptance criterion id "${crit.id}"`);
      else seen.add(crit.id);
      if (!crit?.verify?.method) errors.push(`acceptance criterion ${label} has no verify method`);
      else if (!VERIFY_METHODS.includes(crit.verify.method)) {
        errors.push(`acceptance criterion ${label} uses unknown verify method "${crit.verify.method}"`);
      }
    }
  } else if (criteria !== undefined) {
    errors.push("acceptanceCriteria must be an array");
  }

  const caps = loadKernelPolicy().hardCaps;
  const wall = c.budget?.wallClockMin;
  if (Number.isFinite(wall) && wall > caps.wallClockMin) {
    errors.push(`budget.wallClockMin ${wall} exceeds the policy hard cap of ${caps.wallClockMin}`);
  }

  return { ok: errors.length === 0, errors };
}

// The --tools allowlist: a tool the contract grants no authority to does not
// exist for the run at all. This is the structural half of deny-by-default;
// the guardhook enforces the arguments of the tools that remain.
export function toolsFor(contract) {
  const a = contract.allowedActions || {};
  const tools = new Set(loadKernelPolicy().alwaysAllowTools);
  if ((a.readRoots || []).length) ["Read", "Glob", "Grep"].forEach((t) => tools.add(t));
  if ((a.writeRoots || []).length) ["Edit", "Write"].forEach((t) => tools.add(t));
  if ((a.bashPatterns || []).length) tools.add("Bash");
  if ((a.networkHosts || []).length) ["WebFetch", "WebSearch"].forEach((t) => tools.add(t));
  if ((a.subagents || []).length) tools.add("Agent");
  return [...tools];
}
