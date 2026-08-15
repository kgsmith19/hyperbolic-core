// Idea Intake data access (m3-07, docs/planning/05-h-idea-intake.md
// sections 2/3/6/7). Two backends, two access patterns, both established
// elsewhere in this repo:
//
// 1. Reads/writes on intake.idea ride the caller's own session JWT straight
//    through PostgREST (owner_rw RLS is the real boundary) -- same explicit
//    apikey/Authorization/*-Profile header shape as src/lib/registry.ts and
//    services/llm-handler/src/postgrest.ts, not the supabase-js query
//    builder.
// 2. Submit calls services/llm-handler's POST /api/intake/submit (m3-06) --
//    a same-origin relative path (ADR-02), so platformClient.fetch
//    (authedFetch) is the right tool here: it verifies the target is
//    same-origin/allowlisted and attaches the live session token itself,
//    unlike the manual-header PostgREST calls above.
import { platformClient } from "./session";
import { postgrestFor } from "./postgrest";

const postgrest = postgrestFor("intake-client", "intake");

export type IdeaStatus = "draft" | "idea" | "submitted_to_github";
export type Confidence = "low" | "medium" | "high";

export interface Idea {
  id: string;
  parentIdeaId: string | null;
  title: string;
  problem: string;
  outcome: string;
  notes: string;
  confidence: Confidence;
  status: IdeaStatus;
  source: string;
  targetRepo: string | null;
  idempotencyKey: string;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  submittedAt: string | null;
  parentGithubIssueUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawIdeaRow {
  id: string;
  parent_idea_id: string | null;
  title: string;
  problem: string;
  outcome: string;
  notes: string;
  confidence: Confidence;
  status: IdeaStatus;
  source: string;
  target_repo: string | null;
  idempotency_key: string;
  github_issue_number: number | null;
  github_issue_url: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  parent?: { github_issue_url: string | null } | null;
}

const SELECT_COLUMNS =
  "id,parent_idea_id,title,problem,outcome,notes,confidence,status,source,target_repo," +
  "idempotency_key,github_issue_number,github_issue_url,submitted_at,created_at,updated_at," +
  "parent:parent_idea_id(github_issue_url)";

function toIdea(row: RawIdeaRow): Idea {
  return {
    id: row.id,
    parentIdeaId: row.parent_idea_id,
    title: row.title,
    problem: row.problem,
    outcome: row.outcome,
    notes: row.notes,
    confidence: row.confidence,
    status: row.status,
    source: row.source,
    targetRepo: row.target_repo,
    idempotencyKey: row.idempotency_key,
    githubIssueNumber: row.github_issue_number,
    githubIssueUrl: row.github_issue_url,
    submittedAt: row.submitted_at,
    parentGithubIssueUrl: row.parent?.github_issue_url ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}



/** One query, ordered newest-first; list.tsx applies the filter-tab and
 * title-filter narrowing client-side (05-h section 8's own simplicity rule:
 * "no search beyond the filter tabs plus a client-side title filter box"). */
export async function listIdeas(): Promise<Idea[]> {
  const res = await postgrest(`/idea?select=${SELECT_COLUMNS}&order=updated_at.desc`);
  const rows = (await res.json()) as RawIdeaRow[];
  return rows.map(toIdea);
}

export async function getIdea(id: string): Promise<Idea | null> {
  const res = await postgrest(`/idea?id=eq.${encodeURIComponent(id)}&select=${SELECT_COLUMNS}&limit=1`);
  const rows = (await res.json()) as RawIdeaRow[];
  return rows[0] ? toIdea(rows[0]) : null;
}

export interface DraftFields {
  title: string;
  problem?: string;
  outcome?: string;
  notes?: string;
  confidence?: Confidence;
  source?: string;
  targetRepo?: string | null;
  parentIdeaId?: string | null;
}

/** Every idea is born draft (the status/idempotency_key/github_* columns
 * are not in the INSERT grant at all -- 20260813002605_intake_create_schema.sql
 * section 3.2), so this never accepts a status. */
export async function createDraft(fields: DraftFields): Promise<Idea> {
  const res = await postgrest(`/idea?select=${SELECT_COLUMNS}`, {
    method: "POST",
    body: JSON.stringify({
      title: fields.title,
      problem: fields.problem ?? "",
      outcome: fields.outcome ?? "",
      notes: fields.notes ?? "",
      confidence: fields.confidence ?? "medium",
      source: fields.source ?? "",
      target_repo: fields.targetRepo ?? null,
      parent_idea_id: fields.parentIdeaId ?? null,
    }),
  });
  const rows = (await res.json()) as RawIdeaRow[];
  const row = rows[0];
  if (!row) throw new Error("intake-client: create draft returned no row");
  return toIdea(row);
}

export interface IdeaPatch {
  title?: string;
  problem?: string;
  outcome?: string;
  notes?: string;
  confidence?: Confidence;
  source?: string;
  targetRepo?: string | null;
  /** Only "draft" (save-in-place) or "idea" (promote) are ever legal client
   * inputs -- "submitted_to_github" is reachable only through
   * intake.mark_submitted_to_github(), a service_role-only RPC this client
   * never calls (services/llm-handler/src/postgrest.ts calls it instead).
   * The idea_guard_update trigger enforces this same rule server-side
   * regardless, so this type is a UI-level guardrail, not the real one. */
  status?: "draft" | "idea";
}

export async function updateIdea(id: string, patch: IdeaPatch): Promise<Idea> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.problem !== undefined) body.problem = patch.problem;
  if (patch.outcome !== undefined) body.outcome = patch.outcome;
  if (patch.notes !== undefined) body.notes = patch.notes;
  if (patch.confidence !== undefined) body.confidence = patch.confidence;
  if (patch.source !== undefined) body.source = patch.source;
  if (patch.targetRepo !== undefined) body.target_repo = patch.targetRepo;
  if (patch.status !== undefined) body.status = patch.status;
  const res = await postgrest(`/idea?id=eq.${encodeURIComponent(id)}&select=${SELECT_COLUMNS}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  const rows = (await res.json()) as RawIdeaRow[];
  const row = rows[0];
  if (!row) throw new Error("intake-client: update returned no row (not found, or the guard trigger rejected the transition)");
  return toIdea(row);
}

export async function deleteIdea(id: string): Promise<void> {
  await postgrest(`/idea?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

const INTAKE_API_BASE_URL = (import.meta.env?.VITE_INTAKE_API || "/api/intake").replace(/\/+$/, "");

export type SubmitResult =
  | { kind: "ok"; issueNumber: number; issueUrl: string }
  | { kind: "draft_not_promoted" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

/** POST /api/intake/submit (services/llm-handler, m3-06). Never throws for
 * an expected outcome (409/401/5xx all resolve typed results) -- only a
 * genuine transport failure (network down, CORS) propagates as a rejection,
 * matching authedFetch's own contract. */
export async function submitIdea(id: string): Promise<SubmitResult> {
  const res = await platformClient.fetch(`${INTAKE_API_BASE_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ideaId: id }),
  });
  if (res.status === 409) return { kind: "draft_not_promoted" };
  if (res.status === 401) return { kind: "unauthorized" };
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    return { kind: "error", message: parsed?.message ?? parsed?.error ?? `submit failed with HTTP ${res.status}` };
  }
  const body = (await res.json()) as { issueNumber: number; issueUrl: string };
  return { kind: "ok", issueNumber: body.issueNumber, issueUrl: body.issueUrl };
}

/** Client-side preview of the exact issue GitHub will receive --
 * services/llm-handler/src/intake-submit.ts's buildBody/buildMarker/
 * buildLabels is the real, authoritative implementation; this is a
 * deliberate, narrow duplication (05-h section 8: the submit confirmation
 * modal must show "the rendered issue title, body preview... and labels"
 * BEFORE any network call, so the preview cannot come from the server). Any
 * drift between this and the server's own template only ever affects the
 * preview's accuracy, never what actually gets created -- the server never
 * reads this function's output. */
export function buildSubmitPreview(idea: Idea): { title: string; body: string; labels: string[] } {
  const marker = `<!-- idea-intake:v1 idea=${idea.id} key=${idea.idempotencyKey} -->`;
  const derivedLine = idea.parentGithubIssueUrl ? `Derived from: ${idea.parentGithubIssueUrl}\n` : "";
  const body =
    `## Problem\n${idea.problem}\n\n` +
    `## Desired outcome\n${idea.outcome}\n\n` +
    `## Notes\n${idea.notes}\n\n` +
    `Confidence: ${idea.confidence}. Source: ${idea.source}.\n` +
    `${derivedLine}\n` +
    `${marker}\n`;
  const labels = ["from-idea-intake", ...(idea.parentGithubIssueUrl ? ["derived"] : [])];
  return { title: idea.title, body, labels };
}
