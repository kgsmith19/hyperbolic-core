// Hand port of the Standard's runtime-neutral role contract (#467 S2b):
// tools/role_contract.py (std#300 decide, std#301 record) and the
// tools/role_authority.py rules it reuses, at the commit standard.lock pins.
// role-contract.test.mjs replays role-contract-golden.json, which the upstream
// Python computes (docs/ops/role-contract-golden.py), so a drift on either side
// fails there.
//
// Pure data, no I/O, no runtime. Python semantics are reproduced, never
// approximated: str.strip()'s whitespace set, str() of non-strings, truthiness,
// re's Unicode \d and its "$" before one trailing newline, and strptime's own
// field patterns and datetime range checks.

import { pythonSemantics as py } from "./stage63-adoption-lib.mjs";

const SHA = "1686e3b490380194cff78767b88c4e0288410e96";
export const PROVENANCE = `agent-engineering-standard @ ${SHA}: tools/role_contract.py + tools/role_authority.py (std#300, std#301)`;

// --- tools/role_authority.py: the rules role_contract reuses ----------------

const RISKS = ["R0", "R1", "R2", "R3"];
const ROLES = ["spec_author", "spec_critic", "mold_designer", "mold_qualifier", "builder", "verifier",
  "reviewer", "remediator"];
const OWNER_LOGIN = "kgsmith19";
const FROZEN_ROOTS = ["Canonical/corpus/"];
const WRITE_PATHS = {
  spec_author: ["specs/", "plans/"],
  spec_critic: ["evidence/critic-findings/"],
  mold_designer: ["verification/pending/", "evidence/"],
  mold_qualifier: ["evidence/qualification/"],
  builder: ["src/", "plans/", "evidence/builder-notes/"],
  verifier: ["evidence/verification/"],
  reviewer: ["evidence/review/"],
  remediator: ["src/", "evidence/remediation/"],
};
const FORBIDDEN_PATHS = {
  spec_author: ["src/", "tools/", "Canonical/"],
  spec_critic: ["src/", "tools/", "Canonical/", "specs/", "plans/", "verification/"],
  mold_designer: ["src/", "tools/", "Canonical/corpus/"],
  mold_qualifier: ["src/", "tools/", "Canonical/", "verification/pending/"],
  builder: ["Canonical/", "tools/", ".github/"],
  verifier: ["src/", "tools/", "Canonical/", ".github/"],
  reviewer: ["src/", "tools/", "Canonical/", ".github/"],
  remediator: ["Canonical/corpus/", "tools/", ".github/"],
};

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKey = (mapping, key) => Object.prototype.hasOwnProperty.call(mapping, key);
const get = (mapping, key, fallback = null) => (hasKey(mapping, key) ? mapping[key] : fallback);
const own = (mapping, key) => get(mapping, key, undefined);
const isNone = (value) => value === null || value === undefined;
const pyStr = py.strAny; // str(value) of JSON plain data

// Mirrors role_authority._normalize_path: (normalized, is_traversal).
function normalizePath(path) {
  let raw = typeof path === "string" ? path : pyStr(py.truthy(path) ? path : "");
  raw = py.strip(raw.replaceAll("\\", "/")).replace(/^\/+/, "");
  const parts = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return [raw, true];
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return [parts.join("/"), false];
}

// Mirrors role_authority._matches_prefix: whole segments, never substrings.
function matchesPrefix(normalized, prefix) {
  const rooted = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return normalized === rooted.slice(0, -1) || normalized.startsWith(rooted);
}
const underAny = (normalized, prefixes) => prefixes.some((prefix) => matchesPrefix(normalized, prefix));

// Mirrors role_authority._family: the text before "/", stripped and lowered.
function family(provider) {
  const text = py.lower(py.strip(pyStr(py.truthy(provider) ? provider : "")));
  const slash = text.indexOf("/");
  return slash === -1 ? text : py.strip(text.slice(0, slash));
}

// role_authority.provider_separation_ok's verdict (decide reads no message).
function providerSeparationOk(builderProvider, reviewerProvider, risk) {
  let level = pyStr(py.truthy(risk) ? risk : "").toUpperCase();
  if (!RISKS.includes(level)) level = "R1";
  if (level === "R0" || level === "R1") return true;
  return family(builderProvider) !== family(reviewerProvider);
}

// role_authority.owner_override_ok's verdict.
function ownerOverrideOk(override) {
  if (!isMapping(override)) return false;
  if (pyStr(get(override, "owner", "")) !== OWNER_LOGIN) return false;
  if (!py.strip(pyStr(get(override, "decision", "")))) return false;
  return Boolean(py.strip(pyStr(get(override, "scope", ""))));
}

