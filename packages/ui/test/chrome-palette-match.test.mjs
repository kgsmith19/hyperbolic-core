// Exhaustive tests for `paletteMatch`, the command palette's matching
// algorithm (docs/planning/09-design-system.md section 4.2: "case-
// insensitive substring plus initials match ('nc' hits Network Checker);
// no fuzzy-ranking dependency"). Exported publicly from packages/ui (see
// src/chrome/palette-match.ts's header comment for why), so this tests it
// straight off the built dist entry, matching test/focus-visible.test.mjs's
// established pattern for exercising the real shipped artifact.
//
// The six real zone labels ("Home", "LifeOS", "ACC", "Tools", "Prompts",
// "Ideas") are all single words, so they cannot exercise the multi-word
// "initials" half of the spec's own example on their own. "Network
// Checker" -> "nc" is tested directly here as a synthetic label, both
// because it is the spec's own worked example verbatim and because it
// proves the algorithm already generalizes correctly to the multi-word
// tool-entry shape m3-04's registry will add later, even though no shipped
// data exercises that path yet (the explicit "clean extension point"
// requirement from this issue's scope).

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, "..", "dist", "index.cjs");

assert.ok(
  existsSync(distEntry),
  `${distEntry} does not exist -- run \`npm run build -w packages/ui\` before this test.`
);

const require = createRequire(import.meta.url);
const { paletteMatch } = require(distEntry);

describe("paletteMatch: spec's own worked example", () => {
  test('"nc" hits "Network Checker" (09 section 4.2, Matching row, verbatim example)', () => {
    assert.equal(paletteMatch("Network Checker", "nc"), true);
  });

  test('"nc" does NOT hit an unrelated multi-word label ("Prompt Organizer")', () => {
    assert.equal(paletteMatch("Prompt Organizer", "nc"), false);
  });
});

describe("paletteMatch: case-insensitive substring", () => {
  const cases = [
    ["Home", "home", true],
    ["Home", "HOME", true],
    ["Home", "Ho", true],
    ["Home", "ome", true],
    ["LifeOS", "life", true],
    ["LifeOS", "LIFEOS", true],
    ["Tools", "ool", true],
    ["Tools", "zzz", false],
    ["Ideas", "ideass", false],
  ];
  for (const [label, query, expected] of cases) {
    test(`paletteMatch(${JSON.stringify(label)}, ${JSON.stringify(query)}) === ${expected}`, () => {
      assert.equal(paletteMatch(label, query), expected);
    });
  }
});

describe("paletteMatch: initials matching, multi-word labels", () => {
  const cases = [
    ["Network Checker", "nc", true],
    ["Network Checker", "NC", true],
    ["Network Checker", "n", true],
    // "nk" is neither a substring of "network checker" nor of its initials
    // ("nc") -- a clean negative control proving the matcher isn't just
    // trivially true for any short query.
    ["Network Checker", "nk", false],
    ["Idea Intake", "ii", true],
    ["Prompt Organizer", "po", true],
    ["Prompt Organizer", "op", false],
  ];
  for (const [label, query, expected] of cases) {
    test(`paletteMatch(${JSON.stringify(label)}, ${JSON.stringify(query)}) === ${expected}`, () => {
      assert.equal(paletteMatch(label, query), expected);
    });
  }
});

describe("paletteMatch: empty/whitespace query matches everything (first-result-preselected relies on this)", () => {
  for (const query of ["", "  ", "\t"]) {
    test(`paletteMatch("Home", ${JSON.stringify(query)}) === true`, () => {
      assert.equal(paletteMatch("Home", query), true);
    });
  }
});

describe("paletteMatch: every real zone label matches its own full name and its own initial", () => {
  const labels = ["Home", "LifeOS", "ACC", "Tools", "Prompts", "Ideas"];
  for (const label of labels) {
    test(`"${label}" matches itself (case-insensitive, full)`, () => {
      assert.equal(paletteMatch(label, label.toLowerCase()), true);
    });
    test(`"${label}" matches its first letter`, () => {
      assert.equal(paletteMatch(label, label[0].toLowerCase()), true);
    });
  }
});

describe("paletteMatch: no fuzzy/typo tolerance (09 section 4.2: 'no fuzzy-ranking dependency')", () => {
  test("a transposed/typo'd query does not match, proving there is no fuzzy layer silently smoothing this over", () => {
    assert.equal(paletteMatch("Tools", "toosl"), false);
    assert.equal(paletteMatch("Prompts", "pormpts"), false);
  });
});
