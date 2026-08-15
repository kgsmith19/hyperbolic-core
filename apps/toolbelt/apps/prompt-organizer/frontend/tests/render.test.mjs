import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVariables, render } from "../render.mjs";

// T-U-006 -> AC-001, PROP-003 -> FR-004. Literal AC-001 fixture (SPEC-0003
// section 4): a single token, fully supplied, substitutes exactly and the
// invariant (no `{{` survives once every extracted variable has a value)
// holds.
test("substitutes_a_single_token_with_its_value__T_U_006__AC_001", () => {
  const body = "Repo is {{REPO}}.";
  const values = { REPO: "toolbelt" };

  const result = render(body, values);

  assert.equal(result.ok, true);
  assert.equal(result.text, "Repo is toolbelt.");
  assert.equal(result.text.includes("{{"), false, "PROP-003: no {{ survives");
});

// T-U-007 -> AC-002, PROP-001 -> FR-010. Literal AC-002 fixture: two tokens,
// only one supplied -> rejected, missing list names exactly the unsupplied
// one. RISK-001's adjacent malformed-token domain (`{{}}`, unterminated
// `{{`) is what PROP-001's error-totality claim covers here: render must
// never crash on them, and must not treat malformed syntax as a variable.
test("rejects_render_and_names_exactly_the_missing_variables__T_U_007__AC_002", () => {
  const body = "{{A}} needs {{B}}";
  const values = { A: "x" };

  const result = render(body, values);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["B"]);

  const emptyName = render("literal {{}} braces", {});
  assert.equal(emptyName.ok, true);
  assert.equal(emptyName.text, "literal {{}} braces");

  const unterminated = render("dangling {{ brace", {});
  assert.equal(unterminated.ok, true);
  assert.equal(unterminated.text, "dangling {{ brace");
});

// T-U-008 -> AC-004, PROP-002 -> FR-004. Literal AC-004 fixture: a repeated
// token is substituted at every occurrence, and extracted exactly once
// (round-trip: extractVariables names exactly the set render substitutes).
test("substitutes_every_occurrence_and_extracts_a_repeated_token_once__T_U_008__AC_004", () => {
  const body = "{{REPO}} and {{REPO}} again";
  const values = { REPO: "toolbelt" };

  const names = extractVariables(body);
  const result = render(body, values);

  assert.deepEqual(names, ["REPO"]);
  assert.equal(result.ok, true);
  assert.equal(result.text, "toolbelt and toolbelt again");
});

// T-U-009 -> AC-005 -> FR-004. Literal AC-005 fixture: a token-free body
// (the empty string, also the "empty body" text edge value) rendered with an
// empty values object comes back unchanged, and extracts nothing.
test("passes_a_token_free_body_through_unchanged__T_U_009__AC_005", () => {
  const body = "";

  const names = extractVariables(body);
  const result = render(body, {});

  assert.deepEqual(names, []);
  assert.equal(result.ok, true);
  assert.equal(result.text, body);
});

// T-U-010 -> PROP-004 -> FR-004. The Given (both variables supplied, so
// substitution succeeds) is asserted so this test is red against the R2
// stub; the Then: neither argument is mutated by render.
test("never_mutates_its_body_or_values_arguments__T_U_010__PROP_004", () => {
  const body = "{{A}} and {{B}}";
  const values = { B: "b", A: "a" };
  const bodySnapshot = structuredClone(body);
  const valuesSnapshot = structuredClone(values);

  const result = render(body, values);

  assert.equal(result.ok, true, "given: both variables are supplied");
  assert.equal(result.text, "a and b");
  assert.equal(body, bodySnapshot);
  assert.deepEqual(values, valuesSnapshot);
});

// T-U-011 -> PROP-005 -> FR-004. Text adjacent to a token -- including a
// section-fence-shaped string (SL-003 forward-compat) and non-ASCII text --
// passes through byte-for-byte; only the token span changes.
test("passes_text_adjacent_to_a_token_through_byte_for_byte__T_U_011__PROP_005", () => {
  const body = "<!--OPTIONAL:x-->café {{NAME}}!! more café<!--END-->";
  const values = { NAME: "Kyle" };

  const result = render(body, values);

  assert.equal(result.ok, true);
  assert.equal(result.text, "<!--OPTIONAL:x-->café Kyle!! more café<!--END-->");
});

// T-U-012 -> PROP-006 -> FR-004. The key order of `values` does not affect
// the output; fixture names also cover CON-004's digit/underscore domain.
test("output_is_unaffected_by_the_key_order_of_values__T_U_012__PROP_006", () => {
  const body = "{{A_1}}-{{B_2}}";
  const forwardOrder = { A_1: "x", B_2: "y" };
  const reverseOrder = { B_2: "y", A_1: "x" };

  const forward = render(body, forwardOrder);
  const reverse = render(body, reverseOrder);

  assert.equal(forward.ok, true);
  assert.equal(reverse.ok, true);
  assert.equal(forward.text, reverse.text);
  assert.equal(forward.text, "x-y");
});

// T-U-016 -> AC-004 (extends), PROP-002 -> FR-004. Coverage gap found during
// SL-002 mutation verification: T-U-008's fixture has only one distinct
// name, so a reversed (or otherwise reordered) extractVariables output
// survived the full suite green. Three distinct names pin first-occurrence
// order directly, and through it the order of a multi-name `missing` list.
test("extracts_and_reports_missing_variables_in_first_occurrence_order__T_U_016__AC_004", () => {
  const body = "{{C}} then {{A}} then {{B}}";

  const names = extractVariables(body);
  const result = render(body, {});

  assert.deepEqual(names, ["C", "A", "B"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["C", "A", "B"]);
});
