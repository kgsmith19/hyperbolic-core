// node --test docs/ops/stage63-repo-map.test.mjs (run from the repo root)
//
// Stage 63 docs:bounded-map-artifact (closed in S10, #428): hyperbolic-core's
// bounded repository map. tools/repo_map.py (agent-engineering-standard @
// 516fdb2) is ported into stage63-adoption-lib.mjs and replayed against golden
// Python output twice: with its frozen plane patterns (the contract, every
// refusal message included), and rebound to this repository's plane patterns
// from docs/ops/repo-map-source.json. In the second replay upstream build()
// computes the map from the same source the JS generator reads, so
// docs/repo-map.json has an oracle independent of the port that renders it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADOPTION, FROZEN, GAP_SLICES, buildRepoMap, gapsOf, planeFor, validateMapEdit,
} from "./stage63-adoption-lib.mjs";
import { MAP_ARTIFACT, MAP_SOURCE, renderRepoMap, staleness } from "./stage63-repo-map.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const golden = JSON.parse(read("docs/ops/stage63-repo-map-golden.json"));
const source = JSON.parse(read(MAP_SOURCE));
const SHA = "1686e3b490380194cff78767b88c4e0288410e96";

// A thrown error becomes {error, message}, the shape the golden records.
const outcome = (call) => {
  try {
    return { value: call() };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
};

test("map · golden is pinned to the lock SHA and its own generator", () => {
  assert.match(golden._provenance, new RegExp(`${SHA}: tools/repo_map\\.py$`));
  assert.equal(golden._generator, "docs/ops/stage63-repo-map-golden.py");
  assert.equal(golden._python, "3.12");
  assert.match(read("standard.lock"), new RegExp(`commit: ${SHA}`));
});

// --- the frozen upstream contract ----------------------------------------------

test("map · repo_map constants match upstream", () => {
  const { constants } = golden.frozen;
  const frozen = FROZEN.repo_map;
  for (const key of ["PLANES", "MAP_BUDGET_ENTRIES", "GENERATED_PATTERNS", "ARTIFACT_PATTERNS",
    "CACHE_PATTERNS", "EVIDENCE_PATTERNS", "PROTECTED_PATTERNS"]) {
    assert.deepEqual(Array.isArray(frozen[key]) ? [...frozen[key]] : frozen[key], constants[key], key);
  }
});

test("map · planeFor reproduces upstream plane_for on every probe, precedence included", () => {
  assert.ok(golden.frozen.plane_for.length >= 25);
  for (const { path: probe, plane } of golden.frozen.plane_for) {
    assert.equal(planeFor(probe), plane, JSON.stringify(probe));
  }
});

test("map · buildRepoMap reproduces upstream build, every refusal and message included", () => {
  const ids = new Set();
  for (const { id, input, output } of golden.frozen.build) {
    ids.add(id);
    assert.deepEqual(outcome(() => buildRepoMap(structuredClone(input))), output, id);
  }
  for (const id of ["budget-over", "duplicate", "declared-wrong", "missing-reason", "path-int", "path-list"]) {
    assert.ok(ids.has(id), `the golden covers ${id}`);
  }
});

test("map · buildRepoMap does not mutate the caller's entries", () => {
  const entries = [{ path: "b", reason: "r" }, { path: "a", reason: "r" }];
  buildRepoMap(entries);
  assert.deepEqual(entries, [{ path: "b", reason: "r" }, { path: "a", reason: "r" }]);
});

test("map · validateMapEdit reproduces upstream validate_edit", () => {
  for (const { path: target, plane, output } of golden.frozen.validate_edit) {
    assert.equal(validateMapEdit(target, plane), output, `${target} @ ${plane}`);
  }
});

test("map · upstream fix std#299 is picked up: a path starting with \"main\" is source again", () => {
  // Flipped by the lock bump to 1686e3b (#467 S2a): upstream dropped the branch
  // name from PROTECTED_PATTERNS, so a leading "main" is no longer a path prefix.
  for (const probe of ["main.py", "maintenance.md", "domain/main.py"]) {
    assert.equal(planeFor(probe), "source", probe);
  }
});

// --- hyperbolic-core's binding and the committed artifact ----------------------

test("map · hyperbolic-core binds every non-source plane to its own paths, never the branch name", () => {
  assert.deepEqual(source.patterns, golden.hyp.patterns, "the golden read the same source");
  assert.deepEqual(Object.keys(source.patterns).sort(),
    FROZEN.repo_map.PLANES.filter((plane) => plane !== "source").sort());
  assert.deepEqual(source.patterns.protected, [".github/workflows/pr-verify.yml"],
    "pr-verify.yml hosts the PR Gate, the only required check");
  assert.ok(!source.patterns.protected.includes("main"), "std#299 is not inherited");
  for (const { path: probe, plane } of golden.hyp.plane_for) {
    assert.equal(planeFor(probe, source.patterns), plane, probe);
  }
});

test("map · the port builds exactly the map upstream builds from the same source", () => {
  assert.deepEqual(buildRepoMap(source.entries, source.patterns), golden.hyp.map);
});

test("map · docs/repo-map.json is byte-identical to the upstream-built map and to the generator", () => {
  const artifact = read(MAP_ARTIFACT);
  assert.equal(artifact, golden.hyp.artifact_text, "regenerate: node docs/ops/stage63-repo-map.mjs --write");
  assert.equal(artifact, renderRepoMap(source), "the generator renders the committed artifact");
});

test("map · the generator's --check passes on the committed artifact and fails a hand edit", () => {
  const check = (...extra) => spawnSync(process.execPath, ["docs/ops/stage63-repo-map.mjs", "--check", ...extra],
    { cwd: root, encoding: "utf8" });
  const current = check();
  assert.equal(current.status, 0, current.stdout + current.stderr);
  const dir = mkdtempSync(path.join(tmpdir(), "repo-map-"));
  try {
    const edited = path.join(dir, "repo-map.json");
    writeFileSync(edited, read(MAP_ARTIFACT).replace('"plane": "generated"', '"plane": "source"'));
    const stale = check(edited);
    assert.equal(stale.status, 1, "a hand-edited map fails --check");
    assert.match(stale.stderr, /is stale; run node docs\/ops\/stage63-repo-map\.mjs --write/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("map · a stale or hand-edited artifact is caught", () => {
  const artifact = read(MAP_ARTIFACT);
  assert.equal(staleness(source, artifact), null);
  assert.match(staleness(source, artifact.replace('"plane": "generated"', '"plane": "source"')), /is stale/);
  assert.match(staleness(source, ""), /is stale/);
  const added = { ...source, entries: [...source.entries, { path: "README.md", reason: "repository overview for humans" }] };
  assert.match(staleness(added, artifact), /is stale/, "a source edit without --write is stale");
});

test("map · the map stays bounded, reasoned and grounded on disk", () => {
  const { entries } = golden.hyp.map;
  assert.ok(entries.length <= FROZEN.repo_map.MAP_BUDGET_ENTRIES, "within the 60-entry budget");
  assert.ok(entries.length >= 20, "orients across apps, services, packages, CI and docs");
  for (const entry of entries) {
    assert.ok(existsSync(path.join(root, entry.path)), `${entry.path} is mapped but missing`);
    assert.ok(entry.reason.trim().length >= 20, `${entry.path} needs a real reason`);
    assert.notEqual(entry.plane, "cache", `${entry.path}: caches are never mapped`);
  }
  for (const rel of ["AGENTS.md", "project.yaml", "standard.lock", ".github/workflows/pr-verify.yml"]) {
    assert.ok(entries.some((entry) => entry.path === rel), `${rel} is on the map`);
  }
  for (const listed of ["apps", "services"]) {
    const declared = read("project.yaml").match(new RegExp(`^${listed}:\\n((?:  - .+\\n)+)`, "m"))[1]
      .split("\n").filter(Boolean).map((line) => line.replace(/^ {2}- /, ""));
    for (const rel of declared) assert.ok(entries.some((entry) => entry.path === rel), `project.yaml ${listed}: ${rel}`);
  }
});

test("map · the artifact is in the generated plane, so a direct edit is refused", () => {
  const self = golden.hyp.map.entries.find((entry) => entry.path === MAP_ARTIFACT);
  assert.equal(self.plane, "generated");
  assert.match(validateMapEdit(MAP_ARTIFACT, self.plane), /regenerate via the owning tool/);
  assert.equal(validateMapEdit("AGENTS.md", "source"), null);
});

test("map · AGENTS.md points agents at the map and says it is never authoritative", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /docs\/repo-map\.json/);
  assert.match(agents, /node docs\/ops\/stage63-repo-map\.mjs --write/);
  assert.match(agents, /never authoritative/);
});

// --- honesty: the last Stage 63 gap is closed ----------------------------------

test("map · docs:bounded-map-artifact is grounded on the artifact and Stage 63 has no gaps left", () => {
  assert.deepEqual(ADOPTION["docs:bounded-map-artifact"], { mechanism: MAP_ARTIFACT, gap: null });
  assert.deepEqual(gapsOf(), []);
  assert.deepEqual([...GAP_SLICES], []);
});
