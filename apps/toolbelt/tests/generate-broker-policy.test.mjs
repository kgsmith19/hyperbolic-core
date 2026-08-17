import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { findManifestPaths } from "../scripts/validate-manifests.mjs";
import { generateBrokerPolicy, policyEntryFor } from "../scripts/generate-broker-policy.mjs";
import { validatePolicyDocument } from "@hyperbolic/broker-contract";

// Mirrors validate-manifests.test.mjs's own baseManifest/withFixtureRoot
// pattern -- same fixture shape, same scratch-tree mechanics, reused rather
// than reinvented.
function baseManifest(overrides = {}) {
  return {
    id: "sample-tool",
    name: "Sample Tool",
    kind: "cli",
    version: "0.1.0",
    ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt/apps/sample-tool" },
    entry: { cli: { command: "python3 -m sample_tool" } },
    schemas: [],
    permissions: {
      db: { read: [], write: [] },
      networkEgress: [],
      llmHandler: { access: false },
    },
    lifecycle: { migrate: "supabase db push", health: "python3 -m sample_tool --health", register: "pending" },
    ...overrides,
  };
}

function withFixtureRoot(layout, fn) {
  const dir = mkdtempSync(join(tmpdir(), "broker-policy-fixture-"));
  try {
    for (const [relPath, contents] of Object.entries(layout)) {
      const fullPath = join(dir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("policyEntryFor: a caller with no networkEgress entry gets zero hosts, not a crash or an omitted field", () => {
  const manifest = baseManifest({ permissions: { db: { read: [], write: [] }, llmHandler: { access: false } } });
  assert.deepEqual(policyEntryFor(manifest), { allowedHosts: [], vaultKeys: [], maxUsdPerDay: null });
});

test("policyEntryFor: extracts networkEgress, vaultKeys, and maxUsdPerDay when declared", () => {
  const manifest = baseManifest({
    permissions: {
      db: { read: [], write: [] },
      networkEgress: ["api.anthropic.com", "api.openai.com"],
      vaultKeys: ["LLM_KEYS_OPENAI", "LLM_KEYS_ANTHROPIC"],
      llmHandler: { access: true, maxUsdPerDay: 5 },
    },
  });
  assert.deepEqual(policyEntryFor(manifest), {
    allowedHosts: ["api.anthropic.com", "api.openai.com"],
    vaultKeys: ["LLM_KEYS_ANTHROPIC", "LLM_KEYS_OPENAI"],
    maxUsdPerDay: 5,
  });
});

test("policyEntryFor: array fields are sorted regardless of declaration order -- determinism, not just presence", () => {
  const manifest = baseManifest({
    permissions: {
      db: { read: [], write: [] },
      networkEgress: ["z.example.com", "a.example.com"],
      vaultKeys: ["Z_KEY", "A_KEY"],
      llmHandler: { access: false },
    },
  });
  const entry = policyEntryFor(manifest);
  assert.deepEqual(entry.allowedHosts, ["a.example.com", "z.example.com"]);
  assert.deepEqual(entry.vaultKeys, ["A_KEY", "Z_KEY"]);
});

test("generateBrokerPolicy: aggregates multiple discovered manifests, keyed by id", () => {
  withFixtureRoot(
    {
      "tool.json": baseManifest({ id: "root-spine", kind: "headless", entry: { headless: { command: "noop" } } }),
      "apps/tool-a/tool.json": baseManifest({
        id: "tool-a",
        ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt/apps/tool-a" },
        permissions: { db: { read: [], write: [] }, networkEgress: ["a.example.com"], llmHandler: { access: false } },
      }),
    },
    (dir) => {
      const policy = generateBrokerPolicy(findManifestPaths(dir));
      assert.deepEqual(Object.keys(policy), ["root-spine", "tool-a"]);
      assert.deepEqual(policy["tool-a"].allowedHosts, ["a.example.com"]);
      assert.deepEqual(policy["root-spine"], { allowedHosts: [], vaultKeys: [], maxUsdPerDay: null });
    },
  );
});

test("generateBrokerPolicy: a malformed tool.json fails loudly rather than producing a partial policy", () => {
  withFixtureRoot(
    {
      "tool.json": baseManifest({ id: "root-spine", kind: "headless", entry: { headless: { command: "noop" } } }),
      "apps/broken/tool.json": "{ not json",
    },
    (dir) => {
      assert.throws(() => generateBrokerPolicy(findManifestPaths(dir)), /invalid JSON/);
    },
  );
});

test("generateBrokerPolicy: a manifest with no id fails loudly rather than being silently skipped", () => {
  withFixtureRoot(
    {
      "tool.json": baseManifest({ id: "root-spine", kind: "headless", entry: { headless: { command: "noop" } } }),
      "apps/no-id/tool.json": baseManifest({ id: undefined }),
    },
    (dir) => {
      assert.throws(() => generateBrokerPolicy(findManifestPaths(dir)), /missing a string "id"/);
    },
  );
});

test("generateBrokerPolicy: two manifests claiming the same id is refused as an ambiguous policy, not silently merged or last-write-wins", () => {
  withFixtureRoot(
    {
      "tool.json": baseManifest({ id: "root-spine", kind: "headless", entry: { headless: { command: "noop" } } }),
      "apps/tool-a/tool.json": baseManifest({ id: "dupe" }),
      "apps/tool-b/tool.json": baseManifest({ id: "dupe" }),
    },
    (dir) => {
      assert.throws(() => generateBrokerPolicy(findManifestPaths(dir)), /already claimed by another manifest/);
    },
  );
});

test("generateBrokerPolicy: regenerating from the same inputs is idempotent -- byte-identical output", () => {
  withFixtureRoot(
    {
      "tool.json": baseManifest({ id: "root-spine", kind: "headless", entry: { headless: { command: "noop" } } }),
      "apps/tool-a/tool.json": baseManifest({
        id: "tool-a",
        ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt/apps/tool-a" },
        permissions: { db: { read: [], write: [] }, networkEgress: ["b.example.com", "a.example.com"], llmHandler: { access: false } },
      }),
    },
    (dir) => {
      const first = JSON.stringify(generateBrokerPolicy(findManifestPaths(dir)));
      const second = JSON.stringify(generateBrokerPolicy(findManifestPaths(dir)));
      assert.equal(first, second);
    },
  );
});

test("generateBrokerPolicy: the generated document always validates against the broker contract", () => {
  withFixtureRoot(
    {
      "tool.json": baseManifest({ id: "root-spine", kind: "headless", entry: { headless: { command: "noop" } } }),
      "apps/tool-a/tool.json": baseManifest({
        id: "tool-a",
        ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt/apps/tool-a" },
        permissions: {
          db: { read: [], write: [] },
          networkEgress: ["a.example.com"],
          vaultKeys: ["SOME_KEY"],
          llmHandler: { access: true, maxUsdPerDay: 3 },
        },
      }),
    },
    (dir) => {
      const policy = generateBrokerPolicy(findManifestPaths(dir));
      assert.deepEqual(validatePolicyDocument(policy), { ok: true, errors: [] });
    },
  );
});

test("generateBrokerPolicy: an undiscovered caller is simply absent, never a stub entry -- deny-by-default at the source", () => {
  withFixtureRoot(
    { "tool.json": baseManifest({ id: "root-spine", kind: "headless", entry: { headless: { command: "noop" } } }) },
    (dir) => {
      const policy = generateBrokerPolicy(findManifestPaths(dir));
      assert.equal(Object.prototype.hasOwnProperty.call(policy, "never-declared"), false);
    },
  );
});

test("generateBrokerPolicy against the real repository: every real manifest gets an entry, and the result validates", () => {
  const policy = generateBrokerPolicy(findManifestPaths());
  assert.ok(Object.keys(policy).length >= 6, "expected at least the 6 manifests validate-manifests.mjs itself discovers");
  assert.ok("llm-handler" in policy, "llm-handler's real tool.json should be discovered");
  assert.deepEqual(validatePolicyDocument(policy), { ok: true, errors: [] });
});
