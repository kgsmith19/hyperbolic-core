// m3-08: unit tests for migrate-forgepad.mjs's pure field-mapping logic
// (docs/planning/05-h-idea-intake.md section 10), isolated from any
// database. The end-to-end proof against a real Postgres instance lives in
// migrate-forgepad-e2e.test.mjs; this file is the fast, DB-free layer that
// pins down the mapping rules exactly, including the branches most worth
// mutation-guarding per this issue's testing bar: the rejected-state skip,
// and the target_repo regex validation branching into the "[needs repo]"
// note path.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OWNER_REPO_RE,
  buildSource,
  mapForgepadIdea,
  validateForgepadIdea,
  loadForgepadFiles,
  summarizeCounts,
  partitionNewRows,
  parseArgs,
} from "../tools/migrate-forgepad.mjs";

function baseIdea(overrides = {}) {
  return {
    id: "f-1a2b3c4d",
    title: "Some idea",
    problem: "A problem",
    outcome: "An outcome",
    confidence: "medium",
    notes: "",
    state: "draft",
    target: "",
    source: "",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    githubIssue: null,
    ...overrides,
  };
}

// === OWNER_REPO_RE (must stay byte-identical to the DDL CHECK) ============

test("OWNER_REPO_RE accepts valid owner/repo shapes", () => {
  assert.ok(OWNER_REPO_RE.test("kgsmith19/hyperbolic-core"));
  assert.ok(OWNER_REPO_RE.test("Owner_1.foo/repo-name_123.bar"));
  assert.ok(OWNER_REPO_RE.test("a/b"));
});

test("OWNER_REPO_RE rejects shapes missing exactly one slash-delimited half", () => {
  assert.equal(OWNER_REPO_RE.test("just-a-name"), false);
  assert.equal(OWNER_REPO_RE.test("owner/"), false);
  assert.equal(OWNER_REPO_RE.test("/repo"), false);
  assert.equal(OWNER_REPO_RE.test(""), false);
});

test("OWNER_REPO_RE rejects a third path segment and embedded whitespace", () => {
  assert.equal(OWNER_REPO_RE.test("owner/repo/extra"), false);
  assert.equal(OWNER_REPO_RE.test("owner repo"), false);
  assert.equal(OWNER_REPO_RE.test("owner/re po"), false);
});

// === buildSource ============================================================

test("buildSource prefixes the provenance ref with no original source", () => {
  assert.equal(buildSource(baseIdea({ id: "f-deadbeef", source: "" })), "forgepad:f-deadbeef");
});

test("buildSource appends the original source after '; ' when present", () => {
  assert.equal(
    buildSource(baseIdea({ id: "f-deadbeef", source: "overheard in standup" })),
    "forgepad:f-deadbeef; overheard in standup",
  );
});

test("buildSource trims whitespace-only original source down to nothing (treated as absent)", () => {
  assert.equal(buildSource(baseIdea({ id: "f-deadbeef", source: "   " })), "forgepad:f-deadbeef");
});

// === mapForgepadIdea: state -> status ======================================

test("state=draft maps to status=draft, notes untouched", () => {
  const row = mapForgepadIdea(baseIdea({ state: "draft", notes: "keep me" }));
  assert.equal(row.skip, false);
  assert.equal(row.status, "draft");
  assert.equal(row.notes, "keep me");
  assert.equal(row.targetRepo, null);
});

test("state=definite with a valid owner/repo target promotes to status=idea and sets target_repo", () => {
  const row = mapForgepadIdea(baseIdea({ state: "definite", target: "kgsmith19/scratch", notes: "ship it" }));
  assert.equal(row.status, "idea");
  assert.equal(row.targetRepo, "kgsmith19/scratch");
  assert.equal(row.notes, "ship it", "no note prefix on the successful promotion path");
});

test("state=definite with a missing target stays draft with the [needs repo] prefix", () => {
  const row = mapForgepadIdea(baseIdea({ state: "definite", target: "", notes: "ship it" }));
  assert.equal(row.status, "draft");
  assert.equal(row.targetRepo, null);
  assert.equal(row.notes, "[needs repo] ship it");
});