const issueReceipt = (role, agent, provider, head, seq) => ({
  role: pyStr(role), agent: pyStr(agent), provider: pyStr(provider), head: pyStr(head), seq, granted_by: pyStr(agent),
});

// role_authority.check_write's verdict and rule, branch for branch.
function checkWrite(role, receipts, path, currentHead = null) {
  if (!ROLES.includes(role)) return { allowed: false, rule: "unknown-role" };
  if (!Array.isArray(receipts) || receipts.length === 0) return { allowed: false, rule: "no-receipt" };
  const matching = receipts.filter((receipt) => isMapping(receipt) && pyStr(get(receipt, "role", "")) === role);
  if (matching.length === 0) return { allowed: false, rule: "self-promotion" };
  if (!isNone(currentHead) && pyStr(get(matching[0], "head", "")) !== pyStr(currentHead)) {
    return { allowed: false, rule: "stale-receipt" };
  }
  const [normalized, traversal] = normalizePath(path);
  if (traversal) return { allowed: false, rule: "path-traversal" };
  if (underAny(normalized, FROZEN_ROOTS) || normalized === "Canonical/corpus") {
    return { allowed: false, rule: "frozen-root" };
  }
  if (underAny(normalized, FORBIDDEN_PATHS[role] ?? [])) return { allowed: false, rule: "forbidden-path" };
  if (underAny(normalized, WRITE_PATHS[role] ?? [])) return { allowed: true, rule: "write-root" };
  return { allowed: false, rule: "forbidden-path" };
}

// --- tools/role_contract.py -------------------------------------------------

const RULES = ["grant-invalid", "action-invalid", "grant-expired", "stale-head", "self-grant",
  "unverified-provenance", "out-of-scope", "forbidden-self-review", "unauthorized-github-write",
  "owner-override", "privilege-escalation", "parallel-write", "missing-evidence"];
const KINDS = ["write", "review", "verify", "post", "mutate_github"];
const WAIVABLE = ["grant-expired", "stale-head"];
const MAX_WINDOW_SECONDS = 3600;
const GRANT_KEYS = ["actor_id", "run_id", "duty", "scope", "head_sha", "provider", "provenance", "issued_at",
  "expires_at", "grantor"];
const OPTIONAL_GRANT_KEYS = ["github_identity"];

export const CONTRACT = Object.freeze({
  RULES, KINDS, WAIVABLE, MAX_WINDOW_SECONDS, GRANT_KEYS, OPTIONAL_GRANT_KEYS, ROLES, RISKS, OWNER_LOGIN,
  FROZEN_ROOTS, WRITE_PATHS, FORBIDDEN_PATHS,
});

// re.match with "$": without MULTILINE it also matches before one trailing newline.
const SHA_RE = /^[0-9a-f]{40}\n?$/;
const HASH_RE = /^[0-9a-f]{64}\n?$/;
// _TS_RE's \d is Unicode (\p{Nd}).
const TS_RE = /^(\p{Nd}{4})-(\p{Nd}{2})-(\p{Nd}{2})T(\p{Nd}{2}):(\p{Nd}{2}):(\p{Nd}{2})Z\n?$/u;
// strptime's own field patterns (_strptime.TimeRE) for the two-digit fields:
// only the second digit of %d, %H, %M and %S may be a non-ASCII \d; %m is ASCII.
const STRPTIME_FIELDS = [
  /^\p{Nd}{4}$/u, /^(?:1[0-2]|0[1-9])$/, /^(?:3[01]|[12]\p{Nd}|0[1-9])$/u, /^(?:2[0-3]|[01]\p{Nd})$/u,
  /^[0-5]\p{Nd}$/u, /^(?:6[01]|[0-5]\p{Nd})$/u,
];
const ND_RE = /^\p{Nd}$/u;

// int() of a Unicode decimal digit: Nd digits come in contiguous 0..9 runs.
function digitValue(ch) {
  const code = ch.codePointAt(0);
  let start = code;
  while (ND_RE.test(String.fromCodePoint(start - 1))) start -= 1;
  return (code - start) % 10;
}
const decimal = (text) => [...text].reduce((total, ch) => total * 10 + digitValue(ch), 0);

// Days from 1970-01-01 in the proleptic Gregorian calendar, any year 1..9999.
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Mirrors role_contract._parse_ts: epoch seconds, or null when malformed.
function parseTs(value) {
  if (typeof value !== "string") return null;
  const match = TS_RE.exec(value);
  if (!match || value.endsWith("\n")) return null; // strptime: unconverted data remains
  const fields = match.slice(1);
  if (!fields.every((field, index) => STRPTIME_FIELDS[index].test(field))) return null;
  const [year, month, day, hour, minute, second] = fields.map(decimal);
  // datetime(...) range checks: MINYEAR is 1, a second of 60 or 61 is refused.
  if (year < 1 || day > (month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month - 1]) || second > 59) return null;
  return daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
}

