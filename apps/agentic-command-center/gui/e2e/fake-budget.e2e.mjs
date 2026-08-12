// Fake hooks/budget.mjs for the spending-tab e2e (SPEC-0004). Records its argv
// to ACC_GUI_E2E_DIR/budget-calls.jsonl so a spec can assert the control wired
// to the right verb. Sandbox only — no console is ever typed into.
import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.ACC_GUI_E2E_DIR, "budget-calls.jsonl"), JSON.stringify(a) + "\n");
// Mirror the one real side effect a spec observes: `unstop` clears the
// slice-runner stop-file, so the page's stopState flips back after Resume.
if (a[0] === "unstop") {
  try { fs.rmSync(path.join(process.env.ACC_ROOT, "runner", "stop", "slice-runner.stop")); } catch {}
}
console.log("budget " + a.join(" ") + " ok");
