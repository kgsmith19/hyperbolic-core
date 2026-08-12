// Property-based tests for scripts/validate-migrations.mjs. Dependency-free
// by design (no fast-check/etc): apps/toolbelt has no package.json yet and
// this repo's convention is "dependency-free unless a concrete need", so
// this is a small seeded PRNG plus case generators, not a library.
//
// Each property runs many (default 300) randomized cases and asserts an
// invariant the implementation must hold regardless of the specific input,
// which is a materially different, stronger claim than the example-based
// tests in validate-migrations.test.mjs: those prove "this one input works",
// these prove "no input in this whole shape breaks it". Seeded for
// reproducibility -- a failure prints the seed and the exact failing case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDownPairing,
  checkBrainSchemaReservation,
  checkOwnerCallWrapping,
  checkVersionCollisions,
} from "../scripts/validate-migrations.mjs";

// --- seeded PRNG (mulberry32) -----------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
function randDigits(rng, n) {
  let s = "";
  for (let i = 0; i < n; i += 1) s += randInt(rng, 0, 9);
  return s;
}
function randWord(rng) {
  const syll = ["core", "idea", "prompt", "usage", "owner", "pin", "seed", "fix", "bootstrap", "render", "tag", "score"];
  const n = randInt(rng, 1, 3);
  return Array.from({ length: n }, () => pick(rng, syll)).join("_");
}
function randWhitespace(rng) {
  return pick(rng, ["", " ", "  ", "\t", " \t "]);
}

const SEED = 20260812; // fixed: reproducible CI runs, not "flaky until re-run"
const TRIALS = 300;

function withFixtureDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "migrations-property-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Property 1: checkDownPairing flags a non-down file if and only if its
// exact "<stem>_down.sql" companion is absent from the same directory.
test("property: checkDownPairing flags exactly the up files with no down companion", () => {
  const rng = makeRng(SEED);
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const n = randInt(rng, 0, 8);
    const files = {};
    for (let i = 0; i < n; i += 1) {
      const ts = randDigits(rng, 14);
      const stem = `${ts}_${randWord(rng)}`;
      files[`${stem}.sql`] = "select 1;";
      if (rng() < 0.5) files[`${stem}_down.sql`] = "select 1;";
    }
    withFixtureDir(files, (dir) => {
      const failures = checkDownPairing([dir]);
      const flaggedStems = new Set(
        failures.map((f) => f.slice(dir.length + 1).replace(/: missing paired down migration.*/, "")),
      );
      const expectedStems = new Set(
        Object.keys(files)
          .filter((f) => !f.endsWith("_down.sql") && !(`${f.slice(0, -4)}_down.sql` in files))
          .map((f) => f),
      );
      assert.deepEqual(
        flaggedStems,
        expectedStems,
        `trial ${trial} (seed ${SEED}): files=${JSON.stringify(Object.keys(files))}`,
      );
    });
  }
});

// Property 2: checkVersionCollisions flags a version key if and only if
// that version is claimed by 2+ DISTINCT stems (an up/down pair of the SAME
// stem sharing a version must never be flagged).
test("property: checkVersionCollisions flags a version iff 2+ distinct stems share it", () => {
  const rng = makeRng(SEED + 1);
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const versionCount = randInt(rng, 1, 4);
    const files = {};
    const stemsByVersion = new Map();
    for (let v = 0; v < versionCount; v += 1) {
      const version = randDigits(rng, 14);
      const stemsHere = randInt(rng, 1, 3);
      const stems = new Set();
      for (let s = 0; s < stemsHere; s += 1) stems.add(`${version}_${randWord(rng)}_${s}`);
      stemsByVersion.set(version, stems);
      for (const stem of stems) {
        files[`${stem}.sql`] = "select 1;";
        if (rng() < 0.7) files[`${stem}_down.sql`] = "select 1;"; // pairing status irrelevant to this property
      }
    }
    withFixtureDir(files, (dir) => {
      const failures = checkVersionCollisions([dir]);
      const flaggedVersions = new Set(failures.map((f) => f.match(/^version (\d+) /)[1]));
      const expectedVersions = new Set(
        [...stemsByVersion.entries()].filter(([, stems]) => stems.size > 1).map(([v]) => v),
      );
      assert.deepEqual(
        flaggedVersions,
        expectedVersions,
        `trial ${trial} (seed ${SEED + 1}): stemsByVersion=${JSON.stringify([...stemsByVersion.entries()].map(([v, s]) => [v, [...s]]))}`,
      );
    });
  }
});

