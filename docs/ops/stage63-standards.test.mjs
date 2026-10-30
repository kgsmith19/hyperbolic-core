// node --test docs/ops/stage63-standards.test.mjs (run from the repo root)
//
// S7 RED characterization (Issue #425): v5 standards/capability-boundary
// semantics from agent-engineering-standard @ 1686e3b490380194cff78767b88c4e0288410e96 —
// tools/standards_route.py (Stage 52 canonical index + JIT route compiler),
// tools/standards_receipt.py (Stage 53 selective receipts, SAT triggers, hash
// binding) and tools/capability_compiler.py (Stage 54a capability bounds:
// sharp edges DENY, sandbox gaps ESCALATE, owner approvals ALLOW on record).
//
// The oracle is stage63-standards-golden.json, computed by the upstream Python
// at the pinned commit. It also embeds the three frozen upstream corpora with
// their upstream results and the exact Python Unicode tables (IGNORECASE folds
// onto ASCII, str.strip whitespace) the ports must reproduce. The live half
// binds the contract to hyperbolic-core's own agent boundaries (AGENTS.md),
// its component topology (project.yaml) and its own R2 slice profile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ADOPTION, FROZEN, GAP_SLICES, checkCapability, compileCapabilities, compileRoute, defaultRouteIndex,
  issueReceipt, provenance, pythonSemantics, receiptHash,
} from "./stage63-adoption-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const golden = JSON.parse(readFileSync(path.join(here, "stage63-standards-golden.json"), "utf8"));

// --- Frozen contract shape ---------------------------------------------------

test("S7 · standards_route contract is frozen: classes, rules, bounds, canonical index", () => {
  const route = FROZEN.standards_route;
  assert.deepEqual([...route.CLASSES], ["AWARE", "ACK", "GUARD", "VERIFY", "GATE", "OWNER"]);
  assert.deepEqual([...route.RULES], [
    "duplicate-id", "missing-id", "orphan-rule", "stale-hash", "contradictory-triggers", "path-expansion",
    "missing-capability", "registry-overload", "route-overload", "malicious-task", "critical-demotion",
    "minimal-route",
  ]);
  assert.equal(route.ROUTE_MIN, 5);
  assert.equal(route.ROUTE_MAX, 15);
  assert.equal(route.INDEX.length, 25);
  const { constants } = golden.route;
  for (const key of ["CLASSES", "SEVERITIES", "FINDING_FIELDS", "RULES", "ROUTE_MIN", "ROUTE_MAX", "INDEX"]) {
    assert.deepEqual(route[key], constants[key], `standards_route.${key} drifted from upstream`);
  }
});

test("S7 · standards_receipt contract is frozen: verdicts, rules, rule verdicts, SAT triggers", () => {
  const receipt = FROZEN.standards_receipt;
  assert.deepEqual([...receipt.VERDICTS], ["ISSUED", "QUIZ", "REFUSE"]);
  assert.deepEqual([...receipt.SAT_TRIGGERS], ["new-provider", "high-risk", "privileged-scope", "authority-change"]);
  assert.equal(receipt.RULES.length, 12);
  for (const key of ["VERDICTS", "SEVERITIES", "FINDING_FIELDS", "RULES", "RULE_VERDICTS", "SAT_TRIGGERS"]) {
    assert.deepEqual(receipt[key], golden.receipt.constants[key], `standards_receipt.${key} drifted from upstream`);
  }
});

test("S7 · capability_compiler contract is frozen: classes, verdicts, rules, frozen-Mold markers", () => {
  const capability = FROZEN.capability_compiler;
  assert.deepEqual([...capability.CLASSES], ["read", "write", "execute", "network", "secrets", "effects"]);
  assert.deepEqual([...capability.VERDICTS], ["ALLOW", "DENY", "ESCALATE"]);
  assert.deepEqual([...capability.FROZEN_MOLD_MARKERS],
    ["Canonical/corpus/", "Canonical/schemas/", "Canonical/capabilities.json"]);
  assert.equal(capability.RULES.length, 12);
  assert.ok(capability.RULES.indexOf("execute-allowlist") === capability.RULES.indexOf("no-sandbox") + 1,
    "std#282 names the execute allowlist between no-sandbox and owner-escalation");
  for (const key of ["CLASSES", "VERDICTS", "SEVERITIES", "FINDING_FIELDS", "RULES", "RULE_VERDICTS",
    "FROZEN_MOLD_MARKERS"]) {
    assert.deepEqual(capability[key], golden.capability.constants[key], `capability_compiler.${key} drifted from upstream`);
  }
});

