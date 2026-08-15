// Prompt Organizer data access (m5-01/m5-02, docs/planning/05-d-prompt-organizer.md).
// Same PostgREST convention every other Shell data module uses (registry.ts,
// intake.ts): raw fetch, explicit apikey/Authorization/*-Profile headers
// carrying the CALLER's own session JWT, never the supabase-js query
// builder -- owner_rw RLS (prompt.prompt/_version/tag/usage/configuration,
// 20260812180000_prompt_owner_pin.sql) is the real authorization boundary.
//
// Rendering is deliberately NOT done through rpc/render_prompt or
// rpc/get_prompt here: those exist for OTHER consumers (the Brain, LifeOS,
// packages/llm's injection client) that don't hold the raw body. This
// management UI already has the body in hand from the list query, so it
// renders locally with ./prompt-render's render() -- the same pure model
// apps/toolbelt/apps/prompt-organizer/frontend/panel.mjs already used (see that
// file's own header comment on why it is a local copy, not an import from
// packages/llm).
import { postgrestFor } from "./postgrest";

const postgrest = postgrestFor("prompts-client", "prompt");

export interface PromptVersion {
  versionNo: number;
  body: string;
  createdAt: string;
}

export interface Configuration {
  name: string;
  values: Record<string, string>;
  sections: string[];
}

export interface Prompt {
  id: string;
  title: string;
  body: string;
  isActive: boolean;
  tags: string[];
  currentVersionNo: number;
  configurations: Configuration[];
  usageCount: number;
  createdAt: string;
}

interface RawPromptRow {
  id: string;
  title: string;
  body: string;
  is_active: boolean;
  created_at: string;
  tag: { tag: string }[] | null;
  prompt_version: { version_no: number }[] | null;
  configuration: Configuration[] | null;
}

const SELECT_COLUMNS =
  "id,title,body,is_active,created_at,tag(tag),prompt_version(version_no),configuration(name,values,sections)";

function toPrompt(row: RawPromptRow, usageCount: number): Prompt {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    isActive: row.is_active,
    tags: (row.tag ?? []).map((t) => t.tag),
    // record_version (20260807041000) fires on every insert, so a real row
    // always has at least one prompt_version -- the embed's own
    // `&prompt_version.limit=1` (newest first) makes [0] the current one.
    currentVersionNo: row.prompt_version?.[0]?.version_no ?? 1,
    configurations: row.configuration ?? [],
    usageCount,
    createdAt: row.created_at,
  };
}



/** Every usage row for the given prompt ids, counted client-side (no
 * dependency on PostgREST's optional aggregate-embed feature, which is not
 * guaranteed enabled on every project). One query for the whole list,
 * matching the list's own "one-query list" simplicity rule (05-h's already-
 * established precedent for the same tradeoff in this repo's other list
 * pages) -- an unbounded personal prompt library's usage log is small
 * enough that a second full-column-free query is cheap. */
async function fetchUsageCounts(promptIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (promptIds.length === 0) return counts;
  const res = await postgrest(`/usage?select=prompt_id`);
  const rows = (await res.json()) as { prompt_id: string }[];
  for (const row of rows) {
    if (!promptIds.includes(row.prompt_id)) continue;
    counts.set(row.prompt_id, (counts.get(row.prompt_id) ?? 0) + 1);
  }
  return counts;
}

export async function listPrompts(): Promise<Prompt[]> {
  const res = await postgrest(
    `/prompt?select=${SELECT_COLUMNS}&order=created_at.desc&prompt_version.order=version_no.desc&prompt_version.limit=1`
  );
  const rows = (await res.json()) as RawPromptRow[];
  const counts = await fetchUsageCounts(rows.map((r) => r.id));
  return rows.map((row) => toPrompt(row, counts.get(row.id) ?? 0));
}

export async function getPrompt(id: string): Promise<Prompt | null> {
  const res = await postgrest(
    `/prompt?id=eq.${encodeURIComponent(id)}&select=${SELECT_COLUMNS}&prompt_version.order=version_no.desc&prompt_version.limit=1`
  );
  const rows = (await res.json()) as RawPromptRow[];
  const row = rows[0];
  if (!row) return null;
  const counts = await fetchUsageCounts([row.id]);
  return toPrompt(row, counts.get(row.id) ?? 0);
}

/** Title+body only -- the exact insert grant (20260807020000/041000): every
 * other column (id, user_id, is_active, created_at) is server-defaulted,
 * never client-supplied. Tags attach in a second call (matching the
 * original client's own two-step save+tag sequence), since prompt.tag rows
 * need the new prompt's real id. */
