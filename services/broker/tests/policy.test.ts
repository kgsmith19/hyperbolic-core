import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy, isKnownCaller } from "../src/policy.ts";

function withPolicyFile(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "broker-policy-test-"));
  const path = join(dir, "broker-policy.json");
  writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadPolicy: a valid, contract-conformant document loads and round-trips exactly", () => {
  withPolicyFile(
    JSON.stringify({ "llm-handler": { allowedHosts: ["api.anthropic.com"], vaultKeys: [], maxUsdPerDay: null } }),
    (path) => {
      const policy = loadPolicy(path);
      assert.deepEqual(policy, { "llm-handler": { allowedHosts: ["api.anthropic.com"], vaultKeys: [], maxUsdPerDay: null } });
    },
  );
});

test("loadPolicy: a missing file fails loudly at startup rather than starting with an empty policy", () => {
  assert.throws(() => loadPolicy("/nonexistent/broker-policy.json"), /failed to read broker policy/);
});

test("loadPolicy: invalid JSON fails loudly, never silently treated as an empty policy", () => {
  withPolicyFile("{ not json", (path) => {
    assert.throws(() => loadPolicy(path), /is not valid JSON/);
  });
});

test("loadPolicy: a document that fails the broker contract's own shape check is refused, not started on faith", () => {
  // Negative control exercising @hyperbolic/broker-contract's real
  // validatePolicyDocument, not a hand-rolled duplicate check -- a
  // non-array allowedHosts is exactly the kind of malformed entry the
  // contract module exists to catch.
  withPolicyFile(JSON.stringify({ "llm-handler": { allowedHosts: "not-an-array" } }), (path) => {
    assert.throws(() => loadPolicy(path), /allowedHosts must be an array/);
  });
});

test("loadPolicy: a document that is an array (not an object keyed by caller id) is refused", () => {
  withPolicyFile(JSON.stringify(["llm-handler"]), (path) => {
    assert.throws(() => loadPolicy(path), /must be a JSON object keyed by caller id/);
  });
});

test("isKnownCaller: re-exported unchanged from @hyperbolic/broker-contract -- deny-by-default is a shape question, not reimplemented here", () => {
  const policy = { "llm-handler": { allowedHosts: [], vaultKeys: [], maxUsdPerDay: null } };
  assert.equal(isKnownCaller("llm-handler", policy), true);
  assert.equal(isKnownCaller("never-declared", policy), false);
});
