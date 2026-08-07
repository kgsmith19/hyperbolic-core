import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSections, render } from "../web/render.mjs";

// The AC-001/AC-002 fixture: two well-formed sections with plain text on
// either side, so exclusion can be checked for both content loss and
// collateral damage to the surrounding text (PROP-007).
const TWO_SECTIONS =
  "head <!--OPTIONAL:a-->AAA<!--/OPTIONAL:a--> mid <!--OPTIONAL:b-->BBB<!--/OPTIONAL:b--> tail";

// T-U-017 -> AC-001, PROP-003, PROP-007 -> FR-005. The PRD's literal FR-005
// criterion: including only `a` keeps a's content, drops b's entirely, and
// leaves no fence text anywhere. The surrounding text is asserted exactly so
// a parser that over-matches (greedy content, or eating adjacent characters)
// is caught here rather than by a human pasting a mangled prompt.
test("excludes_an_unlisted_section_and_strips_every_fence__T_U_017__AC_001", () => {
  const result = render(TWO_SECTIONS, {}, ["a"]);

  assert.equal(result.ok, true);
  assert.equal(result.text.includes("AAA"), true, "included section survives");
  assert.equal(result.text.includes("BBB"), false, "excluded section is gone");
  assert.equal(result.text.includes("<!--OPTIONAL"), false, "AC-001: no fence text");
  assert.equal(result.text, "head AAA mid  tail");
});

// T-U-018 -> AC-002, PROP-003 -> FR-005. Including every id keeps both
// bodies in source order and removes both kinds of fence comment.
test("includes_every_listed_section_in_source_order_without_fences__T_U_018__AC_002", () => {
  const result = render(TWO_SECTIONS, {}, ["a", "b"]);

  assert.equal(result.ok, true);
  assert.equal(result.text, "head AAA mid BBB tail");
  assert.equal(result.text.includes("<!--OPTIONAL:"), false);
  assert.equal(result.text.includes("<!--/OPTIONAL:"), false);
});

// T-U-019 -> AC-003, PROP-002 -> FR-005. First-occurrence order, deduplicated
// -- the same contract extractVariables holds for tokens (T-U-016). `a`
// appears twice and must be listed once; `b` must not sort ahead of it.
test("extracts_section_ids_in_first_occurrence_order_deduplicated__T_U_019__AC_003", () => {
  const body =
    "<!--OPTIONAL:a-->1<!--/OPTIONAL:a--><!--OPTIONAL:b-->2<!--/OPTIONAL:b--><!--OPTIONAL:a-->3<!--/OPTIONAL:a-->";

  assert.deepEqual(extractSections(body), ["a", "b"]);
  assert.deepEqual(extractSections("no fences here"), []);
});

// T-U-020 -> AC-004, PROP-001, PROP-005 -> FR-005. The parser boundary. None
// of these three shapes is a section, so all pass through byte-for-byte and
// none crashes. The unterminated case is SL-002 T-U-011's exact fixture
// shape, whose ledger deletion criterion reads "Never -- the guarantee
// SL-003 will build on"; asserting it here guards that contract from the
// section parser's side.
test("treats_malformed_fences_as_literal_text__T_U_020__AC_004", () => {
  const unterminated = "<!--OPTIONAL:x-->café {{NAME}}!! more café<!--END-->";
  const mismatched = "<!--OPTIONAL:x-->body<!--/OPTIONAL:y-->";
  const emptyId = "<!--OPTIONAL:-->body<!--/OPTIONAL:-->";

  const a = render(unterminated, { NAME: "Kyle" }, []);
  assert.equal(a.ok, true);
  assert.equal(a.text, "<!--OPTIONAL:x-->café Kyle!! more café<!--END-->");

  const b = render(mismatched, {}, ["x"]);
  assert.equal(b.ok, true);
  assert.equal(b.text, mismatched, "mismatched ids are not a section");

  const c = render(emptyId, {}, []);
  assert.equal(c.ok, true);
  assert.equal(c.text, emptyId, "an empty id does not match the charset");

  assert.deepEqual(extractSections(unterminated), []);
  assert.deepEqual(extractSections(mismatched), []);
  assert.deepEqual(extractSections(emptyId), []);
});

// T-U-021 -> AC-005 -> FR-005, FR-010. Sections are applied before variable
// substitution, so a variable that lives only inside an excluded block is
// never demanded -- asking the user to fill in text that is about to be
// deleted would defeat FR-010's purpose. The converse is asserted too: the
// same variable in a *kept* section is still demanded.
test("does_not_demand_a_variable_that_lives_only_in_an_excluded_section__T_U_021__AC_005", () => {
  const body = "{{KEPT}} <!--OPTIONAL:b-->needs {{GONE}}<!--/OPTIONAL:b-->";

  const excluded = render(body, { KEPT: "here" }, []);
  assert.equal(excluded.ok, true, "GONE is not in the text being rendered");
  assert.equal(excluded.text, "here ");

  const included = render(body, { KEPT: "here" }, ["b"]);
  assert.equal(included.ok, false, "GONE is in the text now, so it is demanded");
  assert.deepEqual(included.missing, ["GONE"]);
});

// T-U-022 -> PROP-004, PROP-006, AC-006 -> FR-005. Three guarantees that
// share one fixture: render mutates nothing it is handed, the order of ids
// in `includes` is irrelevant, and a fence-free body is untouched by the new
// third argument (the SL-002 regression guard).
test("is_pure_and_unaffected_by_include_order_or_a_fence_free_body__T_U_022__PROP_004", () => {
  const body = TWO_SECTIONS;
  const values = {};
  const includes = ["b", "a"];
  const bodySnapshot = structuredClone(body);
  const valuesSnapshot = structuredClone(values);
  const includesSnapshot = structuredClone(includes);

  const reversed = render(body, values, includes);
  const forward = render(body, values, ["a", "b"]);

  assert.equal(reversed.text, forward.text, "PROP-006: include order is irrelevant");
  assert.equal(body, bodySnapshot);
  assert.deepEqual(values, valuesSnapshot);
  assert.deepEqual(includes, includesSnapshot, "PROP-004: includes is not mutated");

  const fenceFree = render("Repo is {{REPO}}.", { REPO: "toolbelt" }, ["a"]);
  assert.equal(fenceFree.ok, true);
  assert.equal(fenceFree.text, "Repo is toolbelt.", "AC-006: unchanged from SL-002");
});

// T-U-023 -> PROP-008 -> FR-005. Monotonicity, non-vacuous for the first
// time in this repo: growing the include list can only add content, never
// remove it. Asserted as a subsequence over three nested include lists.
test("adding_an_id_to_includes_only_adds_content__T_U_023__PROP_008", () => {
  const body =
    "<!--OPTIONAL:a-->A<!--/OPTIONAL:a--><!--OPTIONAL:b-->B<!--/OPTIONAL:b--><!--OPTIONAL:c-->C<!--/OPTIONAL:c-->";

  const none = render(body, {}, []).text;
  const one = render(body, {}, ["a"]).text;
  const two = render(body, {}, ["a", "b"]).text;
  const all = render(body, {}, ["a", "b", "c"]).text;

  assert.equal(none, "");
  assert.equal(one, "A");
  assert.equal(two, "AB");
  assert.equal(all, "ABC");

  for (const [smaller, larger] of [[none, one], [one, two], [two, all]]) {
    assert.equal(
      larger.includes(smaller),
      true,
      `PROP-008: "${smaller}" must survive inside "${larger}"`,
    );
    assert.equal(larger.length > smaller.length, true, "adding an id adds content");
  }
});
