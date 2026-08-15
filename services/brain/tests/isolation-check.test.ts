// m4-18 / ADR-05 / BR-3 / II-4: scripts/isolation-check.mjs's own
// verification bullet ("ADR-05 isolation check run in a non-Brain
// context; echo $? is non-zero"), exercised as a real child process
// (execFileSync), not by importing/mocking its internals -- the exit
// code IS the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "isolation-check.mjs");
// Concatenated, not one contiguous literal, so this fake fixture value
// doesn't read as a real Anthropic-key-shaped secret to a static scanner
// (this repo's own Gitleaks PR gate) -- same reasoning as scrubber.test.ts.
const FAKE_KEY_CONTENTS = "sk-ant-" + "fixture-not-a-real-key";

function run(env: NodeJS.ProcessEnv) {
  try {
    execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, stdio: "pipe" });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

test("isolation-check: a non-Brain process context (no secret file mounted at all) exits non-zero -- this IS what every other unit's container observes for real", () => {
  const missingPath = path.join(os.tmpdir(), `brain-secret-does-not-exist-${process.pid}-${Date.now()}`);
  const status = run({ BRAIN_SECRET_FILE: missingPath });
  assert.notEqual(status, 0);
});

test("isolation-check: an unreadable file (permission denied) also exits non-zero, not just a missing one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-secret-"));
  const secretPath = path.join(dir, "anthropic-api-key");
  fs.writeFileSync(secretPath, FAKE_KEY_CONTENTS);
  fs.chmodSync(secretPath, 0o000);
  try {
    // Running as root (common in a CI container) bypasses file mode bits
    // entirely, which would make this assertion meaningless there --
    // skip rather than produce a false pass/fail neither environment
    // actually supports checking.
    if (process.getuid && process.getuid() === 0) {
      return;
    }
    const status = run({ BRAIN_SECRET_FILE: secretPath });
    assert.notEqual(status, 0);
  } finally {
    fs.chmodSync(secretPath, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isolation-check: a real, readable secret file exits 0 -- proving the mechanism actually reads, not just always fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-secret-"));
  const secretPath = path.join(dir, "anthropic-api-key");
  fs.writeFileSync(secretPath, FAKE_KEY_CONTENTS);
  try {
    const status = run({ BRAIN_SECRET_FILE: secretPath });
    assert.equal(status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isolation-check: an empty file is treated as unreadable (never a false 'isolation broken' read of nothing)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-secret-"));
  const secretPath = path.join(dir, "anthropic-api-key");
  fs.writeFileSync(secretPath, "");
  try {
    const status = run({ BRAIN_SECRET_FILE: secretPath });
    assert.notEqual(status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
