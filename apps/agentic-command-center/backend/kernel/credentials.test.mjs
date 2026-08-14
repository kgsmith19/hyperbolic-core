// node --test kernel/credentials.test.mjs  (run from C:\code\guards)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-cred-"));
process.env.ACC_VAULT = path.join(BASE, "vault.json");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");
fs.writeFileSync(process.env.ACC_POLICY, "{}");
fs.writeFileSync(process.env.ACC_VAULT, JSON.stringify({
  ALLOWED_KEY: "sk-live-SENTINEL-VALUE-1", OTHER_KEY: "sk-live-SENTINEL-VALUE-2",
}));

const C = await import("./credentials.mjs");
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("envForKeys returns only the requested keys, for the child env", () => {
  assert.deepEqual(C.envForKeys(["ALLOWED_KEY"]), { ALLOWED_KEY: "sk-live-SENTINEL-VALUE-1" });
  assert.deepEqual(C.envForKeys([]), {});
});

test("envForKeys called with no argument at all defaults to requesting nothing", () => {
  assert.deepEqual(C.envForKeys(), {});
});

test("a key that is not in the vault fails by name, and never asks for a value in chat", () => {
  assert.throws(() => C.envForKeys(["NOPE"]), /NOPE/);
  assert.throws(() => C.envForKeys(["NOPE"]), /Guards GUI/);
});

test("a missing vault file yields no keys rather than throwing on first run", () => {
  const old = process.env.ACC_VAULT;
  process.env.ACC_VAULT = path.join(BASE, "absent.json");
  // requesting a real name against a missing file must fail cleanly by name
  // (the fallback-to-{} path), never an uncaught ENOENT from a raw read
  assert.throws(() => C.envForKeys(["ALLOWED_KEY"]), /ALLOWED_KEY/);
  assert.deepEqual(C.envForKeys([]), {});
  process.env.ACC_VAULT = old;
});
