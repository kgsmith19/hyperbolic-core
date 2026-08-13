import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { REPO_ROOT, CLI_PACKAGE_ROOT, DEFAULT_TOOLBELT_ROOT } from "../src/paths.mjs";
import { TOOLBELT_ROOT } from "../src/manifests-shared.mjs";

// manifests-shared.mjs's own header comment states this invariant explicitly:
// "src/paths.mjs's REPO_ROOT is computed independently (via import.meta.url,
// not by importing this constant) and is asserted equal to this module's own
// resolved TOOLBELT_ROOT in tests/paths.test.mjs, so a future repo reshuffle
// that breaks one breaks the other loudly instead of silently resolving to
// the wrong tree." Finding 91 (P2, trivial, independent security review of
// this repo, re-verified against current HEAD): that promised test file did
// not exist (confirmed via `ls packages/toolbelt-cli/tests/`), and no such
// equality assertion existed anywhere in the package. This file is the fix:
// it makes the comment's promise true, and actually guards the invariant it
// describes rather than just correcting the prose.
//
// The two sides are computed via completely independent relative-path
// chains, each resolved from a different file's own import.meta.url:
//   - src/paths.mjs's DEFAULT_TOOLBELT_ROOT: this file's own directory
//     (packages/toolbelt-cli/src) -> up two levels -> REPO_ROOT -> down into
//     apps/toolbelt.
//   - apps/toolbelt/scripts/validate-manifests.mjs's TOOLBELT_ROOT
//     (re-exported here, unmodified, by manifests-shared.mjs): that file's
//     own directory (apps/toolbelt/scripts) -> up one level.
// Both must land on the exact same directory as long as packages/toolbelt-cli
// and apps/toolbelt keep their current positions two levels under the repo
// root (ADR-01's target tree) -- if a future repo reshuffle ever moves one
// without the other, this test fails loudly instead of the two constants
// silently resolving to two different trees.
test("paths.mjs's DEFAULT_TOOLBELT_ROOT equals manifests-shared.mjs's re-exported TOOLBELT_ROOT", () => {
  assert.equal(DEFAULT_TOOLBELT_ROOT, TOOLBELT_ROOT);
});

// Guards against a degenerate "both sides are equal only because both are
// wrong" false pass: confirm the shared value is actually apps/toolbelt (by
// name and by a file only that real directory has), not merely two
// constants that happen to agree with each other.
test("the shared root actually resolves to the real apps/toolbelt directory, not just an equal-but-wrong path", () => {
  assert.equal(basename(TOOLBELT_ROOT), "toolbelt");
  assert.equal(basename(dirname(TOOLBELT_ROOT)), "apps");
  assert.ok(existsSync(TOOLBELT_ROOT), `expected ${TOOLBELT_ROOT} to exist`);
  assert.ok(existsSync(join(TOOLBELT_ROOT, "tool.schema.json")), "expected apps/toolbelt/tool.schema.json to exist");
});

test("REPO_ROOT and CLI_PACKAGE_ROOT are internally consistent with DEFAULT_TOOLBELT_ROOT's own derivation", () => {
  assert.equal(basename(CLI_PACKAGE_ROOT), "toolbelt-cli");
  assert.equal(DEFAULT_TOOLBELT_ROOT, join(REPO_ROOT, "apps", "toolbelt"));
});
