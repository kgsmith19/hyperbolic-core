import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPrompts } from "../web/search.mjs";

// AC-001 fixture (SPEC-0001 section 4), literal.
const PROMPTS = [
  { title: "Spec Author", body: "writes specs" },
  { title: "Bug Fixer", body: "fix a spec defect" },
  { title: "Daily Journal", body: "morning pages" },
];

// PROP-002's domain: the AC-001 fixture plus metacharacter titles.
const META_PROMPTS = [
  { title: "Regex (.*) Guide", body: "literal dot star" },
  { title: "Café Menu", body: "menu du jour" },
  { title: "Plain", body: "nothing special" },
];

const titles = (prompts) => prompts.map((p) => p.title);

// T-U-001 -> AC-001, AC-002, PROP-002 -> FR-006. Membership only (order is
// T-U-002's job): `spec` and `SPEC` both select exactly the two prompts whose
// title or body contains the string, case-folded.
test("matches_on_title_or_body_case_insensitively__T_U_001__AC_001_AC_002", () => {
  const lower = searchPrompts(PROMPTS, "spec");
  const upper = searchPrompts(PROMPTS, "SPEC");

  assert.deepEqual(titles(lower).sort(), ["Bug Fixer", "Spec Author"]);
  assert.deepEqual(titles(upper).sort(), ["Bug Fixer", "Spec Author"]);
});

// T-U-002 -> AC-001, PROP-004 -> FR-006. Input reordered (PROP-004's domain)
// so ranking, not input order, must put the title match first.
test("ranks_title_match_above_body_only_match__T_U_002__AC_001", () => {
  const reordered = [PROMPTS[1], PROMPTS[0], PROMPTS[2]];

  const result = searchPrompts(reordered, "spec");

  assert.deepEqual(titles(result), ["Spec Author", "Bug Fixer"]);
});

// T-U-003 -> AC-003 -> FR-006. The failure case: a no-match query returns
// zero prompts, so the page can show the empty state.
test("returns_no_prompts_for_query_matching_nothing__T_U_003__AC_003", () => {
  const result = searchPrompts(PROMPTS, "zzz-none");

  assert.deepEqual(result, []);
});

// T-U-004 -> AC-004, PROP-003 -> FR-006. The Given (a search has filtered the
// list) is asserted so this test is red against the R2 stub; the Then:
// clearing returns every prompt in original order and the input is untouched.
test("clearing_the_search_restores_all_prompts_unchanged__T_U_004__AC_004", () => {
  const input = structuredClone(PROMPTS);

  const filtered = searchPrompts(input, "spec");
  const cleared = searchPrompts(input, "");

  assert.equal(filtered.length, 2, "given: the search filtered the list");
  assert.deepEqual(cleared, PROMPTS);
  assert.deepEqual(input, PROMPTS);
});

// T-U-005 -> PROP-001 -> FR-006. Adversarial queries from the PROP-001
// domain (regex metacharacters, quote, 1-char, whitespace, non-ASCII é):
// one failure mode — the query treated as a pattern, crashing or misfiltering.
test("treats_metacharacter_and_non_ascii_queries_as_literal_text__T_U_005__PROP_001", () => {
  const dotStar = searchPrompts(META_PROMPTS, ".*");
  const paren = searchPrompts(META_PROMPTS, "(");
  const quote = searchPrompts(META_PROMPTS, '"');
  const accent = searchPrompts(META_PROMPTS, "é");
  const space = searchPrompts(META_PROMPTS, " ");

  assert.deepEqual(titles(dotStar), ["Regex (.*) Guide"]);
  assert.deepEqual(titles(paren), ["Regex (.*) Guide"]);
  assert.deepEqual(titles(quote), []);
  assert.deepEqual(titles(accent), ["Café Menu"]);
  assert.deepEqual(titles(space), ["Regex (.*) Guide", "Café Menu", "Plain"]);
});
