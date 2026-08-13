import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkApplyRef,
  isDiffEmpty,
  findMissingVersions,
  parseOwnerPreflightRow,
} from "../scripts/platform-migration-guards.mjs";

const SCRIPT = new URL("../scripts/platform-migration-guards.mjs", import.meta.url).pathname;

// ---- checkApplyRef (Finding 4: apply-mode ref pinning) --------------------

test("checkApplyRef passes any ref/sha when mode is not apply (baseline is operator-named, not ref-pinned)", () => {
  const result = checkApplyRef({
    mode: "baseline",
    ref: "refs/heads/some-feature",
    sha: "aaa",
    mainSha: "bbb",
  });
  assert.equal(result.ok, true);
});

test("checkApplyRef passes when apply mode targets main at its exact current SHA", () => {
  const result = checkApplyRef({
    mode: "apply",
    ref: "refs/heads/main",
    sha: "deadbeef",
    mainSha: "deadbeef",
  });
  assert.equal(result.ok, true);
});

test("checkApplyRef refuses apply mode against a non-main ref", () => {
  const result = checkApplyRef({
    mode: "apply",
    ref: "refs/heads/some-feature",
    sha: "deadbeef",
    mainSha: "deadbeef",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /only refs\/heads\/main/);
});

test("checkApplyRef refuses apply mode when the checked-out SHA is not main's current tip", () => {
  const result = checkApplyRef({
    mode: "apply",
    ref: "refs/heads/main",
    sha: "stale-sha",
    mainSha: "current-sha",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not main's current tip/);
});

test("checkApplyRef refuses apply mode when mainSha could not be resolved at all", () => {
  const result = checkApplyRef({ mode: "apply", ref: "refs/heads/main", sha: "abc", mainSha: "" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not resolve main's current SHA/);
});

// ---- isDiffEmpty (Finding 4: live-parity diff verdict) --------------------

test("isDiffEmpty treats a genuinely empty string as no drift", () => {
  assert.equal(isDiffEmpty(""), true);
});

test("isDiffEmpty treats whitespace-only output as no drift", () => {
  assert.equal(isDiffEmpty("\n  \n\t\n"), true);
});

test("isDiffEmpty treats comment-only output as no drift", () => {
  assert.equal(isDiffEmpty("-- No schema changes found\n"), true);
});

test("isDiffEmpty treats a real schema statement as drift", () => {
  assert.equal(isDiffEmpty("alter table core.run add column extra int;\n"), false);
});

test("isDiffEmpty treats a real statement preceded by a comment line as drift, not as comment-only", () => {
  assert.equal(isDiffEmpty("-- drift detected\ncreate table core.rogue();\n"), false);
});

// ---- findMissingVersions (Finding 4: post-push zero-pending proof) --------

test("findMissingVersions is empty when every staged version is recorded in the ledger", () => {
  const missing = findMissingVersions(["100", "200", "300"], ["100", "200", "300", "400"]);
  assert.deepEqual(missing, []);
});

test("findMissingVersions reports staged versions the ledger does not yet have", () => {
  const missing = findMissingVersions(["100", "200", "300"], ["100"]);
  assert.deepEqual(missing, ["200", "300"]);
});

test("findMissingVersions treats a cold (empty) ledger as everything staged being pending", () => {
  const missing = findMissingVersions(["100", "200"], []);
  assert.deepEqual(missing, ["100", "200"]);
});

// ---- parseOwnerPreflightRow (Finding 5: owner preflight) ------------------

const OWNER_ID = "11111111-1111-1111-1111-111111111111";

test("parseOwnerPreflightRow fails closed when platform.config is empty (bootstrap, never run)", () => {
  const result = parseOwnerPreflightRow("0|||||");
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected exactly 1/);
  assert.match(result.reason, /2026-08-12-platform-idp-owner-setup\.md/);
});

test("parseOwnerPreflightRow fails when platform.config somehow holds more than one row", () => {
  // Real platform.config cannot reach 2 rows (a boolean singleton PK + a
  // "singleton" check constraint together forbid it -- verified directly
  // against a real local Postgres instance during this change), so this
  // exercises the defense-in-depth branch with a fabricated row rather than
  // a live fixture.
  const result = parseOwnerPreflightRow(`2|${OWNER_ID}|${OWNER_ID}|owner@example.com|2026-08-12T00:00:00Z|`);
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected exactly 1/);
});

test("parseOwnerPreflightRow fails when owner_uuid does not resolve to any auth.users row", () => {
  const result = parseOwnerPreflightRow(`1|${OWNER_ID}||||`);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not resolve to any row in auth\.users/);
});

test("parseOwnerPreflightRow fails when the owner user exists but has never confirmed", () => {
  const result = parseOwnerPreflightRow(`1|${OWNER_ID}|${OWNER_ID}|owner@example.com||`);
  assert.equal(result.ok, false);
  assert.match(result.reason, /never confirmed/);
});

test("parseOwnerPreflightRow fails when the owner user is currently banned", () => {
  const result = parseOwnerPreflightRow(
    `1|${OWNER_ID}|${OWNER_ID}|owner@example.com|2026-08-12T00:00:00|2027-01-01T00:00:00`,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /banned until/);
});

test("parseOwnerPreflightRow passes for exactly one config row resolving to a confirmed, unbanned owner", () => {
  const result = parseOwnerPreflightRow(`1|${OWNER_ID}|${OWNER_ID}|owner@example.com|2026-08-12T00:00:00|`);
  assert.equal(result.ok, true);
});

// Regression guard: these are the exact five row shapes a real local
// Postgres instance (schema-identical stand-in for platform.config +
// auth.users: a boolean-singleton-PK config table, a stub auth.users) was
// made to produce, by running the real query text from this file's own
// header comment through `psql -Atc`, during this change -- see the final
// report for the transcript. This test freezes those literal captured rows
// so a future edit to the query's column order or a psql formatting change
// is caught here, not only against a live project this sandbox does not have.
test("parseOwnerPreflightRow matches verdicts captured from a real psql run against a scratch Postgres instance", () => {
  const capturedRows = [
    { row: "0|||||", ok: false },
    { row: "1|11111111-1111-1111-1111-111111111111||||", ok: false },
    {
      row: "1|11111111-1111-1111-1111-111111111111|11111111-1111-1111-1111-111111111111|kylegsmith19@gmail.com||",
      ok: false,
    },
    {
      row: "1|11111111-1111-1111-1111-111111111111|11111111-1111-1111-1111-111111111111|kylegsmith19@gmail.com|2026-08-13 04:47:10.380845+00|",
      ok: true,
    },
    {
      row: "1|11111111-1111-1111-1111-111111111111|11111111-1111-1111-1111-111111111111|kylegsmith19@gmail.com|2026-08-13 04:47:10.380845+00|2026-08-14 04:47:10.459332+00",
      ok: false,
    },
  ];
  for (const { row, ok } of capturedRows) {
    assert.equal(parseOwnerPreflightRow(row).ok, ok, `mismatch for row: ${row}`);
  }
});

// ---- CLI wiring smoke tests -------------------------------------------
// stage-migrations.test.mjs never needs this (its CLI is a thin pass-through
// to already-tested exports with no arg-parsing of its own to speak of);
// this script's CLI does real work -- flag parsing for check-apply-ref,
// stdin-vs-file-argument handling for the other three -- so it gets its own
// thin process-level smoke test per command, on top of the exported-function
// tests above.

function runCli(args, { input } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      input,
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

test("CLI check-apply-ref exits 0 for a passing apply dispatch and nonzero with a reason for a failing one", () => {
  const ok = runCli([
    "check-apply-ref",
    "--mode",
    "apply",
    "--ref",
    "refs/heads/main",
    "--sha",
    "abc",
    "--main-sha",
    "abc",
  ]);
  assert.equal(ok.status, 0);

  const bad = runCli([
    "check-apply-ref",
    "--mode",
    "apply",
    "--ref",
    "refs/heads/feature",
    "--sha",
    "abc",
    "--main-sha",
    "abc",
  ]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /only refs\/heads\/main/);
});

test("CLI check-diff-empty reads a file argument or stdin and exits accordingly", () => {
  const dir = mkdtempSync(join(tmpdir(), "guards-diff-"));
  try {
    const emptyPath = join(dir, "empty.sql");
    const driftPath = join(dir, "drift.sql");
    writeFileSync(emptyPath, "-- no changes\n");
    writeFileSync(driftPath, "create table core.rogue();\n");

    assert.equal(runCli(["check-diff-empty", emptyPath]).status, 0);
    assert.equal(runCli(["check-diff-empty", driftPath]).status, 1);
    assert.equal(runCli(["check-diff-empty"], { input: "-- no changes\n" }).status, 0);
    assert.equal(runCli(["check-diff-empty"], { input: "create table x();\n" }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI check-owner-preflight reads a file argument or stdin and exits accordingly", () => {
  const dir = mkdtempSync(join(tmpdir(), "guards-owner-"));
  try {
    const passPath = join(dir, "pass.txt");
    writeFileSync(passPath, `1|${OWNER_ID}|${OWNER_ID}|owner@example.com|2026-08-12T00:00:00|\n`);

    assert.equal(runCli(["check-owner-preflight", passPath]).status, 0);
    assert.equal(runCli(["check-owner-preflight"], { input: "0|||||\n" }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI check-zero-pending compares staged vs ledger version files and exits accordingly", () => {
  const dir = mkdtempSync(join(tmpdir(), "guards-pending-"));
  try {
    const stagedPath = join(dir, "staged.txt");
    const ledgerFullPath = join(dir, "ledger-full.txt");
    const ledgerPartialPath = join(dir, "ledger-partial.txt");
    writeFileSync(stagedPath, "100\n200\n300\n");
    writeFileSync(ledgerFullPath, "100\n200\n300\n");
    writeFileSync(ledgerPartialPath, "100\n");

    const clean = runCli(["check-zero-pending", "--staged", stagedPath, "--ledger", ledgerFullPath]);
    assert.equal(clean.status, 0);

    const pending = runCli(["check-zero-pending", "--staged", stagedPath, "--ledger", ledgerPartialPath]);
    assert.equal(pending.status, 1);
    assert.match(pending.stderr, /200/);
    assert.match(pending.stderr, /300/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