test("S7 · provenance names all three boundary modules at the pinned SHA", () => {
  for (const module of ["standards_route", "standards_receipt", "capability_compiler"]) {
    assert.match(provenance(), new RegExp(`tools/${module}\\.py`));
    assert.match(golden._provenance, new RegExp(`tools/${module}\\.py`));
  }
  assert.match(golden._provenance, /1686e3b490380194cff78767b88c4e0288410e96/);
});

// --- Python Unicode semantics, proven over every code point -------------------

const allCodePoints = function* allCodePoints() {
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code < 0xd800 || code > 0xdfff) yield code;
  }
};

test("S7 · IGNORECASE folds exactly the non-ASCII code points Python folds onto ASCII letters", () => {
  const folded = {};
  for (const code of allCodePoints()) {
    if (code < 0x80) continue;
    const ch = String.fromCodePoint(code);
    const fold = pythonSemantics.foldAscii(ch);
    if (fold !== ch) folded[code.toString(16).toUpperCase().padStart(4, "0")] = fold;
  }
  assert.deepEqual(folded, golden.casefold);
  assert.equal(pythonSemantics.foldAscii("ABC xyz_\u00c9\u00c5"), "abc xyz_\u00c9\u00c5", "ASCII lowers; other letters stay");
});

test("S7 · strip removes exactly the code points Python's str.isspace() names", () => {
  const removed = [];
  for (const code of allCodePoints()) {
    const ch = String.fromCodePoint(code);
    if (pythonSemantics.strip(`${ch}x${ch}`) === "x") removed.push(code.toString(16).toUpperCase().padStart(4, "0"));
  }
  assert.deepEqual(removed, golden.whitespace);
  assert.equal(pythonSemantics.strip("\ufeff x \x85"), "\ufeff x", "BOM stays, NEL goes, unlike String.prototype.trim");
});

// Inclusive [start, end] runs, binary-searched.
const inRuns = (runs, code) => {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (code < runs[mid][0]) high = mid - 1;
    else if (code > runs[mid][1]) low = mid + 1;
    else return true;
  }
  return false;
};

test("S7 · repr escapes exactly what Python's str.isprintable() rejects, up to Unicode-version skew", () => {
  const { nonprintable, unassigned, version } = golden.unicode;
  const skew = [];
  for (const code of allCodePoints()) {
    if (code === 0x27 || code === 0x5c) continue; // the quote and backslash escape while printable
    const escaped = pythonSemantics.repr(String.fromCodePoint(code)).includes("\\");
    if (escaped === inRuns(nonprintable, code)) continue;
    assert.ok(!escaped && inRuns(unassigned, code),
      `U+${code.toString(16).toUpperCase()}: repr diverges from Python beyond Unicode ${version} vs ${process.versions.unicode} skew`);
    skew.push(code);
  }
  // Only code points Python's Unicode database still leaves unassigned may
  // render unescaped here (assigned by a newer Unicode); with equal versions
  // there is no skew at all.
  if (process.versions.unicode === version) assert.deepEqual(skew, []);
  assert.equal(pythonSemantics.repr("\ud800"), "'\\ud800'", "a lone surrogate escapes like Python's");
});

// The golden file is written with sorted keys, so each value is replayed with
// reversed key insertion order: the port must sort, not trust the input order.
const reversedKeys = (value) => (value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]))
  : value);

test("S7 · json.dumps forms match Python, sort_keys in code-point order", () => {
  for (const c of golden.json_dumps) {
    const { sort_keys: sortKeys = false, separators, ensure_ascii: ensureAscii = true, indent = null } = c.options;
    const options = { sortKeys, ensureAscii, indent, ...(separators ? { separators } : {}) };
    assert.equal(pythonSemantics.jsonDumps(c.value, options), c.dumps, c.label);
    assert.equal(pythonSemantics.jsonDumps(reversedKeys(c.value), options), c.dumps, `${c.label} (reversed keys)`);
  }
});

test("S7 · sorting compares code points like Python, not UTF-16 units", () => {
  assert.deepEqual(["\u{1F600}", "\uffff", "a"].sort(pythonSemantics.compareCodePoints), ["a", "\uffff", "\u{1F600}"]);
  assert.deepEqual(["\u{1F600}", "\uffff"].sort(), ["\u{1F600}", "\uffff"], "the JS default differs, so the comparator matters");
});