test("state=definite with a malformed (non owner/repo) target stays draft, prefixes notes, and preserves the raw target text", () => {
  const row = mapForgepadIdea(baseIdea({ state: "definite", target: "not-a-repo-shape", notes: "ship it" }));
  assert.equal(row.status, "draft");
  assert.equal(row.targetRepo, null);
  assert.equal(row.notes, "[needs repo] ship it; target: not-a-repo-shape");
});

test("state=definite invalid target with empty notes still gets a clean [needs repo] prefix (no stray separators)", () => {
  const row = mapForgepadIdea(baseIdea({ state: "definite", target: "bad", notes: "" }));
  assert.equal(row.notes, "[needs repo]; target: bad");
});

test("state=research-needed maps to status=draft with the exact '[research needed]' prefix", () => {
  const row = mapForgepadIdea(baseIdea({ state: "research-needed", notes: "needs digging" }));
  assert.equal(row.status, "draft");
  assert.equal(row.notes, "[research needed] needs digging");
});

test("state=research-needed with no notes produces just the prefix, no trailing space", () => {
  const row = mapForgepadIdea(baseIdea({ state: "research-needed", notes: "" }));
  assert.equal(row.notes, "[research needed]");
});

test("a valid owner/repo target is honored even outside state=definite (generic target mapping rule)", () => {
  const row = mapForgepadIdea(baseIdea({ state: "draft", target: "kgsmith19/scratch" }));
  assert.equal(row.targetRepo, "kgsmith19/scratch");
  assert.equal(row.status, "draft", "draft state is never promoted regardless of target validity");
});

test("an invalid target on a plain draft idea is appended to notes, not silently dropped", () => {
  const row = mapForgepadIdea(baseIdea({ state: "draft", target: "nope", notes: "orig" }));
  assert.equal(row.notes, "orig; target: nope");
  assert.equal(row.targetRepo, null);
});

// === mapForgepadIdea: rejected short-circuits ==============================

test("state=rejected skips the row and short-circuits before any other mapping field is computed", () => {
  // Deliberately pairs an invalid target with a state value that would hit
  // the "unrecognized state" throw branch if the rejected-state check were
  // ever removed or reordered after the state-dispatch chain -- so this
  // test both proves the mapping output and stands as the mutation guard
  // for "delete/skip the rejected early return": that mutant makes this
  // exact test throw instead of skip, for any rejected fixture at all.
  const row = mapForgepadIdea(baseIdea({ state: "rejected", target: "garbage", notes: "n/a", confidence: "low" }));
  assert.deepEqual(row, { skip: true, state: "rejected", id: "f-1a2b3c4d", source: "forgepad:f-1a2b3c4d" });
});

test("state=rejected still carries the source provenance prefix (for the printed audit)", () => {
  const row = mapForgepadIdea(baseIdea({ id: "f-cafebabe", state: "rejected", source: "old idea" }));
  assert.equal(row.source, "forgepad:f-cafebabe; old idea");
});

test("an unrecognized state value throws rather than silently mapping to a status", () => {
  assert.throws(() => mapForgepadIdea(baseIdea({ state: "not-a-real-state" })), /unrecognized forgepad state/);
});

// === mapForgepadIdea: direct-copy fields and confidence default ===========

test("title/problem/outcome/confidence/created/updated pass through unchanged", () => {
  const row = mapForgepadIdea(
    baseIdea({
      title: "T",
      problem: "P",
      outcome: "O",
      confidence: "high",
      created: "2026-03-04T05:06:07.000Z",
      updated: "2026-03-05T05:06:07.000Z",
    }),
  );
  assert.equal(row.title, "T");
  assert.equal(row.problem, "P");
  assert.equal(row.outcome, "O");
  assert.equal(row.confidence, "high");
  assert.equal(row.createdAt, "2026-03-04T05:06:07.000Z");
  assert.equal(row.updatedAt, "2026-03-05T05:06:07.000Z");
});

test("a missing confidence value defaults to medium", () => {
  const idea = baseIdea();
  delete idea.confidence;
  assert.equal(mapForgepadIdea(idea).confidence, "medium");
});

// === validateForgepadIdea ====================================================

test("a well-formed idea validates with zero problems", () => {
  assert.deepEqual(validateForgepadIdea(baseIdea()), []);
});

