// Tests for hooks/receipt.mjs — the directive outcome receipt (issue #68).
// Pure-function tests need no sandbox; writeReceiptOnce tests use a throwaway
// tmpdir the same way every other ACC_ROOT-adjacent suite does.
//
// Run: node --test hooks/receipt.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-receipt-"));
const PROJECTS = path.join(BASE, "claude", "projects");
process.env.CLAUDE_CONFIG_DIR = path.join(BASE, "claude");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
const m = await import("./receipt.mjs");

beforeEach(() => {
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ rates: { sonnet: { in: 3, out: 15 } } }));
});

function directive(over = {}) {
  return {
    id: "d-20260810-000000-abcd",
    text: "fix the parser",
    cwd: "C:/code",
    profile: "Normal",
    status: "done",
    sessionId: "",
    sessionIds: [],
    cycles: 2,
    budget: { wallClockMin: 0, turns: 0, tokens: 0, dollars: 0 },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T01:00:00.000Z",
    ...over,
  };
}

// --- extractVerification -------------------------------------------------

test("extractVerification pulls command-shaped or backtick-quoted lines, bounded to 5 entries", () => {
  const text = [
    "did some analysis",
    "node hooks/covgate.mjs",
    "ran `npm test` and it passed",
    "npm run test:windows",
    "unrelated prose line",
    "npx playwright test",
    "pytest -k foo",
    "go test ./...",
    "cargo test",
  ].join("\n");
  const got = m.extractVerification(text);
  assert.equal(got.length, 5, "capped at 5 entries even though more qualify");
  assert.ok(got.includes("node hooks/covgate.mjs"));
  assert.ok(got.some((l) => l.includes("npm test")));
});

test("extractVerification returns an empty array for prose with no reported checks", () => {
  assert.deepEqual(m.extractVerification("did the work, looks good"), []);
  assert.deepEqual(m.extractVerification(""), []);
  assert.deepEqual(m.extractVerification(undefined), []);
});

test("extractVerification truncates an overlong single line", () => {
  const long = "node " + "x".repeat(500);
  const got = m.extractVerification(long);
  assert.equal(got[0].length, 200);
});

// --- extractLinks ----------------------------------------------------------

test("extractLinks finds a PR URL, an issue reference, and a branch name", () => {
  const text = "Opened https://github.com/kgsmith19/agentic-command-center/pull/68 for issue #68 on branch feat/receipts";
  const got = m.extractLinks(text);
  assert.equal(got.pr, "https://github.com/kgsmith19/agentic-command-center/pull/68");
  assert.equal(got.issue, "#68");
  assert.equal(got.branch, "feat/receipts");
});

test("extractLinks returns nulls when nothing is present, and ignores a bare hash with no 'issue' word", () => {
  assert.deepEqual(m.extractLinks("just a plain summary with #notanissue mentioned"), {
    branch: null, pr: null, issue: null,
  });
  assert.deepEqual(m.extractLinks(""), { branch: null, pr: null, issue: null });
});

// --- classifyBlocker ---------------------------------------------------

test("classifyBlocker: done has no class", () => {
  assert.equal(m.classifyBlocker("done", "anything"), null);
});

test("classifyBlocker: budget_exhausted maps the breach text to a budget-* bucket", () => {
  assert.equal(m.classifyBlocker("budget_exhausted", "wall-clock ceiling reached (30 min)"), "budget-wall-clock");
  assert.equal(m.classifyBlocker("budget_exhausted", "turn ceiling reached (3/3)"), "budget-turns");
  assert.equal(m.classifyBlocker("budget_exhausted", "token ceiling reached (100/100)"), "budget-tokens");
  assert.equal(m.classifyBlocker("budget_exhausted", "dollar ceiling reached ($1/$1 est)"), "budget-dollars");
  assert.equal(m.classifyBlocker("budget_exhausted", "some other reason"), "budget-other");
});

test("classifyBlocker: blocked/failed text buckets by keyword, defaulting to unspecified/other", () => {
  assert.equal(m.classifyBlocker("blocked", ""), "unspecified");
  assert.equal(m.classifyBlocker("blocked", "need a vault credential to proceed"), "missing-access");
  assert.equal(m.classifyBlocker("blocked", "need Kyle to decide between two approaches"), "needs-decision");
  assert.equal(m.classifyBlocker("failed", "the test suite failed after the change"), "verification-failed");
  assert.equal(m.classifyBlocker("blocked", "waiting on an upstream dependency"), "external-dependency");
  assert.equal(m.classifyBlocker("blocked", "something else entirely"), "other");
});

// --- buildReceipt --------------------------------------------------------

test("buildReceipt shapes a stable schema from an in-memory directive record", () => {
  const d = directive();
  const r = m.buildReceipt(d, { status: "done", why: "shipped", lastSummary: "ran `npm test`, all green" });
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.directiveId, d.id);
  assert.equal(r.status, "done");
  assert.equal(r.startedAt, d.createdAt);
  assert.equal(r.finishedAt, d.updatedAt);
  assert.equal(r.durationMs, Date.parse(d.updatedAt) - Date.parse(d.createdAt));
  assert.equal(r.cycles, 2);
  assert.equal(r.profile, "Normal");
  assert.deepEqual(r.spend, { turns: 0, tokens: 0, dollars: 0 });
  assert.deepEqual(r.budget, d.budget);
  assert.equal(r.why, "shipped");
  assert.equal(r.blockerClass, null, "done carries no blocker class");
  assert.deepEqual(r.verification, ["ran `npm test`, all green"]);
});

test("buildReceipt bounds why and lastSummary, and falls back to directive.why when opts.why is omitted", () => {
  const d = directive({ status: "blocked", why: "x".repeat(600) });
  const r = m.buildReceipt(d, { status: "blocked", lastSummary: "y".repeat(3000) });
  assert.equal(r.why.length, 500);
  assert.equal(r.verification.length <= 5, true);
});

test("buildReceipt: durationMs is null when startedAt is missing", () => {
  const d = directive({ createdAt: "" });
  const r = m.buildReceipt(d, { status: "done" });
  assert.equal(r.durationMs, null);
});

// --- writeReceiptOnce ------------------------------------------------------

test("writeReceiptOnce writes a receipt file once and is idempotent on retry", () => {
  const dir = fs.mkdtempSync(path.join(BASE, "receipts-"));
  const d = directive();
  const first = m.writeReceiptOnce(dir, d, { status: "done", why: "shipped" });
  const onDisk = JSON.parse(fs.readFileSync(m.receiptPath(dir, d.id), "utf8"));
  assert.deepEqual(onDisk, first);

  // A retried terminal transition must not overwrite or duplicate.
  const second = m.writeReceiptOnce(dir, d, { status: "blocked", why: "different" });
  assert.deepEqual(second, first, "the original receipt wins; a retry never overwrites");
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".receipt.json")).length, 1);
});