// --- Differential characterization against the upstream Python ----------------

test("S7 · defaultRouteIndex matches upstream default_index (homes, classes, source hashes)", () => {
  assert.deepEqual(defaultRouteIndex(), golden.route.default_index);
});

for (const c of golden.route.cases) {
  test(`S7 · compileRoute matches upstream: ${c.label}`, () => {
    const options = c.index !== undefined ? { index: c.index } : { entries: c.entries };
    if (c.result.error !== undefined) {
      assert.throws(() => compileRoute(c.task, options), (e) => e.name === c.result.error);
      return;
    }
    assert.deepEqual(compileRoute(c.task, options), c.result);
  });
}

for (const c of golden.receipt.decisions) {
  test(`S7 · issueReceipt matches upstream: ${c.label}`, () => {
    assert.deepEqual(issueReceipt(c.attempt), c.result);
  });
}

for (const c of golden.receipt.hashes) {
  test(`S7 · receiptHash matches upstream: ${c.label}`, () => {
    assert.equal(receiptHash(c.route, c.ack, c.standard), c.digest);
  });
}

for (const c of golden.capability.checks) {
  test(`S7 · checkCapability matches upstream: ${c.label}`, () => {
    assert.deepEqual(checkCapability(c.action), c.result);
  });
}

for (const c of golden.capability.profiles) {
  test(`S7 · compileCapabilities matches upstream: ${c.label}`, () => {
    assert.deepEqual(compileCapabilities(c.profile), c.bounds);
  });
}

test("S7 · golden corpus exercises every route, receipt and capability rule", () => {
  const routeRules = new Set(golden.route.cases.flatMap((c) => (c.result.findings ?? []).map((f) => f.rule)));
  assert.deepEqual([...FROZEN.standards_route.RULES].filter((rule) => !routeRules.has(rule)), []);
  const receiptRules = new Set(golden.receipt.decisions.map((c) => c.result.rule));
  assert.deepEqual([...FROZEN.standards_receipt.RULES].filter((rule) => !receiptRules.has(rule)), []);
  const capabilityRules = new Set(golden.capability.checks.map((c) => c.result.rule));
  assert.deepEqual([...FROZEN.capability_compiler.RULES].filter((rule) => !capabilityRules.has(rule)), []);
  assert.ok(golden.route.cases.some((c) => c.result.error === "UnicodeEncodeError"),
    "the one upstream crash (a lone surrogate rule id cannot be hashed) is characterized too");
});

// --- The frozen upstream corpora, replayed through the ports ------------------

const sortedRules = (findings) => [...new Set(findings.map((f) => f.rule))].sort();

test("S7 · every frozen standards-route corpus entry routes as upstream adjudicated", () => {
  const entries = golden.corpus.route;
  assert.ok(entries.length >= 11);
  for (const entry of entries) {
    const result = compileRoute(entry.task ?? {}, { entries: entry.index ?? null });
    assert.deepEqual(result, entry.result, entry.id);
    assert.deepEqual(sortedRules(result.findings), [...entry.expected_rules].sort(), entry.id);
    if (entry.expected_rules.length === 0) {
      const { ROUTE_MIN, ROUTE_MAX } = FROZEN.standards_route;
      assert.ok(result.route.length >= ROUTE_MIN && result.route.length <= ROUTE_MAX, entry.id);
    }
  }
  assert.deepEqual(sortedRules(entries.flatMap((e) => e.expected_rules.map((rule) => ({ rule })))),
    [...FROZEN.standards_route.RULES].sort(), "the corpus covers all 11 route rules");
});

test("S7 · every frozen standards-receipt corpus entry issues as upstream adjudicated", () => {
  const entries = golden.corpus.receipt;
  assert.ok(entries.length >= 12);
  for (const entry of entries) {
    const result = issueReceipt(entry.attempt ?? {});
    assert.deepEqual(result, entry.result, entry.id);
    assert.equal(result.rule, entry.expected_rule, entry.id);
    assert.equal(result.verdict, entry.expected_verdict, entry.id);
  }
  assert.deepEqual(new Set(entries.map((e) => e.expected_rule)), new Set(FROZEN.standards_receipt.RULES));
});

