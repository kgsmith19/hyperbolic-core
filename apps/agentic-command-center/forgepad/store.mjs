// forgepad/store.mjs — idea store for Forgepad (issue #57)
// Persists ideas as individual JSON files under <acc_root>/forgepad/ideas/.
// Zero runtime dependencies; all I/O is synchronous for simplicity.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ideasDir = () => {
  const root = process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : REPO;
  return path.join(root, "forgepad", "ideas");
};

export const VALID_STATES = ["draft", "definite", "research-needed", "rejected"];
export const VALID_CONFIDENCE = ["low", "medium", "high"];
const STATE_SET = new Set(VALID_STATES);
const CONFIDENCE_SET = new Set(VALID_CONFIDENCE);

// id shape: f-<8 lowercase hex chars>
const IDEA_ID_RE = /^f-[0-9a-f]{8}$/;
export const validIdeaId = (id) => typeof id === "string" && IDEA_ID_RE.test(id);

function newId() {
  return "f-" + crypto.randomBytes(4).toString("hex");
}

function ideaFile(dir, id) {
  return path.join(dir, `${id}.json`);
}

function readIdea(dir, id) {
  return JSON.parse(fs.readFileSync(ideaFile(dir, id), "utf8"));
}

function writeIdea(dir, idea) {
  const file = ideaFile(dir, idea.id);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(idea, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function validateFields(fields) {
  if (typeof fields.title !== "string" || !fields.title.trim()) throw new Error("title is required");
  if (fields.title.length > 200) throw new Error("title must be \u2264200 characters");
  if (fields.problem !== undefined && typeof fields.problem !== "string") throw new Error("problem must be a string");
  if (fields.outcome !== undefined && typeof fields.outcome !== "string") throw new Error("outcome must be a string");
  if (fields.notes !== undefined && typeof fields.notes !== "string") throw new Error("notes must be a string");
  if (fields.state !== undefined && !STATE_SET.has(fields.state)) {
    throw new Error(`state must be one of: ${VALID_STATES.join(", ")}`);
  }
  if (fields.confidence !== undefined && !CONFIDENCE_SET.has(fields.confidence)) {
    throw new Error(`confidence must be one of: ${VALID_CONFIDENCE.join(", ")}`);
  }
  if (fields.target !== undefined && typeof fields.target !== "string") throw new Error("target must be a string");
  if (fields.source !== undefined && typeof fields.source !== "string") throw new Error("source must be a string");
  if (fields.githubIssue !== undefined && fields.githubIssue !== null && typeof fields.githubIssue !== "string") {
    throw new Error("githubIssue must be a string or null");
  }
}

export function createIdea(fields) {
  validateFields(fields);
  const dir = ideasDir();
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const idea = {
    id: newId(),
    title: fields.title.trim(),
    problem: (fields.problem || "").trim(),
    outcome: (fields.outcome || "").trim(),
    confidence: fields.confidence || "medium",
    notes: (fields.notes || "").trim(),
    state: fields.state || "draft",
    target: (fields.target || "").trim(),
    source: (fields.source || "").trim(),
    created: now,
    updated: now,
    githubIssue: null,
  };
  writeIdea(dir, idea);
  return idea;
}

export function listIdeas(filter = {}) {
  const dir = ideasDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^f-[0-9a-f]{8}\.json$/.test(f))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .filter((idea) => !filter.state || idea.state === filter.state)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export function getIdea(id) {
  if (!validIdeaId(id)) throw new Error("invalid idea id");
  const dir = ideasDir();
  try { return readIdea(dir, id); }
  catch { throw new Error(`idea ${id} not found`); }
}

export function updateIdea(id, fields) {
  if (!validIdeaId(id)) throw new Error("invalid idea id");
  const dir = ideasDir();
  let idea;
  try { idea = readIdea(dir, id); }
  catch { throw new Error(`idea ${id} not found`); }
  const merged = {
    ...idea,
    title: fields.title !== undefined ? String(fields.title).trim() : idea.title,
    problem: fields.problem !== undefined ? String(fields.problem).trim() : idea.problem,
    outcome: fields.outcome !== undefined ? String(fields.outcome).trim() : idea.outcome,
    confidence: fields.confidence !== undefined ? fields.confidence : idea.confidence,
    notes: fields.notes !== undefined ? String(fields.notes).trim() : idea.notes,
    state: fields.state !== undefined ? fields.state : idea.state,
    target: fields.target !== undefined ? String(fields.target).trim() : idea.target,
    source: fields.source !== undefined ? String(fields.source).trim() : idea.source,
    githubIssue: fields.githubIssue !== undefined ? fields.githubIssue : idea.githubIssue,
    updated: new Date().toISOString(),
  };
  validateFields(merged);
  writeIdea(dir, merged);
  return merged;
}

export function deleteIdea(id) {
  if (!validIdeaId(id)) throw new Error("invalid idea id");
  const dir = ideasDir();
  const file = ideaFile(dir, id);
  if (!fs.existsSync(file)) throw new Error(`idea ${id} not found`);
  fs.unlinkSync(file);
}
