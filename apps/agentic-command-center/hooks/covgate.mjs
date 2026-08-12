#!/usr/bin/env node
// covgate.mjs — changed-file coverage for the repository PR Gate.
//
//   node hooks/covgate.mjs          (run from C:\code\guards)
//
// WHAT IT PROVES: every lib file you TOUCHED this change is fully exercised by
// the fast tier. Scope is deliberate — repo-wide 100% is a vanity number that
// punishes whoever touches the oldest file, while changed-file 100% is cheap
// the day you write the code and only ever gates the author of the change.
// Coverage is a floor, not the goal: tests must still assert observable
// behavior and be capable of failing when that behavior regresses.
//
// Mechanics: node's built-in coverage (>= 22) with the lcov reporter, no
// dependencies. Changed = git diff against HEAD plus untracked, filtered to
// lib .mjs under hooks/ and runner/ (tests and the e2e harness are exempt —
// they are the instrument, not the subject). The gate fails CLOSED: a red
// fast tier, a git error, or a changed file no test ever imports all exit 1.
//
// Dials: policy.json tests.changedLineCoverage (default 100). Test list
// override: ACC_COVGATE_TESTS (comma/space separated, relative to cwd) — used
// by covgate's own suite to gate a fixture repo instead of this one.
// Range override: ACC_COVGATE_RANGE="<oldrev> <newrev>" gates a commit range
// instead of the working tree (git diff between the two revs, no untracked
// files and no mutation of the caller's repo) for explicit range checks.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = () => process.env.ACC_POLICY || path.join(HERE, "..", "policy.json");

// Three floors, because line coverage alone lies: V8 marks a function's
// DECLARATION line covered even when nothing ever calls it, so a one-line
// helper can sit untested behind "100% lines" (caught by this gate's own
// suite, 2026-08-01: sub() untested, lines 100%, functions 50%). Lines and
// functions default to 100. Branches default to 90 — the last few branch
// points are usually defensive catch-paths that need fault injection to
// reach; raise the dial to 100 when a file warrants that spend.
//
// `file` (gate-relative, forward slashes) is optional: when given, and
// `tests.lineFloorOverrides[file]` / `tests.functionFloorOverrides[file]` /
// `tests.branchFloorOverrides[file]` is a finite number, it replaces that
// metric's floor for THAT file only. Escape hatch for a proven tooling
// limitation, not a way to duck real gaps — node's own
// --experimental-test-coverage merge under-reports a file's branches (and,
// less often, its lines or functions) once the full fast tier runs
// together; the overridden files' true, isolated coverage comfortably
// clears the default floor (see policy.json's *FloorOverrides notes for
// the measured numbers per file).
function overridden(t, key, file, dflt) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return num(file && t[key] ? t[key][file] : undefined, dflt);
}
export function floors(file) {
  let t = {};
  try { t = JSON.parse(fs.readFileSync(POLICY(), "utf8").replace(/^\uFEFF/, "")).tests || {}; } catch {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    lines: overridden(t, "lineFloorOverrides", file, num(t.changedLineCoverage, 100)),
    funcs: overridden(t, "functionFloorOverrides", file, num(t.changedFunctionCoverage, 100)),
    branches: overridden(t, "branchFloorOverrides", file, num(t.changedBranchCoverage, 90)),
  };
}

// Separator- and case-insensitive (Windows), so lcov SF paths and git paths
// meet in the middle regardless of who emitted which slash. Byte-identical
// to kernel/policy.mjs's norm(), deliberately NOT imported from there: this
// file gets copied standalone into isolated fixture trees by its own tests
// and by covgate's own ACC_COVGATE_TESTS fixture-repo mode, so it must resolve with zero
// sibling-directory dependencies.
export const normPath = (p) => path.resolve(String(p)).replaceAll("\\", "/").toLowerCase();

