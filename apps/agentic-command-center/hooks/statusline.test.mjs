// Tests that the statusline shows the SAME context budget budget.mjs enforces.
//
// The bug being pinned (2026-07-31): statusline.mjs called loadPolicy() without
// applyProfile(), so an ACC-launched session (ACC_PROFILE set) displayed the
// base dials while budget.mjs enforced the profile's - Kyle watched
// "149k/600k" on screen while the Stop hook cut the session at 150k. Both
// entrypoints must resolve policy through usage.mjs applyProfile so the
// number on screen can never disagree with the number enforced.
//
// Run: node --test hooks/statusline.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATUSLINE = path.join(HERE, "statusline.mjs");

// See budget.test.mjs's matching comment: this file spawns statusline.mjs as
// a child process per test with an env spread that would otherwise carry a
// live NODE_V8_COVERAGE straight through, and statusline.mjs is not itself
// gated this session, so none of that incidental coverage is wanted — its
// volume measurably degrades an unrelated gated file's merged branch
// coverage when many such spawns share one coverage run (found 2026-08-02).
delete process.env.NODE_V8_COVERAGE;

const BASE_POLICY = {
  context: { softK: 40, hardK: 50 },
  week: { amberTokens: 0, redTokens: 0, effectiveFrom: "" },
  subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 6, exploreMaxReportLines: 80 },
  };

function sandbox(policy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-statusline-"));
  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy));
  return { root, policyPath };
}

// One assistant turn; contextOf() reads the input side of the LAST turn.
function writeTranscript(sb, ctxTokens) {
  const f = path.join(sb.root, "s-test.jsonl");
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-31T12:00:00.000Z",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: ctxTokens,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: "x" }],
    },
  });
  fs.writeFileSync(f, line + "\n");
  return f;
}

function run(sb, transcript, profile) {
  return execFileSync("node", [STATUSLINE], {
    input: JSON.stringify({
      session_id: "s-test-nonexistent",
      transcript_path: transcript,
      workspace: { current_dir: sb.root },
      model: { display_name: "Test" },
    }),
    env: { ...process.env, ACC_POLICY: sb.policyPath, ACC_PROFILE: profile || "", ACC_ROOT: sb.root },
    encoding: "utf8",
  });
}

test("no profile: base dials are the displayed budget", () => {
  const sb = sandbox(BASE_POLICY);
  const t = writeTranscript(sb, 60000);
  assert.match(run(sb, t), /ctx 60k\/50k/);
});

test("profile context (when present) is the displayed budget, same as enforcement", () => {
  const sb = sandbox({
    ...BASE_POLICY,
    profiles: { Heavy: { context: { softK: 60, hardK: 80 } } },
  });
  const t = writeTranscript(sb, 60000);
  assert.match(run(sb, t, "Heavy"), /ctx 60k\/80k/);
});

test("profile without a context block: base dials show through (live policy shape)", () => {
  const sb = sandbox({
    ...BASE_POLICY,
    profiles: { Normal: { subagents: { allow: ["Explore"], maxPerSession: 6 } } },
  });
  const t = writeTranscript(sb, 60000);
  assert.match(run(sb, t, "Normal"), /ctx 60k\/50k/);
});

// The watcher-liveness "bot DEAD" segment died with the keystroke stack
// (SPEC-0005 PR-2): there is no watcher to be dead. This pin keeps the dead
// warning from ever resurfacing in a rendered line.
test("no watcher segment ever renders — the keystroke-era warning is gone", () => {
  const sb = sandbox(BASE_POLICY);
  const dir = path.join(sb.root, "watcher");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "clearbot.heartbeat");
  fs.writeFileSync(f, "stale");
  const when = new Date(Date.now() - 120000);
  fs.utimesSync(f, when, when);
  assert.doesNotMatch(run(sb, writeTranscript(sb, 10000)), /bot DEAD/);
});
