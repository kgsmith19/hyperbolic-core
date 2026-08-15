#!/usr/bin/env node
// Agentic Command Center - directive outcome receipts (issue #68).
//
// THE PROBLEM IT SOLVES: the directive loop (hooks/directive.mjs,
// runner/runner.mjs) already knows everything about how a directive ended —
// but that knowledge lives only in free-form log text and a JSON record that
// gets archived away. There is no single machine-readable fact a human or a
// later optimizer can query across many directives without re-parsing logs.
//
// This module adds NO new telemetry source: every field below is derived
// from the directive record (hooks/directive.mjs), the directive's own spend
// accounting (hooks/directive-spend.mjs), and the directive's own progress
// log text, all of which already exist. It only shapes and bounds that
// existing state into one stable JSON document, written once per terminal
// state (writeReceiptOnce is idempotent by construction: a receipt file that
// already exists is returned as-is, never overwritten, so a retried halt or
// a re-run of the same terminal transition can never produce a duplicate).
//
// Bounding is deliberate everywhere a field could otherwise be unbounded:
// `why`/`lastSummary` are truncated, `verification` keeps at most a handful
// of short lines, and nothing here ever copies a full prompt, a full log, or
// a raw secret into the receipt.

import fs from "node:fs";
import path from "node:path";
import { directiveSpend } from "./directive-spend.mjs";

const WHY_MAX = 500;
const SUMMARY_MAX = 2000;
const VERIFICATION_MAX_LINES = 5;
const VERIFICATION_LINE_MAX = 200;

export function receiptPath(dir, id) {
  return path.join(dir, `${id}.receipt.json`);
}

// A run's own closing summary (already capped at 4000 chars by
// hooks/directive.mjs's appendCycle) is the only place a headless directive
// ever states what it verified. This pulls out lines that read like a
// reported command or check, bounded to a handful of short entries — never
// the raw summary itself.
export function extractVerification(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(?:[-*]\s*)?`{0,3}\s*(node |npm |npx |pytest\b|go test\b|cargo test\b|powershell\b|python -m pytest)/i.test(line) || /`[^`]+`/.test(line)) {
      out.push(line.slice(0, VERIFICATION_LINE_MAX));
      if (out.length >= VERIFICATION_MAX_LINES) break;
    }
  }
  return out;
}

// Best-effort, bounded extraction of a linked branch/PR/Issue from text the
// directive already carries (its task text, its closing summaries, its
// blocked/done "why"). No network call, no GitHub API - just what the model
// already reported.
export function extractLinks(text) {
  const s = String(text || "");
  const pr = s.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  const issue = s.match(/\bissue[:#\s]{1,3}(\d+)/i);
  const branch = s.match(/\bbranch[:\s]+([A-Za-z0-9._/-]+)/i);
  return {
    branch: branch ? branch[1] : null,
    pr: pr ? pr[0] : null,
    issue: issue ? `#${issue[1]}` : null,
  };
}

// A small, deterministic bucket for "why didn't this finish" - enough to
// answer the issue's ROI test ("top blocker class") without inventing a
// full taxonomy. `status` decides the vocabulary; `why` (already bounded by
// the caller) is only pattern-matched, never stored twice.
export function classifyBlocker(status, why) {
  if (status === "done") return null;
  const w = String(why || "").toLowerCase();
  if (status === "budget_exhausted") {
    if (w.includes("wall-clock")) return "budget-wall-clock";
    if (w.includes("turn")) return "budget-turns";
    if (w.includes("token")) return "budget-tokens";
    if (w.includes("dollar")) return "budget-dollars";
    return "budget-other";
  }
  if (!w) return "unspecified";
  if (/\b(credential|permission|access|secret|key|auth)\b/.test(w)) return "missing-access";
  if (/\b(decide|decision|choice|approve|confirm|choose)\b/.test(w)) return "needs-decision";
  if (/\b(test|assert|fail(?:ed|ing)?|broke|regression)\b/.test(w)) return "verification-failed";
  if (/\b(wait|depend|blocked on|upstream)\b/.test(w)) return "external-dependency";
  return "other";
}

// Pure: builds the receipt object from an in-memory directive record plus
// the caller-supplied terminal facts. No filesystem access here so this is
// trivially unit-testable without a sandbox.
export function buildReceipt(directive, { status, why, lastSummary } = {}) {
  const startedAt = directive.createdAt || null;
  const finishedAt = directive.updatedAt || new Date().toISOString();
  const durationMs =
    startedAt && !Number.isNaN(Date.parse(startedAt)) ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null;
  const boundedWhy = why !== undefined ? String(why || "").trim().slice(0, WHY_MAX) : String(directive.why || "").trim().slice(0, WHY_MAX);
  const boundedSummary = String(lastSummary || "").trim().slice(0, SUMMARY_MAX);

  return {
    schemaVersion: 1,
    directiveId: directive.id,
    status,
    startedAt,
    finishedAt,
    durationMs,
    cycles: Number(directive.cycles || 0),
    freshContextCount: Number(directive.cycles || 0),
    profile: directive.profile || "",
    spend: directiveSpend(directive.sessionIds || []),
    budget: directive.budget || {},
    why: boundedWhy || null,
    blockerClass: classifyBlocker(status, boundedWhy),
    verification: extractVerification(boundedSummary),
    links: extractLinks(`${directive.text || ""}\n${boundedSummary}\n${boundedWhy}`),
  };
}

// Idempotent by construction: an existing receipt file is returned verbatim
// and never rewritten, so a retried terminal transition (e.g. a budget halt
// re-evaluated on the next loop tick) can never produce a duplicate or a
// second, possibly-different, receipt for the same directive.
export function writeReceiptOnce(dir, directive, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = receiptPath(dir, directive.id);
  try {
    const existing = fs.readFileSync(file, "utf8");
    return JSON.parse(existing);
  } catch {}
  const receipt = buildReceipt(directive, opts);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
