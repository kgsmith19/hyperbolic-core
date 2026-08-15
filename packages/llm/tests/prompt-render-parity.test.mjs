// m4-04: packages/llm/src/prompt-render.ts is a deliberate copy of
// apps/toolbelt/apps/prompt-organizer/frontend/render.mjs (see that file's header
// comment for why it is a copy, not an import, across the apps/* boundary).
// docs/planning/05-d-prompt-organizer.md section 8 says the pure render()
// model and the SQL RPC are "provably equivalent," a claim
// apps/toolbelt/apps/prompt-organizer/backend/tests/render.test.mjs and
// render-endpoint.test.mjs already assert for the ORIGINAL. A third,
// independent copy in packages/llm could silently drift from that original
// and break the claim without either of those two suites ever noticing --
// this file is the actual enforcement mechanism: it imports BOTH
// implementations and asserts byte-for-byte identical output (and identical
// extractVariables/missing-list behavior) across the original suite's own
// fixtures plus a length/character fuzz pass, so a hand-edit to one file
// that silently diverges from the other fails a test, not a code review.
//
// Test-only cross-app import: production code (packages/llm/src/
// prompt-render.ts) never imports across the apps/* boundary; this test file
// does, on purpose, specifically to prove the copy is faithful.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as original from "../../../apps/toolbelt/apps/prompt-organizer/frontend/render.mjs";
import * as ported from "../src/prompt-render.ts";

function assertParity(body, values, sections) {
  const a = original.render(body, values, sections);
  const b = ported.render(body, values, sections);
  assert.deepEqual(b, a, `render() diverged for body=${JSON.stringify(body)} values=${JSON.stringify(values)} sections=${JSON.stringify(sections)}`);

  const namesA = original.extractVariables(body);
  const namesB = ported.extractVariables(body);
  assert.deepEqual(namesB, namesA, `extractVariables() diverged for body=${JSON.stringify(body)}`);

  const sectionsA = original.extractSections(body);
  const sectionsB = ported.extractSections(body);
  assert.deepEqual(sectionsB, sectionsA, `extractSections() diverged for body=${JSON.stringify(body)}`);
}

// The original suite's own literal fixtures (render.test.mjs), replayed
// against both implementations.
const FIXTURES = [
  { body: "Repo is {{REPO}}.", values: { REPO: "toolbelt" }, sections: undefined },
  { body: "{{A}} needs {{B}}", values: { A: "x" }, sections: undefined },
  { body: "literal {{}} braces", values: {}, sections: undefined },
  { body: "dangling {{ brace", values: {}, sections: undefined },
  { body: "{{REPO}} and {{REPO}} again", values: { REPO: "toolbelt" }, sections: undefined },
  { body: "", values: {}, sections: undefined },
  { body: "{{A}} and {{B}}", values: { B: "b", A: "a" }, sections: undefined },
  { body: "<!--OPTIONAL:x-->café {{NAME}}!! more café<!--END-->", values: { NAME: "Kyle" }, sections: undefined },
  { body: "{{A_1}}-{{B_2}}", values: { A_1: "x", B_2: "y" }, sections: undefined },
  { body: "{{C}} then {{A}} then {{B}}", values: {}, sections: undefined },
  // Optional-section fixtures (SPEC-0007/section 8's fence model).
  { body: "Head. <!--OPTIONAL:extra-->Extra {{DETAIL}}.<!--/OPTIONAL:extra--> Tail {{BASE}}.", values: { BASE: "b", DETAIL: "d" }, sections: ["extra"] },
  { body: "Head. <!--OPTIONAL:extra-->Extra {{DETAIL}}.<!--/OPTIONAL:extra--> Tail {{BASE}}.", values: { BASE: "b" }, sections: [] },
  { body: "<!--OPTIONAL:a-->A<!--OPTIONAL:b-->B<!--/OPTIONAL:a-->C<!--/OPTIONAL:b-->", values: {}, sections: ["a", "b"] }, // interleaved/overlapping fences
  { body: "<!--/OPTIONAL:stray--> literal <!--OPTIONAL:unterminated-->", values: {}, sections: ["stray", "unterminated"] },
  { body: "<!--OPTIONAL:x--><!--OPTIONAL:x-->nested-ish<!--/OPTIONAL:x--><!--/OPTIONAL:x-->", values: {}, sections: ["x"] },
];

test("prompt-render.ts parity: the original suite's own fixtures produce byte-for-byte identical output", () => {
  for (const { body, values, sections } of FIXTURES) {
    assertParity(body, values, sections);
  }
});

// A small deterministic fuzz pass: random bodies drawn from an alphabet that
// includes token braces, fence syntax, and plain text, each checked against
// both implementations with a few different values/sections combinations.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["{{A}}", "{{B}}", "{{C_1}}", "{{}}", "{{", "}}", "plain ", "<!--OPTIONAL:a-->", "<!--/OPTIONAL:a-->", "<!--OPTIONAL:b-->", "<!--/OPTIONAL:b-->", "café ", "\n"];

function randomBody(rand, pieceCount) {
  let out = "";
  for (let i = 0; i < pieceCount; i++) {
    out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return out;
}

test("prompt-render.ts parity: fuzzed bodies produce identical output across 500 random cases", () => {
  const rand = mulberry32(20260813);
  const valueSets = [{}, { A: "a" }, { A: "a", B: "b" }, { A: "a", B: "b", C_1: "c" }, { A: "", B: "0" }];
  const sectionSets = [undefined, [], ["a"], ["b"], ["a", "b"]];

  for (let i = 0; i < 500; i++) {
    const body = randomBody(rand, 1 + Math.floor(rand() * 12));
    const values = valueSets[Math.floor(rand() * valueSets.length)];
    const sections = sectionSets[Math.floor(rand() * sectionSets.length)];
    assertParity(body, values, sections);
  }
});