const text = (value) => typeof value === "string" && py.strip(value) !== "";

function scopePrefixes(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return null;
  const prefixes = [];
  for (const entry of scope) {
    if (!text(entry)) return null;
    const [normalized, traversal] = normalizePath(entry);
    if (traversal || !normalized) return null;
    prefixes.push(normalized);
  }
  return prefixes;
}

const sameKeys = (mapping, keys) => {
  const actual = Object.keys(mapping);
  return actual.length === keys.length && keys.every((key) => hasKey(mapping, key));
};

function grantMalformed(grant) {
  if (!isMapping(grant)) return true;
  const allowedKeys = [...GRANT_KEYS, ...OPTIONAL_GRANT_KEYS];
  if (Object.keys(grant).some((key) => !allowedKeys.includes(key))) return true;
  if (GRANT_KEYS.some((key) => !hasKey(grant, key))) return true;
  if (!(text(grant.actor_id) && text(grant.run_id) && text(grant.grantor))) return true;
  if (!ROLES.includes(grant.duty)) return true;
  if (scopePrefixes(grant.scope) === null) return true;
  if (!(typeof grant.head_sha === "string" && SHA_RE.test(grant.head_sha))) return true;
  const { provider, provenance } = grant;
  if (!isMapping(provider) || !sameKeys(provider, ["family", "model"])) return true;
  if (!(text(provider.family) && text(provider.model))) return true;
  if (!isMapping(provenance) || !sameKeys(provenance, ["source", "provider_observed"])) return true;
  if (!text(provenance.source) || typeof provenance.provider_observed !== "string") return true;
  const issued = parseTs(grant.issued_at);
  const expires = parseTs(grant.expires_at);
  if (issued === null || expires === null) return true;
  const window = expires - issued;
  if (window <= 0 || window > MAX_WINDOW_SECONDS) return true;
  return hasKey(grant, "github_identity") && typeof grant.github_identity !== "string";
}

function actionMalformed(action) {
  if (!isMapping(action)) return true;
  if (Object.keys(action).some((key) => !["kind", "path", "risk"].includes(key))) return true;
  if (!KINDS.includes(own(action, "kind"))) return true;
  return hasKey(action, "path") && typeof action.path !== "string";
}

function riskOf(action) {
  const level = own(action, "risk");
  return typeof level === "string" && RISKS.includes(level) ? level : "R3";
}

function overrideHonored(override, owner) {
  if (!ownerOverrideOk(override)) return false;
  return isNone(owner) || pyStr(get(override, "owner")) === pyStr(owner);
}

const overlaps = (first, second) => matchesPrefix(first, second) || matchesPrefix(second, first);
const ordered = (rules) => RULES.filter((rule) => rules.has(rule));

// Mirrors role_contract.decide: [allowed, rules], rules in RULES order.
// Options are decide()'s keyword arguments, as plain data.
export function decide(grant, action, options = {}) {
  const now = own(options, "now");
  const currentHead = own(options, "current_head");
  const owner = get(options, "owner");
  const override = get(options, "override");
  const otherGrants = get(options, "other_grants", []);
  const delegated = get(options, "delegated", false);

  if (!Array.isArray(otherGrants) || grantMalformed(grant) || otherGrants.some(grantMalformed)) {
    return [false, ["grant-invalid"]];
  }
  if (actionMalformed(action)) return [false, ["action-invalid"]];

  const rules = new Set();
  const actor = grant.actor_id;
  const duty = grant.duty;
  const head = grant.head_sha;
  const { kind } = action;
  const risk = riskOf(action);

  const issued = parseTs(grant.issued_at);
  const expires = parseTs(grant.expires_at);
  const liveAt = parseTs(now);
  if (liveAt === null || liveAt >= expires || liveAt < issued) rules.add("grant-expired");

  if (head !== currentHead) rules.add("stale-head");

  const { grantor } = grant;
  if (grantor === actor && !(owner === OWNER_LOGIN && grantor === owner)) rules.add("self-grant");

  const observed = grant.provenance.provider_observed;
  if (!text(observed) || family(observed) !== family(grant.provider.family)) rules.add("unverified-provenance");

  const path = get(action, "path");
  if (path === null) {
    if (kind === "write") rules.add("out-of-scope");
  } else {
    const [normalized, traversal] = normalizePath(path);
    const inScope = !traversal && scopePrefixes(grant.scope).some((prefix) => matchesPrefix(normalized, prefix));
    const receipt = issueReceipt(duty, actor, grant.provider.family, head, 1);
    if (!(inScope && checkWrite(duty, [receipt], path, head).allowed)) rules.add("out-of-scope");
  }

  if (kind === "review" || kind === "verify") {
    if (duty === "builder") rules.add("forbidden-self-review");
    for (const other of otherGrants) {
      if (other.duty !== "builder" || other.head_sha !== head) continue;
      const separated = providerSeparationOk(other.provider.family, grant.provider.family, risk);
      if (other.actor_id === actor || !separated) rules.add("forbidden-self-review");
    }
  }

  if (kind === "write") {
    // safe_parallelism's same-files rule is exact-path only; this contract
    // compares scope prefixes, so src/ and src/api/ collide.
    const mine = scopePrefixes(grant.scope);
    for (const other of otherGrants) {
      if (other.actor_id === actor || other.head_sha !== head) continue;
      if ((other.duty === "builder" || other.duty === "remediator")
        && mine.some((a) => scopePrefixes(other.scope).some((b) => overlaps(a, b)))) {
        rules.add("parallel-write");
      }
    }
  }

  if (py.truthy(delegated)) {
    // "controller" is not in ROLES, so the grantor must be the owner or hold a
    // grant of the same duty in this run.
    const isOwner = owner === OWNER_LOGIN && grantor === owner;
    const held = otherGrants.some((other) => other.actor_id === grantor && other.duty === duty);
    if (!(isOwner || held)) rules.add("privilege-escalation");
  }

  if ((kind === "post" || kind === "mutate_github") && !text(get(grant, "github_identity"))) {
    rules.add("unauthorized-github-write");
  }

  if (!isNone(override)) {
    if (overrideHonored(override, owner)) {
      for (const rule of WAIVABLE) rules.delete(rule);
    } else {
      rules.add("owner-override");
    }
  }

  const result = ordered(rules);
  return [result.length === 0, result];
}

