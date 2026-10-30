import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { CLI_PACKAGE_ROOT, REPO_ROOT } from "../src/paths.mjs";
import { REPO_ROOT as MANIFEST_TOOLS_REPO_ROOT } from "../src/manifests-shared.mjs";

// The CLI and the manifest validators each derive the repo root from their own
// file location. They must agree, or scaffolding would validate a different
// tree than the one it writes into.
test("paths.mjs's REPO_ROOT equals the validators' re-exported REPO_ROOT", () => {
  assert.equal(REPO_ROOT, MANIFEST_TOOLS_REPO_ROOT);
});

// Guards against an equal-but-wrong pair: the shared value must be the real
// repository root, identified by files only it holds.
test("the shared root is the real repository root", () => {
  assert.equal(basename(CLI_PACKAGE_ROOT), "hyp-cli");
  assert.ok(existsSync(join(REPO_ROOT, "tool.json")), "expected the spine tool.json at the repo root");
  assert.ok(existsSync(join(REPO_ROOT, "packages", "manifest-tools", "tool.schema.json")), "expected the manifest schema under packages/manifest-tools");
});
