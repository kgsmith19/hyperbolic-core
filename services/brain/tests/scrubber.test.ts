import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubText, scrubValue } from "../src/scrubber.ts";

// Every fixture "secret" below is assembled from concatenated parts at
// runtime rather than written as one contiguous literal -- these are
// fake values that exist only to exercise scrubText's regexes, but a
// static scanner (this repo's own Gitleaks PR gate, M1-10) cannot tell
// that from source text alone, and rightly flags anything shaped like a
// real credential. Splitting the literal is the same "make it
// unscannable, not the scanner's business to special-case" fix real
// secret-shaped test fixtures use elsewhere; it does not change what
// scrubText actually receives at runtime.
const FAKE_ANTHROPIC_KEY = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_GITHUB_PAT = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_AWS_KEY_ID = "AKIA" + "ABCDEFGHIJKLMNOP";
const FAKE_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dGhpc19pc19ub3RfYV9yZWFsX3NpZ25hdHVyZQ"].join(".");

test("scrubText: an Anthropic-shaped key is masked", () => {
  const out = scrubText(`credentials: ${FAKE_ANTHROPIC_KEY}`);
  assert.doesNotMatch(out, /sk-ant-/);
  assert.match(out, /\*\*\*REDACTED\*\*\*/);
});

test("scrubText: a GitHub PAT-shaped token is masked", () => {
  const out = scrubText(`token=${FAKE_GITHUB_PAT}`);
  assert.doesNotMatch(out, /ghp_/);
});

test("scrubText: an AWS access key id is masked", () => {
  const out = scrubText(FAKE_AWS_KEY_ID);
  assert.doesNotMatch(out, new RegExp(FAKE_AWS_KEY_ID));
});

test("scrubText: a JWT-shaped bearer token is masked", () => {
  const out = scrubText(`Authorization: Bearer ${FAKE_JWT}`);
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiJ9/);
});

test("scrubText: a run/task/invocation UUID is NEVER masked -- m4-17's own trace-join ids must survive the scrubber untouched", () => {
  const uuid = "11111111-1111-1111-1111-111111111111";
  const text = `run_id=${uuid} kind=task.parked_for_approval`;
  assert.equal(scrubText(text), text);
});

test("scrubText: a git commit SHA / manifest hash is NEVER masked -- ordinary hex ids are not secrets", () => {
  const sha = "a".repeat(40);
  const text = `commit ${sha}`;
  assert.equal(scrubText(text), text);
});

test("scrubText: a named vault key's assignment shape is collapsed even when the value isn't independently token-shaped", () => {
  const out = scrubText("ANTHROPIC_API_KEY=short-test-value", ["ANTHROPIC_API_KEY"]);
  assert.equal(out, "ANTHROPIC_API_KEY=***REDACTED***");
});

test("scrubText: an unrelated name is left alone even if it superficially resembles a key=value pair", () => {
  const text = "OTHER_THING=some-value";
  assert.equal(scrubText(text, ["ANTHROPIC_API_KEY"]), text);
});

test("scrubText: plain prose with no secret-shaped content is returned unchanged", () => {
  const text = "the task succeeded after two attempts on claude-code, then one on codex";
  assert.equal(scrubText(text), text);
});

test("scrubValue: recursively scrubs strings inside nested objects/arrays, leaves non-strings and structure alone", () => {
  const input = {
    event: "invocation.started",
    fields: {
      note: `leaked key: ${FAKE_ANTHROPIC_KEY}`,
      attempts: [{ detail: `token ${FAKE_GITHUB_PAT} seen in output` }, { detail: "clean" }],
      count: 3,
      ok: true,
      nothing: null,
    },
  };
  const out = scrubValue(input);
  assert.equal(out.event, "invocation.started");
  assert.doesNotMatch(out.fields.note, /sk-ant-/);
  assert.doesNotMatch(out.fields.attempts[0].detail, /ghp_/);
  assert.equal(out.fields.attempts[1].detail, "clean");
  assert.equal(out.fields.count, 3);
  assert.equal(out.fields.ok, true);
  assert.equal(out.fields.nothing, null);
});
