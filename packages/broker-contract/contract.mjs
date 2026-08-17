// The broker's request/policy contract: the shape every proxied call and
// every generated broker-policy.json must satisfy before either is trusted
// elsewhere in the broker pipeline. Log-only pass-through, manifest
// aggregation, and enforcement all build on this file rather than
// re-deriving the shape independently -- one definition, checked here.
//
// Deliberately shape-only: this module never decides whether a request is
// ALLOWED (that is the enforcement check, once it exists) -- only whether a
// request or a policy document is well-formed enough to evaluate at all. A
// malformed input is refused with a clear reason, never thrown as an
// uncaught exception (mirrors the ACC kernel's own contract.mjs).

export const REQUIRED_REQUEST_FIELDS = Object.freeze(["caller", "token", "targetHost"]);
const POLICY_ENTRY_ARRAY_KEYS = Object.freeze(["allowedHosts", "vaultKeys"]);

export function validateRequest(request) {
  const errors = [];
  // Normalized before any property access: a function passed by mistake
  // would otherwise crash here specifically, because "caller" (one of our
  // own required field names) collides with the poisoned `Function.caller`
  // own-property that strict-mode functions throw on access -- refused
  // cleanly like every other malformed shape, not a special case for it.
  const r = request && typeof request === "object" && !Array.isArray(request) ? request : {};
  for (const field of REQUIRED_REQUEST_FIELDS) {
    if (typeof r[field] !== "string" || r[field].length === 0) {
      errors.push(`request is missing required field "${field}" (must be a non-empty string)`);
    }
  }
  if (r.purpose !== undefined && typeof r.purpose !== "string") {
    errors.push("request.purpose must be a string when present");
  }
  return { ok: errors.length === 0, errors };
}

export function validatePolicyEntry(entry) {
  const errors = [];
  const e = entry || {};
  for (const key of POLICY_ENTRY_ARRAY_KEYS) {
    if (e[key] === undefined) continue;
    if (!Array.isArray(e[key])) {
      errors.push(`policy entry.${key} must be an array`);
    } else if (e[key].some((v) => typeof v !== "string")) {
      errors.push(`policy entry.${key} must contain only strings`);
    }
  }
  if (e.maxUsdPerDay !== undefined && e.maxUsdPerDay !== null) {
    if (typeof e.maxUsdPerDay !== "number" || !(e.maxUsdPerDay > 0)) {
      errors.push("policy entry.maxUsdPerDay must be a positive number or null (no budget cap)");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validatePolicyDocument(doc) {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, errors: ["policy document must be a JSON object keyed by caller id"] };
  }
  const errors = [];
  for (const [caller, entry] of Object.entries(doc)) {
    const result = validatePolicyEntry(entry);
    if (!result.ok) errors.push(...result.errors.map((e) => `caller "${caller}": ${e}`));
  }
  return { ok: errors.length === 0, errors };
}

// Deny-by-default is a shape question (is this id even present?), not a
// policy question (what may it reach?) -- the latter is an enforcement
// concern this module deliberately does not implement.
export function isKnownCaller(callerId, policyDocument) {
  return Object.prototype.hasOwnProperty.call(policyDocument || {}, callerId);
}