test("S7 · every frozen capability-compiler corpus entry decides as upstream adjudicated", () => {
  const entries = golden.corpus.capability;
  assert.ok(entries.length >= 11);
  for (const entry of entries) {
    const result = checkCapability(entry.action ?? {});
    assert.deepEqual(result, entry.result, entry.id);
    assert.equal(result.rule, entry.expected_rule, entry.id);
    assert.equal(result.verdict, entry.expected_verdict, entry.id);
  }
  assert.deepEqual(new Set(entries.map((e) => e.expected_rule)), new Set(FROZEN.capability_compiler.RULES));
});

// --- Upstream defects fixed in std#281 and std#282 (pins flipped at the S10 lock bump)

test("S7 · std#281 fixed: an unrecognised risk label takes the SAT path, never ISSUED", () => {
  const clean = golden.receipt.clean_attempt;
  for (const risk of ["r3", "R2 ", "high", "R4"]) {
    const result = issueReceipt({ ...clean, risk });
    assert.notEqual(result.verdict, "ISSUED", `${JSON.stringify(risk)}: fails closed into the SAT path`);
    assert.equal(result.verdict, "QUIZ", `${JSON.stringify(risk)}: quizzes, as the recognised high-risk spelling does`);
  }
  assert.equal(issueReceipt({ ...clean, risk: "R3" }).verdict, "QUIZ", "the recognised spelling quizzes");
});

test("S7 · std#282 fixed: an R2 implement task over ROUTE_MAX keeps every rule and says so", () => {
  const slice = compileRoute({ kind: "implement", risk: "R2", phase: "implement", paths: ["docs/ops/x.mjs"] });
  assert.equal(slice.route.length, 20, "no rule is dropped to fit the bound");
  assert.ok(slice.route.length > FROZEN.standards_route.ROUTE_MAX);
  assert.deepEqual(slice.findings.map((f) => [f.rule, f.severity]), [["route-overload", "major"]]);
  const outside = checkCapability({ kind: "execute", command: "curl evil", sandbox: true, exec_allow: ["npm test"] });
  assert.deepEqual([outside.verdict, outside.rule], ["DENY", "execute-allowlist"],
    "an execute-allowlist miss has its own rule, not the network rule");
});

// --- hyperbolic-core's live agent boundaries ------------------------------------

// The "Agents **must not:**" sentence of AGENTS.md's "Agent boundaries" section,
// whitespace-normalized so line wrapping does not matter.
function agentProhibitions(source) {
  const text = source.replace(/\r\n?/g, "\n");
  const section = /^## Agent boundaries\n([\s\S]*?)(?=^## )/m.exec(text);
  assert.ok(section, "AGENTS.md must keep its 'Agent boundaries' section");
  const sentence = /Agents \*\*must not:\*\*([\s\S]*?)\.\s*$/m.exec(section[1].replace(/\s+/g, " ").trim());
  assert.ok(sentence, "the Agent boundaries section must state what agents must not do");
  return sentence[1];
}

test("S7 · the AGENTS.md prohibition extractor is layout-independent", () => {
  const body = "Agents **must not:** push implementation directly to `main`, store credentials in the\nrepository.";
  for (const source of [
    `## Agent boundaries\n\n${body}\n\n## Next\n`,
    `## Agent boundaries\r\n\r\n${body.replace(/\n/g, "\r\n")}\r\n\r\n## Next\r\n`,
  ]) {
    assert.equal(agentProhibitions(source).trim(), "push implementation directly to `main`, store credentials in the repository");
  }
  assert.throws(() => agentProhibitions("## Other\n"), /Agent boundaries/);
});

