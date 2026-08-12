// Fake runner/runner.mjs for the start-work e2e (SPEC-0005). The real runner
// would spawn a real claude; this one only records its argv so the spec can
// prove the GO button's launch actually reached `directive:<id>`, then exits.
// Sandbox only — the record lives in ACC_GUI_E2E_DIR.
import fs from "node:fs";
import path from "node:path";

fs.appendFileSync(
  path.join(process.env.ACC_GUI_E2E_DIR, "runner-calls.jsonl"),
  JSON.stringify(process.argv.slice(2)) + "\n"
);
