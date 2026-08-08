import { test } from "node:test";
import assert from "node:assert/strict";
import { toggleTagFilter } from "../web/search.mjs";
import { login, rest, USER_A } from "./helpers.mjs";

// SPEC-0004 (SL-006): tags on prompts, filter and search.
// All tests are single-identity; isolation already owned by T-I-003.

// T-I-008 -> AC-001, PROP-002, PROP-005 -> FR-012. Fixture: a fresh prompt
// (Date.now()-suffixed title -- this test creates its own prompt to tag, no
// canonical fixture is being probed, so a plain POST is sufficient, matching
// tests/versions.test.mjs's fresh-insert cases). The rows sent mirror the
// client's trim/lowercase/dedupe transform applied to "sdd, Review, sdd"
// (web/index.html's parseTagInput) -- the transform has no server-side
// enforcement (SPEC-0004 7.1), so this proves the storage round trip for the
// transform's output: exactly two rows, lowercased, no case duplicate.
test("saves_tags_lowercased_and_deduplicated__T_I_008__AC_001", async () => {
  const token = await login(USER_A);
  const created = await rest("prompt", {
    token, method: "POST",
    body: { title: `Tag Dedup Fixture ${Date.now()}`, body: "tag dedup body" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const inserted = await rest("tag", {
    token, method: "POST",
    body: [{ prompt_id: id, tag: "sdd" }, { prompt_id: id, tag: "review" }],
  });
  assert.equal(inserted.status, 201, JSON.stringify(inserted.json));

  const readBack = await rest(`tag?prompt_id=eq.${id}&select=tag&order=tag.asc`, { token });
  assert.equal(readBack.status, 200, JSON.stringify(readBack.json));
  assert.deepEqual(readBack.json, [{ tag: "review" }, { tag: "sdd" }], "exactly two tag rows, lowercased");
});

// T-I-009 -> AC-002, PROP-003 -> FR-012. Two fresh prompts, disjoint tags.
// Queries the tag table directly (the real data the client's fetch-time
// embed and client-side filter both depend on) rather than replaying the
// client's filter logic, per spec 8's "real query against real rows".
test("filters_to_only_prompts_carrying_the_tag__T_I_009__AC_002", async () => {
  const token = await login(USER_A);
  const sdd = await rest("prompt", {
    token, method: "POST",
    body: { title: `Tag Filter SDD ${Date.now()}`, body: "sdd fixture body" },
  });
  assert.equal(sdd.status, 201, JSON.stringify(sdd.json));
  const review = await rest("prompt", {
    token, method: "POST",
    body: { title: `Tag Filter Review ${Date.now()}`, body: "review fixture body" },
  });
  assert.equal(review.status, 201, JSON.stringify(review.json));
  const sddId = sdd.json[0].id;
  const reviewId = review.json[0].id;

  const tagged = await rest("tag", {
    token, method: "POST",
    body: [{ prompt_id: sddId, tag: "sdd" }, { prompt_id: reviewId, tag: "review" }],
  });
  assert.equal(tagged.status, 201, JSON.stringify(tagged.json));

  const filtered = await rest(`tag?tag=eq.sdd&select=prompt_id`, { token });
  assert.equal(filtered.status, 200, JSON.stringify(filtered.json));
  const promptIds = filtered.json.map((r) => r.prompt_id);
  assert.ok(promptIds.includes(sddId), "the sdd-tagged prompt must be present");
  assert.ok(!promptIds.includes(reviewId), "the review-tagged prompt must be absent");
});

// T-I-010 -> AC-005 -> FR-012. Reclassified unit-level (SPEC-0004 §11,
// declared not silent): the tag filter is pure client-side state over an
// already-fetched prompts+tags list -- clicking a chip never issues a server
// call, so a DB round trip cannot be the mechanism that proves "second click
// clears." The pure function it actually exercises, `toggleTagFilter`
// (web/search.mjs), is the cheapest sufficient mechanism (rules/06-TESTS.md).
// No DB dependency: this test does not need the migration applied to run.
test("second_click_on_same_tag_clears_the_filter__T_I_010__AC_005", () => {
  const afterFirstClick = toggleTagFilter(null, "sdd");
  assert.equal(afterFirstClick, "sdd", "given: a tag filter is active");

  const afterSecondClick = toggleTagFilter(afterFirstClick, "sdd");
  assert.equal(afterSecondClick, null, "the same chip clicked again clears the filter");
});

// T-I-014 -> AC-006, PROP-001 -> FR-012. The failure case: a 101-char tag is
// rejected by the CHECK constraint, and no row is created.
test("rejects_tag_over_100_chars_with_23514__T_I_014__AC_006", async () => {
  const token = await login(USER_A);
  const created = await rest("prompt", {
    token, method: "POST",
    body: { title: `Tag Length Fixture ${Date.now()}`, body: "tag length body" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const longTag = "x".repeat(101);
  const rejected = await rest("tag", {
    token, method: "POST",
    body: { prompt_id: id, tag: longTag },
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
  assert.equal(rejected.json.code, "23514");

  const readBack = await rest(`tag?prompt_id=eq.${id}&select=tag`, { token });
  assert.equal(readBack.status, 200, JSON.stringify(readBack.json));
  assert.deepEqual(readBack.json, [], "no tag row must be created");
});

// T-I-011 -> PROP-001 -> FR-012: cascade delete of a prompt leaves no orphan
// tag rows. Not executable here -- `prompt.prompt` has no DELETE grant (by
// design), so the anon-key suite cannot create the delete this test would
// need to observe. Recorded in specs/TEST-LEDGER.md as a manual integrator
// drill, same posture as T-A-002 (SPEC-0004 section 8).