test("validateForgepadIdea rejects a non-object", () => {
  assert.deepEqual(validateForgepadIdea(null), ["file content is not a JSON object"]);
  assert.deepEqual(validateForgepadIdea([1, 2]), ["file content is not a JSON object"]);
});

test("validateForgepadIdea flags a malformed id", () => {
  const problems = validateForgepadIdea(baseIdea({ id: "not-an-id" }));
  assert.ok(problems.some((p) => p.includes("id must match")));
});

test("validateForgepadIdea flags a missing/blank title and an over-length title separately", () => {
  assert.ok(validateForgepadIdea(baseIdea({ title: "" })).some((p) => p.includes("title is required")));
  assert.ok(validateForgepadIdea(baseIdea({ title: "x".repeat(201) })).some((p) => p.includes("200 characters")));
});

test("validateForgepadIdea flags an invalid state and an invalid confidence", () => {
  assert.ok(validateForgepadIdea(baseIdea({ state: "flying" })).some((p) => p.includes("state must be")));
  assert.ok(validateForgepadIdea(baseIdea({ confidence: "maybe" })).some((p) => p.includes("confidence must be")));
});

test("validateForgepadIdea flags unparseable created/updated timestamps", () => {
  assert.ok(validateForgepadIdea(baseIdea({ created: "not-a-date" })).some((p) => p.includes("created must be")));
  assert.ok(validateForgepadIdea(baseIdea({ updated: "not-a-date" })).some((p) => p.includes("updated must be")));
});

test("validateForgepadIdea accumulates multiple independent problems in one pass", () => {
  const problems = validateForgepadIdea(baseIdea({ title: "", state: "flying", confidence: "maybe" }));
  assert.equal(problems.length, 3);
});

// --- Finding 14: a non-null githubIssue must never silently vanish -------

test("validateForgepadIdea accepts a null githubIssue (the only shape this repo's history has ever produced)", () => {
  assert.deepEqual(validateForgepadIdea(baseIdea({ githubIssue: null })), []);
});

test("validateForgepadIdea accepts an entirely absent githubIssue field", () => {
  const idea = baseIdea();
  delete idea.githubIssue;
  assert.deepEqual(validateForgepadIdea(idea), []);
});

test(
  "validateForgepadIdea flags a non-null githubIssue instead of silently dropping it (RED before the fix: mapForgepadIdea never copies this field anywhere)",
  () => {
    const problems = validateForgepadIdea(baseIdea({ githubIssue: "42" }));
    assert.ok(
      problems.some((p) => p.includes("githubIssue") && p.includes("not null")),
      `expected a githubIssue problem, got: ${JSON.stringify(problems)}`,
    );
  },
);

