import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherContext, looksLikeTestPath } from "../src/context.ts";
import type { RunGit } from "../src/context.ts";

/** A fake git that answers from a fixture map. No subprocess, no repository. */
function fakeGit(files: Record<string, string>, diff: string, names: string[]): RunGit {
  return async (args) => {
    if (args[0] === "diff" && args[1] === "--unified=3") {
      return diff;
    }
    if (args[0] === "diff" && args[1] === "--name-only") {
      return `${names.join("\n")}\n`;
    }
    if (args[0] === "show") {
      const path = String(args[1]).split(":").slice(1).join(":");
      const contents = files[path];
      if (contents === undefined) {
        throw new Error(`fatal: path '${path}' does not exist`);
      }
      return contents;
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

// TRUNCATION MUST BE VISIBLE. Behavior protected: an oversized diff is cut with
// an explicit inline marker stating how much was removed, and the context flags
// it. Defect caught: silently slicing to the cap. A reviewer handed the first
// half of a diff with no indication would confidently report "pass" on code it
// never saw, and the verdict would carry no trace of the omission -- a false
// green that is indistinguishable from a real one.
test("gatherContext: an over-cap diff is cut with a visible [truncated N chars] marker", async () => {
  const oversized = "x".repeat(500);
  const context = await gatherContext({
    baseSha: "base0000",
    headSha: "head1111",
    issueBody: "criterion 1",
    agentsMd: "## Test quality",
    runGit: fakeGit({}, oversized, ["src/a.ts"]),
    perInputCharCap: 100,
    totalCharCap: 10_000,
  });

  assert.equal(context.truncated, true);
  assert.match(context.diff, /\[truncated 400 chars\]/);
  assert.ok(context.diff.startsWith("x".repeat(100)), "the retained prefix must be the head of the input");
  assert.ok(!context.diff.startsWith("x".repeat(101)), "nothing beyond the cap may be retained");
});

// Behavior protected: a first-round review (no `conversation` option supplied)
// gets an empty string, never undefined -- prompt.ts renders it unconditionally
// and a missing value would be a runtime crash, not a graceful "no dialogue yet".
// Defect caught: dropping the default and letting `conversation` come back
// `undefined` when the caller omits it.
test("gatherContext: conversation defaults to an empty string when not supplied", async () => {
  const context = await gatherContext({
    baseSha: "base0000",
    headSha: "head1111",
    issueBody: "criterion 1",
    agentsMd: "## Test quality",
    runGit: fakeGit({}, "+diff", ["src/a.ts"]),
  });

  assert.equal(context.conversation, "");
});

// Behavior protected: a supplied conversation is carried through to the
// context, and is truncated the same visible way as every other input rather
// than being silently exempt from the budget.
test("gatherContext: a supplied conversation is carried through and subject to truncation", async () => {
  const oversized = "reply ".repeat(50);
  const context = await gatherContext({
    baseSha: "base0000",
    headSha: "head1111",
    issueBody: "criterion 1",
    agentsMd: "## Test quality",
    conversation: oversized,
    runGit: fakeGit({}, "+diff", ["src/a.ts"]),
    perInputCharCap: 20,
    totalCharCap: 10_000,
  });

  assert.equal(context.truncated, true);
  assert.match(context.conversation, /\[truncated \d+ chars\]/);
  assert.ok(context.conversation.startsWith(oversized.slice(0, 20)));
});

// Behavior protected: content that fits is passed through byte-for-byte and not
// flagged. Defect caught: an off-by-one that truncates at exactly the cap, or a
// `truncated` flag stuck at true -- which would make the marker meaningless by
// appearing on every run, so a real truncation would go unnoticed.
test("gatherContext: content within the cap is untouched and not flagged", async () => {
  const diff = "x".repeat(100);
  const context = await gatherContext({
    baseSha: "base0000",
    headSha: "head1111",
    issueBody: "criterion 1",
    agentsMd: "## Test quality",
    runGit: fakeGit({}, diff, ["src/a.ts"]),
    perInputCharCap: 100,
    totalCharCap: 10_000,
  });

  assert.equal(context.truncated, false);
  assert.equal(context.diff, diff);
  assert.ok(!context.diff.includes("[truncated"));
});

// Behavior protected: the total budget is also enforced visibly, so a swarm of
// individually-legal files cannot blow the context window. Defect caught:
// applying only the per-input cap and letting the sum run away, which fails at
// the provider as an opaque token-limit error instead of as a marked, reviewable
// truncation.
test("gatherContext: exceeding the TOTAL cap is marked too, not silently dropped", async () => {
  const context = await gatherContext({
    baseSha: "base0000",
    headSha: "head1111",
    issueBody: "y".repeat(80),
    agentsMd: "z".repeat(80),
    runGit: fakeGit({}, "x".repeat(80), ["src/a.ts"]),
    perInputCharCap: 1_000,
    totalCharCap: 100,
  });

  assert.equal(context.truncated, true);
  const combined = `${context.diff}${context.issueBody}${context.agentsMd}`;
  assert.match(combined, /\[truncated \d+ chars\]/);
});

// Behavior protected: changed test files are supplied in FULL, not as diff
// hunks. Defect caught: reading test files from the diff instead of from head.
// Judging "could this test have failed before the change?" needs the whole file
// -- a hunk showing three new assertions cannot reveal that the fixture 200
// lines above already hard-codes the asserted value.
test("gatherContext: changed test files are included whole, keyed by path", async () => {
  const wholeTestFile = "import { test } from 'node:test';\n// ...200 lines...\ntest('x', () => {});\n";
  const context = await gatherContext({
    baseSha: "base0000",
    headSha: "head1111",
    issueBody: "criterion 1",
    agentsMd: "## Test quality",
    runGit: fakeGit({ "tests/pricing.test.ts": wholeTestFile }, "diff body", [
      "src/pricing.ts",
      "tests/pricing.test.ts",
    ]),
  });

  assert.deepEqual(context.changedFiles, ["src/pricing.ts", "tests/pricing.test.ts"]);
  assert.equal(context.testFiles.length, 1);
  assert.equal(context.testFiles[0]?.path, "tests/pricing.test.ts");
  assert.equal(context.testFiles[0]?.contents, wholeTestFile);
});

// Behavior protected: a test file DELETED by the change is still reported
// rather than crashing the gate. Defect caught: an unhandled `git show` failure
// aborting the whole review -- which would mean the one change most worth
// reviewing adversarially (removing a test, i.e. weakening an oracle) is the
// one change the gate cannot run on.
test("gatherContext: a test file deleted at head does not abort the review", async () => {
  const context = await gatherContext({
    baseSha: "base0000",
    headSha: "head1111",
    issueBody: "criterion 1",
    agentsMd: "## Test quality",
    runGit: fakeGit({}, "diff body", ["tests/deleted.test.ts"]),
  });

  assert.equal(context.testFiles.length, 1);
  assert.match(String(context.testFiles[0]?.contents), /does not exist at head/);
});

// Behavior protected: the test-path heuristic selects test files without
// dragging in unrelated source. Defect caught: a bare `includes("test")`, which
// would pull `src/contest.ts` and `src/latest-run.ts` into the "full text"
// bucket and burn the context budget on non-tests.
test("looksLikeTestPath: matches test and spec paths without matching lookalikes", () => {
  for (const path of ["tests/a.ts", "a.test.ts", "spec/b.ts", "b.spec.ts", "src/__tests__/c.ts", "e2e/d_spec.ts"]) {
    assert.equal(looksLikeTestPath(path), true, `${path} should be treated as a test file`);
  }
  for (const path of ["src/contest.ts", "src/latest.ts", "src/inspector.ts", "src/testable.ts"]) {
    assert.equal(looksLikeTestPath(path), false, `${path} should NOT be treated as a test file`);
  }
});