// Property 3: checkBrainSchemaReservation flags iff the text contains an
// EXECUTABLE "create schema [if not exists] brain" statement naming EXACTLY
// "brain" (not a brain-prefixed name like "brainstorm"), case-insensitively,
// regardless of surrounding noise -- and specifically NOT when the identical
// text appears only inside a line comment. Two false positives this
// property caught during development, both by mutation testing rather than
// inspection: (1) an early implementation scanned raw content and failed on
// a comment merely mentioning the reservation; (2) dropping the regex's
// trailing word-boundary anchor survived the entire suite untouched, which
// meant nothing actually proved "brainstorm" et al. are exempt. See the
// regression tests in validate-migrations.test.mjs for the minimal repro of
// each.
test("property: checkBrainSchemaReservation flags exactly executable 'create schema brain', nothing else", () => {
  const rng = makeRng(SEED + 2);
  const noise = ["-- unrelated comment", "create schema idea;", "select platform.owner();", "\n\n", "grant usage on schema core to authenticated;"];
  const brainPrefixedNames = ["brainstorm", "brainwave", "brainy", "brains"];
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const includeBrainCreate = rng() < 0.4;
    const includeCommentedBrainCreate = rng() < 0.3; // decoy: must NEVER count as a failure
    const includePrefixedNameCreate = rng() < 0.3; // decoy: "brainstorm" etc, must NEVER count
    const includeIfNotExists = rng() < 0.5;
    const caseVariant = pick(rng, ["create", "CREATE", "Create", "cReAtE"]);
    const statement = `${caseVariant} schema ${includeIfNotExists ? "if not exists " : ""}brain;`;
    const prefixedStatement = `${caseVariant} schema ${pick(rng, brainPrefixedNames)};`;
    const parts = [];
    const noiseBefore = randInt(rng, 0, 3);
    for (let i = 0; i < noiseBefore; i += 1) parts.push(pick(rng, noise));
    if (includePrefixedNameCreate) parts.push(prefixedStatement);
    if (includeCommentedBrainCreate) parts.push(`-- do not do this: ${statement}`);
    if (includeBrainCreate) parts.push(statement);
    const noiseAfter = randInt(rng, 0, 3);
    for (let i = 0; i < noiseAfter; i += 1) parts.push(pick(rng, noise));
    const sql = parts.join(`${randWhitespace(rng)}\n`);
    withFixtureDir({ "20260101000000_x.sql": sql }, (dir) => {
      const failures = checkBrainSchemaReservation([dir]);
      assert.equal(
        failures.length > 0,
        includeBrainCreate,
        `trial ${trial} (seed ${SEED + 2}): includeBrainCreate=${includeBrainCreate} sql=${JSON.stringify(sql)}`,
      );
    });
  }
});

// Property 4: checkOwnerCallWrapping flags a platform.owner() occurrence iff
// it is (a) not inside a line comment, (b) not part of its own CREATE/DROP/
// GRANT/REVOKE-ON-FUNCTION signature, and (c) not immediately preceded by
// "(select ". This generates the call in each of those three "safe"
// contexts plus the "bare call" unsafe context and checks the count exactly.
test("property: checkOwnerCallWrapping flags bare calls only, never comments/signatures/wrapped calls", () => {
  const rng = makeRng(SEED + 3);
  const CALL = "platform.owner()";
  const wrappedCall = () => `(select ${CALL})`;
  const bareCall = () => `${CALL}`;
  const inLineComment = () => `-- mentions ${CALL} in prose\n`;
  const inCreateSignature = () => `create function ${CALL} returns uuid language sql as $$ select 1 $$;\n`;
  const inDropSignature = () => `drop function if exists ${CALL};\n`;
  const inGrantSignature = () => `grant execute on function ${CALL} to authenticated;\n`;

  const safeGenerators = [inLineComment, inCreateSignature, inDropSignature, inGrantSignature, () => `using (x = ${wrappedCall()})`];

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const safeCount = randInt(rng, 0, 4);
    const bareCount = randInt(rng, 0, 4);
    const lines = [];
    for (let i = 0; i < safeCount; i += 1) lines.push(pick(rng, safeGenerators)());
    for (let i = 0; i < bareCount; i += 1) lines.push(`using (x = ${bareCall()})`);
    // Shuffle deterministically
    for (let i = lines.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    const sql = lines.join("\n");
    withFixtureDir({ "20260101000000_x.sql": sql }, (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(
        failures.length,
        bareCount,
        `trial ${trial} (seed ${SEED + 3}): expected ${bareCount} bare-call failures, got ${failures.length}. sql=${JSON.stringify(sql)}`,
      );
    });
  }
});