test("a rejected non-null-githubIssue file never reaches mapForgepadIdea: loadForgepadFiles reports it as an error, not a loaded file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-forgepad-ghissue-"));
  try {
    fs.writeFileSync(path.join(dir, "f-44444444.json"), JSON.stringify(baseIdea({ id: "f-44444444", githubIssue: "99" })));
    const { files, errors } = loadForgepadFiles(dir);
    assert.equal(files.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /githubIssue/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// === partitionNewRows (idempotency decision, DB-free) ======================

test("partitionNewRows separates rows whose source is already present from genuinely new ones", () => {
  const rows = [{ id: "f-a", source: "forgepad:f-a" }, { id: "f-b", source: "forgepad:f-b" }, { id: "f-c", source: "forgepad:f-c" }];
  const { newRows, alreadyPresent, duplicateInBatch } = partitionNewRows(rows, new Set(["forgepad:f-b"]));
  assert.deepEqual(newRows.map((r) => r.source), ["forgepad:f-a", "forgepad:f-c"]);
  assert.equal(alreadyPresent, 1);
  assert.equal(duplicateInBatch, 0);
});

test("partitionNewRows with an empty existing set treats every row as new", () => {
  const rows = [{ id: "f-a", source: "forgepad:f-a" }, { id: "f-b", source: "forgepad:f-b" }];
  const { newRows, alreadyPresent } = partitionNewRows(rows, new Set());
  assert.equal(newRows.length, 2);
  assert.equal(alreadyPresent, 0);
});

test("partitionNewRows with every source already present yields zero new rows (second-run idempotency shape)", () => {
  const rows = [{ id: "f-a", source: "forgepad:f-a" }, { id: "f-b", source: "forgepad:f-b" }];
  const { newRows, alreadyPresent } = partitionNewRows(rows, new Set(["forgepad:f-a", "forgepad:f-b"]));
  assert.equal(newRows.length, 0);
  assert.equal(alreadyPresent, 2);
});

// --- Finding 11: within-batch dedupe keyed on the immutable forgepad id ---

test(
  "partitionNewRows dedupes two rows sharing one forgepad id WITHIN a single batch, keeping only the first (RED before the fix: both used to reach newRows)",
  () => {
    // Two distinct source files can independently map to the same forgepad
    // idea id (a duplicated/malformed fixture, an operator copy-paste) --
    // loadForgepadFiles/validateForgepadIdea impose no cross-file
    // uniqueness, only mapForgepadIdea's per-row shape. Before Finding 11's
    // fix, partitionNewRows only checked `existingSources` (rows already in
    // the DB from a PRIOR run) and let both rows straight through to
    // insertRows in the SAME run.
    const rows = [
      { id: "f-dupe0001", source: "forgepad:f-dupe0001" },
      { id: "f-dupe0001", source: "forgepad:f-dupe0001; a different original source text" },
      { id: "f-unique02", source: "forgepad:f-unique02" },
    ];
    const { newRows, alreadyPresent, duplicateInBatch } = partitionNewRows(rows, new Set());
    assert.deepEqual(
      newRows.map((r) => r.id),
      ["f-dupe0001", "f-unique02"],
      "only the FIRST occurrence of the duplicated id survives into newRows",
    );
    assert.equal(alreadyPresent, 0);
    assert.equal(duplicateInBatch, 1, "the second f-dupe0001 row must be counted as an in-batch duplicate, not silently dropped or inserted");
  },
);

test("partitionNewRows dedupe keys on the immutable id, not the mutable full source string", () => {
  // Two rows for the same forgepad id whose `source` strings genuinely
  // differ (different original-source suffix) must still collapse to one --
  // proving the fix keys on `row.id`, not `row.source` (a source-keyed
  // dedupe would treat these as two distinct, unrelated rows).
  const rows = [
    { id: "f-sameid01", source: "forgepad:f-sameid01; first pass" },
    { id: "f-sameid01", source: "forgepad:f-sameid01; second pass, edited" },
  ];
  const { newRows, duplicateInBatch } = partitionNewRows(rows, new Set());
  assert.equal(newRows.length, 1);
  assert.equal(newRows[0].source, "forgepad:f-sameid01; first pass");
  assert.equal(duplicateInBatch, 1);
});

test("partitionNewRows in-batch dedupe composes correctly with the existing-sources check (three-way split)", () => {
  const rows = [
    { id: "f-already1", source: "forgepad:f-already1" }, // already migrated in a prior run
    { id: "f-dupe0002", source: "forgepad:f-dupe0002" }, // first of an in-batch duplicate pair
    { id: "f-dupe0002", source: "forgepad:f-dupe0002" }, // second of the pair
    { id: "f-brandnew", source: "forgepad:f-brandnew" }, // genuinely new
  ];
  const { newRows, alreadyPresent, duplicateInBatch } = partitionNewRows(rows, new Set(["forgepad:f-already1"]));
  assert.deepEqual(newRows.map((r) => r.id), ["f-dupe0002", "f-brandnew"]);
  assert.equal(alreadyPresent, 1);
  assert.equal(duplicateInBatch, 1);
});

// === summarizeCounts =========================================================

test("summarizeCounts buckets every state correctly, including the definite split and rejected ids", () => {
  const rows = [
    mapForgepadIdea(baseIdea({ id: "f-00000001", state: "draft" })),
    mapForgepadIdea(baseIdea({ id: "f-00000002", state: "definite", target: "o/r" })),
    mapForgepadIdea(baseIdea({ id: "f-00000003", state: "definite", target: "" })),
    mapForgepadIdea(baseIdea({ id: "f-00000004", state: "research-needed" })),
    mapForgepadIdea(baseIdea({ id: "f-00000005", state: "rejected" })),
    mapForgepadIdea(baseIdea({ id: "f-00000006", state: "rejected" })),
  ];
  const counts = summarizeCounts(rows);
  assert.equal(counts.draft, 1);
  assert.equal(counts.definiteToIdea, 1);
  assert.equal(counts.definiteToDraftNeedsRepo, 1);
  assert.equal(counts.researchNeeded, 1);
  assert.equal(counts.rejected, 2);
  assert.deepEqual(counts.rejectedIds, ["f-00000005", "f-00000006"]);
});

// === loadForgepadFiles (real filesystem, still DB-free) ====================

test("loadForgepadFiles returns empty with no errors when the ideas directory does not exist", () => {
  const missing = path.join(os.tmpdir(), "migrate-forgepad-does-not-exist-" + Date.now());
  assert.deepEqual(loadForgepadFiles(missing), { files: [], errors: [] });
});

test("loadForgepadFiles loads valid f-*.json files and ignores non-matching filenames", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-forgepad-ok-"));
  try {
    fs.writeFileSync(path.join(dir, "f-11111111.json"), JSON.stringify(baseIdea({ id: "f-11111111" })));
    fs.writeFileSync(path.join(dir, "f-22222222.json"), JSON.stringify(baseIdea({ id: "f-22222222" })));
    fs.writeFileSync(path.join(dir, "README.md"), "not an idea file");
    fs.writeFileSync(path.join(dir, "other.json"), JSON.stringify({ not: "an idea" }));
    const { files, errors } = loadForgepadFiles(dir);
    assert.equal(errors.length, 0);
    assert.deepEqual(
      files.map((f) => f.name),
      ["f-11111111.json", "f-22222222.json"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadForgepadFiles collects errors from every bad file without stopping at the first (fail loud, no partial silence)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-forgepad-bad-"));
  try {
    fs.writeFileSync(path.join(dir, "f-11111111.json"), "{ this is not valid json");
    fs.writeFileSync(path.join(dir, "f-22222222.json"), JSON.stringify(baseIdea({ id: "f-22222222", title: "" })));
    fs.writeFileSync(path.join(dir, "f-33333333.json"), JSON.stringify(baseIdea({ id: "f-33333333" })));
    const { files, errors } = loadForgepadFiles(dir);
    assert.equal(errors.length, 2, "both the unparseable file and the invalid-shape file must be reported");
    assert.ok(errors.some((e) => e.startsWith("f-11111111.json")));
    assert.ok(errors.some((e) => e.startsWith("f-22222222.json")));
    assert.deepEqual(
      files.map((f) => f.name),
      ["f-33333333.json"],
      "the one good file is still parsed and returned even though its siblings are bad -- the CLI itself is what refuses to act on a mixed batch, not this loader",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// === parseArgs ===============================================================

test("parseArgs reads --acc-root and --dry-run in either order", () => {
  assert.deepEqual(parseArgs(["--acc-root", "/x", "--dry-run"]), { accRoot: "/x", dryRun: true, help: false });
  assert.deepEqual(parseArgs(["--dry-run", "--acc-root", "/x"]), { accRoot: "/x", dryRun: true, help: false });
  assert.deepEqual(parseArgs(["--acc-root=/y"]), { accRoot: "/y", dryRun: false, help: false });
});

test("parseArgs rejects an unrecognized flag", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unrecognized argument/);
});

// --- Finding 12: --acc-root must not silently swallow a following flag ---

test(
  "parseArgs rejects --acc-root immediately followed by another flag instead of silently treating the flag as the path (RED before the fix: this used to parse as accRoot='--dry-run', dryRun=false)",
  () => {
    assert.throws(() => parseArgs(["--acc-root", "--dry-run"]), /--acc-root requires a value/);
  },
);

test("parseArgs rejects a trailing --acc-root with nothing after it at all", () => {
  assert.throws(() => parseArgs(["--acc-root"]), /--acc-root requires a value/);
});

test("parseArgs still accepts a real path that simply starts with a hyphen-free directory name adjacent to --dry-run (control: the fix doesn't over-reject legitimate input)", () => {
  assert.deepEqual(parseArgs(["--acc-root", "/x/y-z", "--dry-run"]), { accRoot: "/x/y-z", dryRun: true, help: false });
});
