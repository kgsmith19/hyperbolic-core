// node --test forgepad/store.test.mjs  (run from repo root)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-forgepad-"));
process.env.ACC_ROOT = BASE;

const { createIdea, listIdeas, getIdea, updateIdea, deleteIdea, validIdeaId } = await import("./store.mjs");

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

// validIdeaId
test("validIdeaId rejects bad shapes", () => {
  assert.equal(validIdeaId("not-an-idea"), false);
  assert.equal(validIdeaId("f-toolong99"), false);
  assert.equal(validIdeaId(""), false);
  assert.equal(validIdeaId(null), false);
  assert.equal(validIdeaId("f-ABCDEF12"), false); // uppercase not allowed
});

test("validIdeaId accepts a real id shape", () => {
  assert.equal(validIdeaId("f-1a2b3c4d"), true);
});

// createIdea
test("createIdea returns an idea with all required fields", () => {
  const idea = createIdea({ title: "My first idea" });
  assert.ok(validIdeaId(idea.id));
  assert.equal(idea.title, "My first idea");
  assert.equal(idea.state, "draft");
  assert.equal(idea.confidence, "medium");
  assert.ok(idea.created);
  assert.ok(idea.updated);
  assert.equal(idea.githubIssue, null);
});

test("createIdea trims whitespace-only title and rejects it", () => {
  assert.throws(() => createIdea({ title: "   " }), /title is required/);
});

test("createIdea rejects missing title", () => {
  assert.throws(() => createIdea({}), /title is required/);
});

test("createIdea rejects invalid state", () => {
  assert.throws(() => createIdea({ title: "x", state: "invalid" }), /state must be/);
});

test("createIdea rejects invalid confidence", () => {
  assert.throws(() => createIdea({ title: "x", confidence: "maybe" }), /confidence must be/);
});

test("createIdea persists the idea to disk", () => {
  const idea = createIdea({ title: "Persisted", problem: "Big problem", state: "definite" });
  const fetched = getIdea(idea.id);
  assert.equal(fetched.title, "Persisted");
  assert.equal(fetched.problem, "Big problem");
  assert.equal(fetched.state, "definite");
});

// listIdeas
test("listIdeas returns empty array when ideas dir is absent", () => {
  // Use a fresh temp dir that has no forgepad/ideas/ subdirectory at all.
  const savedRoot = process.env.ACC_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acc-fp-empty-"));
  process.env.ACC_ROOT = tmp;
  try {
    // Module is already imported; ideasDir() reads ACC_ROOT at call time.
    assert.deepEqual(listIdeas(), []);
  } finally {
    process.env.ACC_ROOT = savedRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("listIdeas returns ideas sorted newest-updated first", () => {
  const a = createIdea({ title: "Earliest" });
  const b = createIdea({ title: "Latest" });
  const list = listIdeas();
  assert.ok(list.findIndex((i) => i.id === b.id) <= list.findIndex((i) => i.id === a.id));
});

test("listIdeas filters by state", () => {
  createIdea({ title: "Draft one" });
  createIdea({ title: "Definite one", state: "definite" });
  const drafts = listIdeas({ state: "draft" });
  assert.ok(drafts.length >= 1);
  assert.ok(drafts.every((i) => i.state === "draft"));
  const definites = listIdeas({ state: "definite" });
  assert.ok(definites.length >= 1);
  assert.ok(definites.every((i) => i.state === "definite"));
});

// getIdea
test("getIdea retrieves an existing idea", () => {
  const created = createIdea({ title: "Retrieve me" });
  const fetched = getIdea(created.id);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.title, "Retrieve me");
});

test("getIdea throws for unknown id", () => {
  assert.throws(() => getIdea("f-00000000"), /not found/);
});

test("getIdea throws for invalid id", () => {
  assert.throws(() => getIdea("not-valid"), /invalid idea id/);
});

// updateIdea
test("updateIdea changes specified fields", () => {
  const idea = createIdea({ title: "Original", state: "draft" });
  const updated = updateIdea(idea.id, { title: "Updated", state: "definite" });
  assert.equal(updated.title, "Updated");
  assert.equal(updated.state, "definite");
  assert.equal(updated.id, idea.id);
});

test("updateIdea preserves fields not mentioned", () => {
  const idea = createIdea({ title: "Keep", problem: "The problem", state: "draft" });
  const updated = updateIdea(idea.id, { state: "research-needed" });
  assert.equal(updated.problem, "The problem");
  assert.equal(updated.state, "research-needed");
});

test("updateIdea persists changes to disk", () => {
  const idea = createIdea({ title: "Persist update" });
  updateIdea(idea.id, { notes: "some notes" });
  assert.equal(getIdea(idea.id).notes, "some notes");
});

test("updateIdea throws for unknown idea", () => {
  assert.throws(() => updateIdea("f-00000000", { title: "x" }), /not found/);
});

test("updateIdea throws for invalid id", () => {
  assert.throws(() => updateIdea("bad", { title: "x" }), /invalid idea id/);
});

test("updateIdea rejects invalid state transition", () => {
  const idea = createIdea({ title: "Bad state" });
  assert.throws(() => updateIdea(idea.id, { state: "flying" }), /state must be/);
});

// deleteIdea
test("deleteIdea removes the idea from disk", () => {
  const idea = createIdea({ title: "Delete me" });
  deleteIdea(idea.id);
  assert.throws(() => getIdea(idea.id), /not found/);
});

test("deleteIdea throws for unknown idea", () => {
  assert.throws(() => deleteIdea("f-00000000"), /not found/);
});

test("deleteIdea throws for invalid id", () => {
  assert.throws(() => deleteIdea("bad-id"), /invalid idea id/);
});
