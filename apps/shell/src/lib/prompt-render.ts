/**
 * A deliberate, byte-for-byte-behavioral COPY of
 * apps/toolbelt/apps/prompt-organizer/web/render.mjs (05-d-prompt-organizer.md
 * section 8's pure `render()` model), not a fresh reimplementation --
 * mirrors packages/llm/src/prompt-render.ts's own copy of the same source
 * for the identical reason, stated there and repeated here: importing
 * packages/llm's copy instead (its barrel also re-exports the
 * Anthropic/Gemini/OpenAI provider drivers, server-side-only dependencies)
 * blew apps/shell's 250 KB gzipped bundle budget by ~33 KB -- see
 * packages/llm/src/index.ts's own comment on that reverted attempt. A THIRD
 * copy is worse than two, but a browser bundle pulling in three LLM
 * provider SDKs to render `{{VAR}}` substitution is worse still.
 * src/lib/prompt-render.test.ts fuzzes this against
 * apps/toolbelt/apps/prompt-organizer/web/render.mjs directly (the same
 * drift-detection shape src/lib/prompt-search.test.ts already uses for its
 * own web/search.mjs port), so a hand-edit to either side that silently
 * diverges fails a test, not a code review.
 *
 * Every regex, the section-pairing algorithm, and the missing-variable rule
 * below are unchanged from the source; only type annotations were added.
 */

const TOKEN_RE = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
const FENCE_RE = /<!--(\/?)OPTIONAL:([A-Za-z0-9_-]+)-->/g;

interface SectionSpan {
  id: string;
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

function sectionSpans(body: string): SectionSpan[] {
  const open = new Map<string, { start: number; contentStart: number }>();
  const pairs: SectionSpan[] = [];
  for (const match of body.matchAll(FENCE_RE)) {
    const [text, closing, id] = match as unknown as [string, string, string];
    if (!closing) {
      if (!open.has(id)) open.set(id, { start: match.index, contentStart: match.index + text.length });
    } else if (open.has(id)) {
      const started = open.get(id)!;
      open.delete(id);
      pairs.push({ id, ...started, contentEnd: match.index, end: match.index + text.length });
    }
  }
  pairs.sort((a, b) => a.start - b.start);
  const spans: SectionSpan[] = [];
  let cursor = 0;
  for (const pair of pairs) {
    if (pair.start >= cursor) {
      spans.push(pair);
      cursor = pair.end;
    }
  }
  return spans;
}

export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of body.matchAll(TOKEN_RE)) {
    const name = match[1] as string;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function extractSections(body: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { id } of sectionSpans(body)) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function applySections(body: string, includes: string[]): string {
  const spans = sectionSpans(body);
  if (spans.length === 0) return body;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += body.slice(cursor, span.start);
    if (includes.includes(span.id)) out += body.slice(span.contentStart, span.contentEnd);
    cursor = span.end;
  }
  return out + body.slice(cursor);
}

export type RenderResult = { ok: true; text: string } | { ok: false; missing: string[] };

export function render(body: string, values: Record<string, string | undefined>, includes: string[] = []): RenderResult {
  const kept = applySections(body, includes);
  const names = extractVariables(kept);
  const missing = names.filter((name) => !(name in values) || values[name] === undefined);
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  const text = kept.replace(TOKEN_RE, (_match, name: string) => String(values[name]));
  return { ok: true, text };
}
