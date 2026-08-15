// Task-scoped credentials. The contract lists key NAMES; this module is the
// only place values exist, and the only thing it does with them is hand them
// to a child process environment. They never touch disk, argv, stdout, or the
// ledger.
//
// "Revoked on task end" means loss of local access: the process holding the
// values dies, and the run's staging directory is removed. A third-party key
// cannot be invalidated server-side from here — that limit is documented
// rather than papered over.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const vaultPath = () => process.env.ACC_VAULT || path.join(REPO, "vault.json");

function readVault() {
  try {
    return JSON.parse(fs.readFileSync(vaultPath(), "utf8"));
  } catch {
    return {}; // absent vault = no keys, which denies rather than grants
  }
}

export function envForKeys(names = []) {
  const vault = readVault();
  const missing = names.filter((k) => !(k in vault));
  if (missing.length) {
    throw new Error(`kernel: vault key(s) not available: ${missing.join(", ")} — the user must add them in the Guards GUI first`);
  }
  return Object.fromEntries(names.map((k) => [k, vault[k]]));
}
