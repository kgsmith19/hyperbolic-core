import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../web/render.mjs";
import { searchPrompts } from "../web/search.mjs";

// Rendering a maximum-size prompt must stay below this p95 budget.
const BUDGET_MS = 100;
// Searching a 1,000-prompt library must stay below this p95 budget.
const SEARCH_BUDGET_MS = 300;

// p95 over warm iterations. Warm-up matters: the first call pays JIT cost.
// Iterating matters too -- a single shot is what produced the 34.7ms figure
// this slice had to retract (SPEC-0007 section 2).
function p95(fn, iterations = 20) {
  for (let i = 0; i < 5; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const started = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(iterations * 0.95)];
}

// A body at FR-001's 100,000-character ceiling that looks like a real prompt:
// variables to substitute and well-formed sections to resolve.
function realisticBody() {
  const unit = "prose {{VAR}} here. <!--OPTIONAL:s-->opt<!--/OPTIONAL:s--> tail. ";
  return unit.repeat(Math.ceil(100000 / unit.length)).slice(0, 100000);
}

// The pathological body: nothing but opening fences, no closer anywhere. This
// is the worst case for a parser that hunts forward for a matching closer, and
// it is a body FR-001's CHECK constraint permits (99,994 <= 100,000).
function pathologicalBody() {
  return "<!--OPTIONAL:a-->".repeat(5882);
}

// T-U-024 -> AC-001 -> NFR-002. The ordinary case: a full-size realistic body
// must render well inside the budget.
test("renders_a_realistic_maximum_size_body_within_budget__T_U_024__AC_001", () => {
  const body = realisticBody();
  assert.equal(body.length, 100000, "given: FR-001's ceiling exactly");

  const measured = p95(() => render(body, { VAR: "x" }, ["s"]));

  assert.ok(
    measured < BUDGET_MS,
    `NFR-002: p95 ${measured.toFixed(1)}ms must be under ${BUDGET_MS}ms`,
  );
});

// T-U-025 -> AC-002, PROP-001 -> NFR-002. The defect. SL-003's pair-regex
// expands `[\s\S]*?` to the end of the string once per opening fence, so this
// body costs O(n^2) and measures ~210ms -- over budget on input the schema
// accepts. Output must also be unchanged, since none of these fences pair.
test("renders_a_pathological_fence_body_within_budget__T_U_025__AC_002", () => {
  const body = pathologicalBody();
  assert.ok(body.length <= 100000, "given: within FR-001's CHECK constraint");

  const result = render(body, {}, []);
  assert.equal(result.ok, true);
  assert.equal(result.text, body, "no fence pairs, so nothing is removed");

  const measured = p95(() => render(body, {}, []));

  assert.ok(
    measured < BUDGET_MS,
    `NFR-002: p95 ${measured.toFixed(1)}ms must be under ${BUDGET_MS}ms`,
  );
});

// T-U-026 -> AC-003, AC-005, PROP-007, PROP-008 -> NFR-002. A wall-clock
// threshold alone would pass on fast hardware even if the parser were still
// quadratic, so this pins the growth curve instead: quadrupling the input must
// not multiply the time by ~16. The tolerance is deliberately loose -- this
// exists to catch an algorithmic regression, not to police constant factors.
// AC-005 rides along: interleaved sections must stay non-overlapping.
test("section_parsing_grows_at_most_linearly__T_U_026__AC_003", () => {
  // Sizes are deliberately far above FR-001's 100,000-char storage bound.
  // This test measures the shape of the growth curve, not a storable body --
  // the absolute NFR-002 budget is pinned by T-U-024/025 at in-bounds sizes.
  // Below ~1ms the linear parser is faster than the timer is precise, and the
  // ratio degenerates into noise (measured: a 4x-larger input timing *faster*).
  const time = (fences) => {
    const body = "<!--OPTIONAL:a-->".repeat(fences);
    return p95(() => render(body, {}, []), 10);
  };

  const base = time(15000);
  const quadruple = time(60000);

  assert.ok(
    base > 0.5,
    `base measurement ${base.toFixed(3)}ms is at the timer's noise floor, so ` +
      `the ratio below would be meaningless -- raise the fence counts`,
  );

  const growth = quadruple / base;
  assert.ok(
    growth < 8,
    `PROP-008: 4x the input grew time ${growth.toFixed(1)}x; linear is ~4x, ` +
      `quadratic is ~16x, so anything at or above 8x means the parser backtracks`,
  );

  // AC-005: interleaved pairs. The old regex applied the first complete pair
  // and left the overlapping one literal; the rewrite must agree, and must
  // never emit corrupt text.
  const interleaved = "<!--OPTIONAL:a-->A<!--OPTIONAL:b-->B<!--/OPTIONAL:a-->C<!--/OPTIONAL:b-->";
  const kept = render(interleaved, {}, ["a"]);
  assert.equal(kept.ok, true);
  assert.equal(kept.text, "A<!--OPTIONAL:b-->BC<!--/OPTIONAL:b-->");

  const dropped = render(interleaved, {}, []);
  assert.equal(dropped.ok, true);
  assert.equal(dropped.text, "C<!--/OPTIONAL:b-->");
});

// T-U-029 -> NFR-001. Search runs client-side over the already-fetched list
// (docs/DATA-FLOW-DIAGRAM.md F-4), not a database query, so this is a JS
// benchmark rather than a seeded-database timing, correcting NFR-001's own
// stale "how measured" text -- same class of correction SR-04 has had twice.
test("searches_1000_prompts_within_budget__T_U_029", () => {
  const prompts = [];
  for (let i = 0; i < 1000; i++) {
    prompts.push({
      title: `Prompt ${i}`,
      body: i % 7 === 0 ? "contains spec somewhere in the body" : "ordinary prose here",
      tags: i % 5 === 0 ? ["spec"] : [],
    });
  }

  const measured = p95(() => searchPrompts(prompts, "spec"));

  assert.ok(
    measured < SEARCH_BUDGET_MS,
    `NFR-001: p95 ${measured.toFixed(1)}ms must be under ${SEARCH_BUDGET_MS}ms at 1,000 prompts`,
  );
});