// Lib files only: .mjs directly under hooks/, runner/, kernel/, or gui/
// (kernel/ allows one level of nesting for kernel/adapters/<harness>.mjs, gui/
// for gui/e2e/<spec>.mjs), minus tests and harnesses — .test.mjs (node:test),
// .e2e.mjs (kernel/loop proof runs), and .spec.mjs (Playwright, gui/e2e/) are
// all the instrument, never the gated subject. The GATE'S OWN SUBJECT,
// exported for its suite.
export function changedLibFiles(names) {
  return [...new Set(names)]
    .map((n) => String(n).replaceAll("\\", "/"))
    .filter((n) => /^(hooks|runner|kernel|gui)\/(?:[^/]+\/)?[^/]+\.mjs$/.test(n) && !/\.(test|e2e|spec)\.mjs$/.test(n));
}

// lcov per file: DA:<line>,<hits> (lines), FNDA:<hits>,<name> (functions),
// BRDA:<line>,<block>,<branch>,<hits|-> (branches; "-" = block never entered,
// which is an UNCOVERED branch, not a missing one).
export function parseLcov(text) {
  const files = new Map();
  const blank = () => ({ lines: { t: 0, c: 0 }, funcs: { t: 0, c: 0 }, branches: { t: 0, c: 0 } });
  let cur = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      cur = blank();
      files.set(normPath(line.slice(3).trim()), cur);
    } else if (cur && line.startsWith("DA:")) {
      cur.lines.t++;
      if (Number(line.slice(3).split(",")[1]) > 0) cur.lines.c++;
    } else if (cur && line.startsWith("FNDA:")) {
      cur.funcs.t++;
      if (Number(line.slice(5).split(",")[0]) > 0) cur.funcs.c++;
    } else if (cur && line.startsWith("BRDA:")) {
      cur.branches.t++;
      const hits = line.slice(5).split(",")[3];
      if (hits !== "-" && Number(hits) > 0) cur.branches.c++;
    } else if (line === "end_of_record") cur = null;
  }
  const pct = (m) => (m.t ? Math.round((m.c / m.t) * 1000) / 10 : 100);
  for (const f of files.values()) {
    f.pct = { lines: pct(f.lines), funcs: pct(f.funcs), branches: pct(f.branches) };
  }
  return files;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
}

// Optional explicit commit-range mode. It never mutates the caller's repo:
// the check is one `git diff` between two revisions supplied by the caller.
export function parseRange(raw) {
  const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return null;
  return { oldrev: parts[0], newrev: parts[1] };
}