export async function createPrompt(fields: { title: string; body: string; tags?: string[] }): Promise<Prompt> {
  const res = await postgrest(`/prompt`, {
    method: "POST",
    body: JSON.stringify({ title: fields.title, body: fields.body }),
  });
  const rows = (await res.json()) as { id: string }[];
  const created = rows[0];
  if (!created) throw new Error("prompts-client: create returned no row");

  const tags = fields.tags ?? [];
  if (tags.length > 0) {
    await addTags(created.id, tags);
  }
  const full = await getPrompt(created.id);
  if (!full) throw new Error("prompts-client: created prompt vanished before it could be re-read");
  return full;
}

/** Body-edit save (m5-02): every save is versioned by `record_version`
 * (fires AFTER UPDATE OF body, skipping no-op writes where the body is
 * unchanged -- 20260807041000). */
export async function updateBody(id: string, body: string): Promise<Prompt> {
  await postgrest(`/prompt?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
  const full = await getPrompt(id);
  if (!full) throw new Error("prompts-client: update returned no row (not found, or RLS hid it)");
  return full;
}

/** Restore is a body PATCH with a prior version's body -- record_version
 * records it as a NEW version, history is never rewritten (05-d section 7).
 * A distinct name from updateBody because callers care about the intent
 * ("this is a rollback"), even though the request shape is identical. */
export const restoreVersion = updateBody;

/** Title edits are refused in the UI for namespaced prompts (05-d section
 * 5's rename rule) -- this function itself has no such guard, matching
 * updateBody: the guard belongs at the UI layer that decides whether to
 * offer the control at all, exactly like src/lib/intake.ts's IdeaPatch.status
 * comment documents the same split for its own guard. */
export async function updateTitle(id: string, title: string): Promise<Prompt> {
  await postgrest(`/prompt?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
  const full = await getPrompt(id);
  if (!full) throw new Error("prompts-client: update returned no row (not found, or RLS hid it)");
  return full;
}

export async function setArchived(id: string, isActive: boolean): Promise<Prompt> {
  await postgrest(`/prompt?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: isActive }),
  });
  const full = await getPrompt(id);
  if (!full) throw new Error("prompts-client: update returned no row (not found, or RLS hid it)");
  return full;
}

export async function listVersions(promptId: string): Promise<PromptVersion[]> {
  const res = await postgrest(
    `/prompt_version?prompt_id=eq.${encodeURIComponent(promptId)}&select=version_no,body,created_at&order=version_no.desc`
  );
  const rows = (await res.json()) as { version_no: number; body: string; created_at: string }[];
  return rows.map((r) => ({ versionNo: r.version_no, body: r.body, createdAt: r.created_at }));
}

/** Comma-separated tag input parsing lives in the UI layer (matching the
 * original client's parseTagInput, SPEC-0004) -- this function accepts an
 * already-trimmed, deduplicated list and bulk-inserts it. */
export async function addTags(promptId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  await postgrest(`/tag`, {
    method: "POST",
    body: JSON.stringify(tags.map((tag) => ({ prompt_id: promptId, tag }))),
  });
}

export async function saveConfiguration(
  promptId: string,
  name: string,
  values: Record<string, string>,
  sections: string[]
): Promise<Configuration> {
  const res = await postgrest(`/configuration`, {
    method: "POST",
    body: JSON.stringify({ prompt_id: promptId, name, values, sections }),
  });
  const rows = (await res.json()) as Configuration[];
  const saved = rows[0];
  if (!saved) throw new Error("prompts-client: save configuration returned no row");
  return saved;
}

/** SPEC-0008 (FR-011): a usage row per copy, naming the prompt id and the
 * exact version copied. SPEC-0009 (NFR-010): also logs the render's wall-clock
 * time through toolbelt's core.log_run RPC (Content-Profile: core, not a
 * direct write against core.* -- apps/toolbelt/AGENTS.md forbids that from
 * outside the repository that owns core). Deliberately fire-and-forget,
 * called AFTER the copy confirmation already shown, never blocking it
 * (matching web/panel.mjs's own sequencing) -- callers should not await this
 * before updating "Copied!" UI state. */
export async function recordUsage(promptId: string, versionNo: number, wallClockMs: number): Promise<void> {
  await postgrest(`/usage`, {
    method: "POST",
    body: JSON.stringify({ prompt_id: promptId, version_no: versionNo }),
  });
  await postgrest(
    `/rpc/log_run`,
    {
      method: "POST",
      body: JSON.stringify({ p_app_id: "prompt-organizer", p_kind: "render", p_wall_clock_ms: wallClockMs }),
    },
    "core"
  );
}

/** chars/4 heuristic (05-d section 9, rank 2): a budget-awareness estimate,
 * always rendered labeled "estimate" -- never presented as an exact
 * provider token count. */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/** SPEC-0004: comma-separated tag input, trimmed, lowercased, deduplicated
 * client-side before it reaches the wire (7.1 -- no server-side folding).
 * Ported verbatim from web/index.html's own parseTagInput. */
export function parseTagInput(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim().toLowerCase();
    if (tag !== "" && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}
