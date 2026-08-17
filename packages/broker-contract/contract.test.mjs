// node --test services/broker/contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_REQUEST_FIELDS,
  validateRequest,
  validatePolicyEntry,
  validatePolicyDocument,
  isKnownCaller,
} from "./contract.mjs";

const goodRequest = () => ({ caller: "llm-handler", token: "tok_abc123", targetHost: "api.anthropic.com" });
const goodPolicyEntry = () => ({ allowedHosts: ["api.anthropic.com"], vaultKeys: ["LLM_KEYS_ANTHROPIC"], maxUsdPerDay: 5 });

test("a complete request validates", () => {
  assert.deepEqual(validateRequest(goodRequest()), { ok: true, errors: [] });
});

test("a null/undefined request is treated as empty, reporting every missing required field", () => {
  assert.equal(validateRequest(null).ok, false);
  assert.equal(validateRequest(undefined).errors.length, REQUIRED_REQUEST_FIELDS.length);
});

test("every required request field is required, and the error names it", () => {
  for (const field of REQUIRED_REQUEST_FIELDS) {
    const r = goodRequest();
    delete r[field];
    const result = validateRequest(r);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes(field)), `missing ${field} must be reported by name`);
  }
});

test("an empty-string required field is rejected the same as a missing one", () => {
  const r = goodRequest();
  r.caller = "";
  assert.equal(validateRequest(r).ok, false);
});

test("a non-string required field is rejected", () => {
  const r = goodRequest();
  r.token = 12345;
  assert.equal(validateRequest(r).ok, false);
});

test("purpose is optional but must be a string when present", () => {
  assert.equal(validateRequest(goodRequest()).ok, true, "omitted purpose is fine");
  const withPurpose = { ...goodRequest(), purpose: "provider completion" };
  assert.equal(validateRequest(withPurpose).ok, true);
  const badPurpose = { ...goodRequest(), purpose: 42 };
  assert.equal(validateRequest(badPurpose).ok, false);
});

test("a complete policy entry validates", () => {
  assert.deepEqual(validatePolicyEntry(goodPolicyEntry()), { ok: true, errors: [] });
});

test("a policy entry with no keys at all is tolerated -- an empty allowance, not a malformed one", () => {
  assert.deepEqual(validatePolicyEntry({}), { ok: true, errors: [] });
  assert.deepEqual(validatePolicyEntry(null), { ok: true, errors: [] });
});

test("allowedHosts/vaultKeys must be arrays of strings, not a bare string or mixed types", () => {
  for (const key of ["allowedHosts", "vaultKeys"]) {
    const bareString = validatePolicyEntry({ [key]: "api.anthropic.com" });
    assert.equal(bareString.ok, false, `${key}: a bare string must be rejected, not silently treated as one entry`);

    const mixedTypes = validatePolicyEntry({ [key]: ["ok.example.com", 42] });
    assert.equal(mixedTypes.ok, false, `${key}: a non-string element must be rejected`);
  }
});

test("maxUsdPerDay must be a positive number or null (no cap) -- zero and negative are rejected", () => {
  assert.equal(validatePolicyEntry({ maxUsdPerDay: null }).ok, true, "null means no cap, explicitly allowed");
  assert.equal(validatePolicyEntry({ maxUsdPerDay: 0.01 }).ok, true);
  assert.equal(validatePolicyEntry({ maxUsdPerDay: 0 }).ok, false, "zero must be rejected, not treated as unlimited or valid");
  assert.equal(validatePolicyEntry({ maxUsdPerDay: -5 }).ok, false);
  assert.equal(validatePolicyEntry({ maxUsdPerDay: "5" }).ok, false, "a numeric string must not pass as a number");
});

test("a complete policy document validates with no errors, multiple callers", () => {
  const doc = { "llm-handler": goodPolicyEntry(), brain: { allowedHosts: [], vaultKeys: [], maxUsdPerDay: null } };
  const result = validatePolicyDocument(doc);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("a policy document is a plain object keyed by caller id -- an array or a scalar is refused, not partially read", () => {
  for (const bad of [[], ["not", "an", "object"], "a string", 42, null]) {
    const result = validatePolicyDocument(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test("a policy document error names the offending caller id, not just the field", () => {
  const doc = { "llm-handler": goodPolicyEntry(), "bad-caller": { maxUsdPerDay: -1 } };
  const result = validatePolicyDocument(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("bad-caller")), "error must name the offending caller");
  assert.ok(!result.errors.some((e) => e.includes("llm-handler")), "the well-formed caller must not appear in the errors");
});

test("isKnownCaller is deny-by-default: absent from the policy document means unknown, not merely unconfigured", () => {
  const doc = { "llm-handler": goodPolicyEntry() };
  assert.equal(isKnownCaller("llm-handler", doc), true);
  assert.equal(isKnownCaller("some-new-service", doc), false);
  assert.equal(isKnownCaller("llm-handler", {}), false);
  assert.equal(isKnownCaller("llm-handler", null), false, "a missing/unreadable policy document must deny every caller, not throw");
});

test("no function in this module throws on malformed input -- everything is refused via {ok:false}", () => {
  const inputs = [null, undefined, 42, "a string", [], () => {}];
  for (const input of inputs) {
    assert.doesNotThrow(() => validateRequest(input));
    assert.doesNotThrow(() => validatePolicyEntry(input));
    assert.doesNotThrow(() => validatePolicyDocument(input));
    assert.doesNotThrow(() => isKnownCaller("x", input));
  }
});