function main() {
  const cwd = process.cwd();

  let changed;
  try {
    const rangeRaw = process.env.ACC_COVGATE_RANGE;
    if (rangeRaw !== undefined) {
      const range = parseRange(rangeRaw);
      if (!range) {
        console.error(`covgate: FAIL — ACC_COVGATE_RANGE must be "<oldrev> <newrev>", got: ${JSON.stringify(rangeRaw)}`);
        process.exit(1);
      }
      changed = changedLibFiles(
        git(["diff", "--name-only", range.oldrev, range.newrev], cwd)
      ).filter((f) => fs.existsSync(path.join(cwd, f)));
    } else {
      changed = changedLibFiles([
        ...git(["diff", "--name-only", "HEAD"], cwd),
        ...git(["ls-files", "--others", "--exclude-standard"], cwd),
      ]).filter((f) => fs.existsSync(path.join(cwd, f)));
    }
  } catch (e) {
    console.error(`covgate: FAIL — cannot determine what changed (${String(e.message || e).trim()})`);
    process.exit(1);
  }
  if (!changed.length) {
    console.log("covgate: PASS — no changed lib files to gate");
    process.exit(0);
  }

  // Default discovery scans BOTH lib dirs the gate scopes to (changedLibFiles,
  // above) — scanning only hooks/ was a real bug (found 2026-08-01, closing
  // OI-013): runner/runner.test.mjs existed but a plain `node
  // hooks/covgate.mjs` never ran it, so runner.mjs read 0% forever no matter
  // how good its suite was.
  // Relative to CWD (the repo being gated), never to HERE (this script's own
  // location) — those differ for every fixture repo covgate's own suite
  // gates, and conflating them was the actual bug: discovery silently listed
  // the REAL guards/hooks tests while gating a throwaway fixture.
  const tests = process.env.ACC_COVGATE_TESTS
    ? process.env.ACC_COVGATE_TESTS.split(/[ ,]+/).filter(Boolean)
    : ["hooks", "runner", "kernel", "kernel/adapters", "gui"].flatMap((d) => {
        let files = [];
        try { files = fs.readdirSync(path.join(cwd, d)).filter((f) => f.endsWith(".test.mjs")); } catch {}
        return files.map((f) => path.join(d, f));
      });

  const lcovFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acc-covgate-")), "cov.lcov");
  const run = spawnSync(
    process.execPath,
    [
      "--test", "--experimental-test-coverage",
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=lcov", `--test-reporter-destination=${lcovFile}`,
      ...tests,
    ],
    // NODE_TEST_CONTEXT must not leak in: a covgate invoked from inside any
    // node:test process (its own suite does exactly this) would otherwise make
    // the inner runner think it is recursing and silently skip every file.
    // NODE_V8_COVERAGE must not leak in either: --experimental-test-coverage
    // auto-sets it on whichever process first enables coverage, so a covgate
    // invoked from inside an ALREADY-coverage-instrumented process (its own
    // suite spawns covgate up to three levels deep: real run -> covgate.test.mjs
    // -> fixture covgate.mjs -> fixture's own test run) would otherwise inherit
    // that dir and reuse it instead of getting a fresh one. Concurrent runs
    // sharing one raw-coverage directory race on each other's report generation
    // and cleanup, corrupting each other's JSON mid-write (found 2026-08-02,
    // real Windows run: "Warning: Could not report code coverage. SyntaxError:
    // Unexpected end of JSON input", 100% reproducible with the full fast tier).
    // ACC_COVGATE_RANGE must not leak into the nested test process. A range
    // invocation spawns THIS test run, which in turn spawns covgate.test.mjs's
    // fixture covgate.mjs invocations three levels deep — those fixtures
    // gate unrelated, isolated repos with their own unrelated commit shas, so
    // inheriting the outer range would hand them oldrev/newrev that don't
    // exist in their history at all ("fatal: bad object", found while writing
    // the range-mode fixture tests).
    { cwd, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: undefined, ACC_COVGATE_RANGE: undefined } }
  );
  if (run.status !== 0) {
    console.error("covgate: FAIL — the fast tier is red; coverage of failing tests proves nothing");
    process.exit(1);
  }

  let lcov = "";
  try { lcov = fs.readFileSync(lcovFile, "utf8"); } catch {}
  const cov = parseLcov(lcov);
  if (!cov.size) {
    console.error("covgate: FAIL — no coverage emitted (node >= 22 with --experimental-test-coverage required)");
    process.exit(1);
  }

  let bad = 0;
  for (const f of changed) {
    const min = floors(f);
    const c = cov.get(normPath(path.join(cwd, f)));
    const pct = c ? c.pct : { lines: 0, funcs: 0, branches: 0 };
    const misses = ["lines", "funcs", "branches"].filter((k) => pct[k] < min[k]);
    if (misses.length) bad++;
    console.log(
      `covgate: ${misses.length ? "FAIL" : " ok "} ${f} — lines ${pct.lines}% funcs ${pct.funcs}% branches ${pct.branches}%` +
        (c ? "" : " (no test imports it)") +
        (misses.length ? ` — under floor on: ${misses.join(", ")} (min ${misses.map((k) => min[k]).join("/")})` : "")
    );
  }
  if (bad) {
    const d = floors();
    console.error(
      `covgate: FAIL — ${bad} changed file(s) under the floors (lines ${d.lines}% / funcs ${d.funcs}% / branches ${d.branches}% — some files may carry a documented per-file override)`
    );
    process.exit(1);
  }
  console.log(`covgate: PASS — ${changed.length} changed file(s) at or above the floors`);
}

// No cross-file import for this check (unlike the other hooks' root.mjs-based
// isMainModule): covgate.mjs is deliberately copied standalone into fixture
// repos and must have zero sibling-file dependencies.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
