// Schema and reader-conformance tests for the root agent-roles.yaml (#490,
// slice S1 of #467). The file declares which provider company holds each
// role; models stay in vars.DEV_MODEL / vars.REVIEW_MODEL, which every reader
// already prefers. Each reader's own parser is taken from its workflow text,
// never copied here, so a drift on either side fails this file.
//
// Run with: node --test docs/ops/agent-roles.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
/** The root file's text; a missing file is an assertion failure, not a load error. */
function rolesFile() {
  assert.ok(existsSync(path.join(root, "agent-roles.yaml")), "agent-roles.yaml is missing at the repo root");
  return read("agent-roles.yaml");
}

const PROVIDERS = new Set(["anthropic", "openai", "google"]);
// Every provider value names its own company family (verify-repo-policy's PROVIDER_FAMILIES).
const family = (provider) => provider;

test("agent-roles.yaml declares exactly dev.provider and review.provider", () => {
  const roles = YAML.parse(rolesFile());
  assert.deepEqual(Object.keys(roles).sort(), ["dev", "review"]);
  assert.deepEqual(Object.keys(roles.dev), ["provider"]);
  assert.deepEqual(Object.keys(roles.review), ["provider"]);
  for (const role of ["dev", "review"]) {
    assert.ok(PROVIDERS.has(roles[role].provider), `${role}.provider ${roles[role].provider} is not a known company`);
  }
});

test("dev and review are held by different provider families (AGENTS.md > Active agent roles)", () => {
  const roles = YAML.parse(rolesFile());
  assert.notEqual(family(roles.dev.provider), family(roles.review.provider));
});

test("the declared assignment is anthropic dev, openai review: the live vars (Repository Standards job 123252799662)", () => {
  // verify-repo-policy fails the PR Gate when review.provider differs from the
  // live vars.REVIEW_PROVIDER, so this file must follow the vars, not lead them.
  const roles = YAML.parse(rolesFile());
  assert.equal(roles.dev.provider, "anthropic");
  assert.equal(roles.review.provider, "openai");
});

test("no model id appears anywhere, comments included", () => {
  // The dialogue and post readers match `model:` lazily across lines from the
  // role's header, so even a comment naming that key would be read as a value.
  const rolesText = rolesFile();
  assert.doesNotMatch(rolesText, /model/i);
  for (const key of ["dev:", "review:", "provider:"]) {
    const lines = rolesText.split("\n").filter((line) => line.includes(key));
    assert.ok(lines.every((line) => !line.trimStart().startsWith("#")), `a comment line names ${key}`);
  }
  assert.equal((rolesText.match(/provider:/g) ?? []).length, 2);
});

/** The regex literal assigned after `marker` in `source`, compiled as the workflow compiles it. */
function regexAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `reader marker not found: ${marker}`);
  const literal = source.slice(start + marker.length, source.indexOf(".exec(", start)).trim();
  assert.match(literal, /^\/.*\/[a-z]*$/, `not a regex literal after ${marker}`);
  return new Function(`return ${literal};`)();
}

test("dev-agent-dispatch.yml's preflight resolves dev.provider anthropic and no model from the file", () => {
  const rolesText = rolesFile();
  const source = read(".github/workflows/dev-agent-dispatch.yml");
  const block = regexAfter(source, "const devBlockMatch =").exec(rolesText.replace(/\r\n/g, "\n"));
  assert.ok(block, "dev block not found");
  assert.equal(regexAfter(source, "const providerMatch =").exec(block[1])[1].trim().toLowerCase(), "anthropic");
  assert.equal(regexAfter(source, "const modelMatch =").exec(block[1]), null);
});

test("dev-agent-post.yml's preflight resolves dev.provider anthropic and no model from the file", () => {
  const rolesText = rolesFile();
  const source = read(".github/workflows/dev-agent-post.yml");
  assert.equal(regexAfter(source, "const providerMatch =").exec(rolesText)[1].trim().toLowerCase(), "anthropic");
  assert.equal(regexAfter(source, "const modelMatch =").exec(rolesText), null);
});

test("llm-review-dialogue.yml's footer reads dev anthropic, review openai, model from vars only", () => {
  const rolesText = rolesFile();
  const source = read(".github/workflows/llm-review-dialogue.yml");
  assert.equal(regexAfter(source, "const devProviderMatch =").exec(rolesText)[1].trim().toLowerCase(), "anthropic");
  assert.equal(regexAfter(source, "const reviewProviderMatch =").exec(rolesText)[1].trim().toLowerCase(), "openai");
  assert.equal(regexAfter(source, "const reviewModelMatch =").exec(rolesText), null);
});

test("pr-verify.yml's Work State reads dev.provider anthropic", () => {
  const rolesText = rolesFile();
  const source = read(".github/workflows/pr-verify.yml");
  const fn = source.slice(source.indexOf("async function readDevProvider()"));
  assert.equal(regexAfter(fn, "const match =").exec(rolesText)[1].trim().toLowerCase(), "anthropic");
});

/** verify-repo-policy's embedded validator, run in a temp dir holding the real agent-roles.yaml. */
function runPolicyValidator(env) {
  const action = read(".github/actions/verify-repo-policy/action.yml");
  const step = action.slice(action.indexOf("name: Policy · Confirm agent-roles.yaml is valid and dev/review providers differ"));
  const start = step.indexOf("python3 <<'PYEOF'\n") + "python3 <<'PYEOF'\n".length;
  const body = step.slice(start, step.indexOf("\n        PYEOF", start));
  const script = body.split("\n").map((line) => line.slice(8)).join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "agent-roles-"));
  writeFileSync(path.join(dir, "validate.py"), script);
  writeFileSync(path.join(dir, "agent-roles.yaml"), rolesFile());
  try {
    execFileSync("python3", ["validate.py"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LIVE = { LIVE_DEV_PROVIDER: "anthropic", LIVE_DEV_MODEL: "m-dev", LIVE_REVIEW_PROVIDER: "openai", LIVE_REVIEW_MODEL: "m-review" };

test("verify-repo-policy passes the real file with the live vars, and fails closed when they diverge", () => {
  assert.equal(runPolicyValidator(LIVE), true, "the PR Gate would go red on this file");
  assert.equal(runPolicyValidator({ ...LIVE, LIVE_REVIEW_PROVIDER: "anthropic" }), false, "a review-provider mismatch must fail");
});

test("CODEOWNERS owns /agent-roles.yaml: readers trust only the CODEOWNERS-gated copy", () => {
  assert.match(read(".github/CODEOWNERS"), /^\/agent-roles\.yaml @kgsmith19$/m);
});
