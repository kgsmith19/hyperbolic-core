// Stateful fake apps/toolbelt/guards/cli.mjs for the guards-page e2e
// (SPEC-0002 AC-010). Sandbox only — shares ACC_GUI_E2E_DIR/guards-state.json
// with fake-engine.e2e.mjs (each owns a different slice of it: this file
// owns enabled/secrets/protected, fake-engine.e2e.mjs owns
// projects/vaultKeys/pending/trashed). Mirrors exactly the verbs/outputs the
// server consumes; nothing here ever touches the real config.json.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.ACC_GUI_E2E_DIR;
const S = path.join(dir, "guards-state.json");
const s = JSON.parse(fs.readFileSync(S, "utf8"));
const save = () => fs.writeFileSync(S, JSON.stringify(s));
const [cmd, arg] = process.argv.slice(2);

if (cmd === "status") {
  console.log(JSON.stringify({ enabled: s.enabled, secrets: s.secrets, protected: s.protected }));
} else if (cmd === "toggle") {
  s.enabled = arg === "on"; save();
  console.log(`guards ${s.enabled ? "ENABLED" : "DISABLED"}`);
} else {
  console.log(`did ${cmd} ${arg ?? ""}`);
}
