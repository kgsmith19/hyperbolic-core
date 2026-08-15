import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-directive-spend-"));
const PROJECTS = path.join(BASE, "projects", "proj");
const POLICY = path.join(BASE, "policy.json");
process.env.CLAUDE_CONFIG_DIR = BASE;
process.env.ACC_POLICY = POLICY;
const m = await import("./directive-spend.mjs");

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.writeFileSync(POLICY, JSON.stringify({ rates: { opus: { in: 10, out: 20 } } }));
});

function turn(model, usage) {
  return JSON.stringify({ type: "assistant", message: { model, usage } });
}

test("directiveSpend sums main and subagent turns/tokens/cost for the named sessions only", () => {
  fs.writeFileSync(path.join(PROJECTS, "s1.jsonl"), [
    turn("claude-opus-5", { input_tokens: 10, output_tokens: 2 }),
    turn("claude-opus-5", { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 3 }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(PROJECTS, "s2.jsonl"), turn("claude-opus-5", { input_tokens: 999, output_tokens: 999 }) + "\n");
  const sub = path.join(PROJECTS, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-1.jsonl"), turn("claude-opus-5", { input_tokens: 4, output_tokens: 1 }) + "\n");
  assert.deepEqual(m.directiveSpend(["s1"]), { turns: 3, tokens: 26, dollars: 0.0003 });
});

test("directiveSpend ignores missing/corrupt/non-assistant files and falls back to zero for no ids", () => {
  fs.writeFileSync(path.join(PROJECTS, "s1.jsonl"), [
    "{bad json}",
    JSON.stringify({ type: "assistant", message: {} }),
    JSON.stringify({ type: "user", message: { usage: { input_tokens: 9 } } }),
  ].join("\n") + "\n");
  const sub = path.join(PROJECTS, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-1.jsonl"), "");
  assert.deepEqual(m.directiveSpend([]), { turns: 0, tokens: 0, dollars: 0 });
  assert.deepEqual(m.directiveSpend(["s1", "missing"]), { turns: 0, tokens: 0, dollars: 0 });
});

test("directiveSpend falls back to default rates for unreadable policy and unknown model families", () => {
  fs.writeFileSync(POLICY, "{bad json");
  fs.writeFileSync(path.join(PROJECTS, "s1.jsonl"), [
    turn("", { cache_creation_input_tokens: 5, output_tokens: 1 }),
    turn("gpt-5", { input_tokens: 1, output_tokens: 1 }),
  ].join("\n") + "\n");
  assert.deepEqual(m.directiveSpend(["s1"]), { turns: 2, tokens: 8, dollars: 0.000048 });
});

test("directiveSpend returns zero when the projects directory itself is missing or not a directory", () => {
  fs.rmSync(path.join(BASE, "projects"), { recursive: true, force: true });
  assert.deepEqual(m.directiveSpend(["s1"]), { turns: 0, tokens: 0, dollars: 0 });
  fs.mkdirSync(path.join(BASE, "projects"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "projects", "not-a-dir"), "x");
  assert.deepEqual(m.directiveSpend(["s1"]), { turns: 0, tokens: 0, dollars: 0 });
});

test("directiveSpend uses default rates when the policy parses but omits rates, and skips non-jsonl noise lines", () => {
  fs.writeFileSync(POLICY, "{}");
  fs.writeFileSync(path.join(PROJECTS, "s1.jsonl"), [
    "plain text",
    turn("claude-sonnet-4", { input_tokens: 2 }),
  ].join("\n") + "\n");
  assert.deepEqual(m.directiveSpend(["s1"]), { turns: 1, tokens: 2, dollars: 0.000006 });
});

test("directiveSpend recognizes later model families too, not only opus/sonnet", () => {
  fs.writeFileSync(path.join(PROJECTS, "s1.jsonl"), [
    turn("claude-haiku-4", { input_tokens: 4, output_tokens: 1 }),
    turn("claude-fable-1", { input_tokens: 1, output_tokens: 1 }),
  ].join("\n") + "\n");
  const got = m.directiveSpend(["s1"]);
  assert.equal(got.turns, 2);
  assert.equal(got.tokens, 7);
  assert.ok(Math.abs(got.dollars - 0.0000252) < 1e-12);
});