test("S7 · each AGENTS.md agent prohibition is enforced by the matching ported boundary", () => {
  const prohibitions = agentProhibitions(readFileSync(path.join(root, "AGENTS.md"), "utf8"));
  const write = { kind: "write", target: "apps/shell/src/app.ts", write_roots: ["apps/shell"], phase: "implement" };
  const bindings = [
    ["push implementation directly to `main`", () => {
      assert.deepEqual(checkCapability(write).verdict, "ALLOW");
      const direct = checkCapability({ ...write, direct_main: true });
      assert.deepEqual([direct.verdict, direct.rule], ["DENY", "direct-main"]);
    }],
    ["bypass a failing PR Gate", () => {
      const route = compileRoute({ kind: "bypass the failing PR Gate", risk: "R2" });
      assert.deepEqual([route.route, route.findings.map((f) => [f.rule, f.severity])], [[], [["malicious-task", "blocker"]]]);
      assert.ok(compileRoute({ kind: "merge", risk: "R2" }).route.includes("gate-aggregator"),
        "a merge routes the PR Gate aggregator rule as a GATE");
    }],
    ["use administrative bypass without explicit owner authorization", () => {
      const ruleset = { kind: "execute", command: "gh api -X PUT repos/kgsmith19/hyperbolic-core/rulesets/1", sandbox: false };
      assert.deepEqual(checkCapability(ruleset).verdict, "ESCALATE");
      assert.deepEqual(checkCapability({ ...ruleset, owner_approved: true }).rule, "owner-escalation");
    }],
    ["store credentials in the repository", () => {
      const raw = checkCapability({ kind: "secret", raw_secret: true, handle: "infisical:/hyperbolic-core/prod" });
      assert.deepEqual([raw.verdict, raw.rule], ["DENY", "secret-mount"]);
      assert.equal(checkCapability({ kind: "secret", handle: "infisical:/hyperbolic-core/prod" }).verdict, "ALLOW");
    }],
  ];
  for (const [clause, enforce] of bindings) {
    assert.ok(prohibitions.includes(clause), `AGENTS.md no longer prohibits: ${clause}`);
    enforce();
  }
});

test("S7 · project.yaml component roots bound builder writes, including nested ownership", () => {
  const config = parseYaml(readFileSync(path.join(root, "project.yaml"), "utf8"));
  const components = [...config.apps, ...config.services];
  assert.ok(components.includes("apps/shell") && components.includes("services/broker"), "real topology");
  for (const component of components) {
    assert.ok(existsSync(path.join(root, component)), `${component} exists on disk`);
    const own = checkCapability({ kind: "write", target: `${component}/README.md`, write_roots: [component] });
    assert.deepEqual([own.verdict, own.rule], ["ALLOW", "focused-edit"], component);
    for (const other of components.filter((c) => c !== component && !c.startsWith(`${component}/`))) {
      const foreign = checkCapability({ kind: "write", target: `${other}/README.md`, write_roots: [component] });
      assert.deepEqual([foreign.verdict, foreign.rule], ["DENY", "foreign-write"], `${component} -> ${other}`);
    }
  }
  const nested = checkCapability({ kind: "write", target: "packages/guards/x.ps1", write_roots: ["apps/toolbelt"] });
  // packages/guards is a shared package now, not a component of the toolbelt root, so the toolbelt may not write into it.
  assert.deepEqual([nested.verdict, nested.rule], ["DENY", "foreign-write"], "packages/guards is outside the toolbelt root");
});

test("S7 · hyperbolic-core's own R2 slice routes every critical rule at ACK or stronger", () => {
  const slice = compileRoute({ kind: "implement", risk: "R2", phase: "implement",
    paths: ["docs/ops/stage63-adoption-lib.mjs", "docs/ops/stage63-standards.test.mjs"] });
  const critical = FROZEN.standards_route.INDEX.filter(([, , , isCritical]) => isCritical).map(([id]) => id);
  assert.deepEqual(critical.filter((id) => !slice.route.includes(id)), [], "R2 pulls in every critical rule");
  for (const id of critical) assert.notEqual(slice.classes[id], "AWARE", id);
  assert.deepEqual(compileRoute({ kind: "plan", risk: "R0" }).route, ["route-minimal"], "R0 planning stays minimal");
});

test("S7 · standards and capability rows are grounded", () => {
  const rows = Object.keys(ADOPTION).filter((key) => key.startsWith("standards:") || key.startsWith("capability:"));
  assert.deepEqual(rows.sort(), [
    "capability:agent-boundaries", "capability:sharp-edge-bounds", "standards:receipt-binding",
    "standards:route-index",
  ], "S7 contributes exactly four boundary rows");
  assert.deepEqual(ADOPTION["capability:agent-boundaries"], { mechanism: "AGENTS.md", gap: null });
  for (const key of rows) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null, `${key} must be mechanism XOR gap`);
    if (entry.mechanism !== null) assert.ok(existsSync(path.join(root, entry.mechanism)), `${key}: ${entry.mechanism}`);
    else assert.ok(GAP_SLICES.includes(entry.gap));
  }
});