const artifactsMalformed = (items) => !Array.isArray(items) || items.some((item) => !isMapping(item)
  || !sameKeys(item, ["path", "sha256"]) || !text(item.path) || typeof item.sha256 !== "string"
  || !HASH_RE.test(item.sha256));

const claimMalformed = (claim) => !isMapping(claim) || !text(get(claim, "id")) || !text(get(claim, "result"))
  || !Array.isArray(get(claim, "artifacts")) || !claim.artifacts.every(text);

const recordMalformed = (specialty, acceptanceIds, claims, inputs, outputs) => (!isNone(specialty) && !text(specialty))
  || !Array.isArray(acceptanceIds) || !acceptanceIds.every(text)
  || !Array.isArray(claims) || claims.some(claimMalformed)
  || artifactsMalformed(inputs) || artifactsMalformed(outputs);

// True when no acceptance id is named, or one lacks a passing claim that
// lists an output artifact path.
function unproven(acceptanceIds, claims, outputs) {
  if (acceptanceIds.length === 0) return true;
  const produced = new Set(outputs.map((artifact) => artifact.path));
  return acceptanceIds.some((cid) => !claims.some((claim) => claim.id === cid && claim.result === "pass"
    && claim.artifacts.some((artifactPath) => produced.has(artifactPath))));
}

const asList = (value) => (Array.isArray(value) ? [...value] : []);

// Mirrors role_contract.record: decide() wrapped in a collaboration receipt.
// Options are record()'s keyword arguments, as plain data.
export function record(grant, action, options = {}) {
  const acceptanceIds = get(options, "acceptance_ids", []);
  const claims = get(options, "claims", []);
  const inputs = get(options, "input_artifacts", []);
  const outputs = get(options, "output_artifacts", []);
  const specialty = get(options, "specialty");
  const now = own(options, "now");
  const currentHead = own(options, "current_head");

  const [allowed, decided] = decide(grant, action, options);
  const rules = new Set(decided);
  if (recordMalformed(specialty, acceptanceIds, claims, inputs, outputs)) {
    rules.add("action-invalid");
  } else if (allowed && (grant.duty === "verifier" || grant.duty === "reviewer")
    && unproven(acceptanceIds, claims, outputs)) {
    rules.add("missing-evidence");
  }
  const result = ordered(rules);
  const fields = isMapping(grant) ? grant : {};
  return {
    schema_version: 1,
    task: get(options, "task"),
    duty: get(fields, "duty"),
    specialty,
    actor_id: get(fields, "actor_id"),
    run_id: get(fields, "run_id"),
    grantor: get(fields, "grantor"),
    provider: get(fields, "provider"),
    provenance: get(fields, "provenance"),
    scope: get(fields, "scope"),
    exact_sha: isNone(currentHead) ? null : currentHead,
    input_artifacts: asList(inputs),
    output_artifacts: asList(outputs),
    acceptance_ids: asList(acceptanceIds),
    claims: asList(claims),
    decision: result.length > 0 ? "refuse" : "allow",
    rules: result,
    decided_at: isNone(now) ? null : now,
  };
}
