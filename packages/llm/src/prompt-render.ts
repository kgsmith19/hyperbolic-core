/**
 * m4-04: client-side template rendering for the prompt-client cache
 * (docs/planning/05-d-prompt-organizer.md section 4, third bullet: "Rendering
 * happens client-side from the cached template ... whenever variables/
 * sections are supplied per-call, so a cache hit never touches the
 * network").
 *
 * This is a deliberate, byte-for-byte-behavioral COPY of
 * apps/toolbelt/apps/prompt-organizer/frontend/render.mjs, not a fresh
 * reimplementation. Section 8 of 05-d says the pure `render()` model and the
 * SQL `prompt.get_prompt` RPC are "provably equivalent," a claim two existing
 * suites in that app assert (tests/render.test.mjs, tests/render-endpoint.
 * test.mjs). Importing render.mjs directly from packages/llm was rejected:
 * apps/toolbelt is a separately-subtree-imported app (see AGENTS.md's
 * repository-purpose note) and no package in this monorepo reaches across an
 * apps/* boundary into another app's source today, so a relative import
 * would be a new, unprecedented coupling between an app and a package. A copy
 * keeps packages/llm's dependency graph exactly what its package.json already
 * declares (zero deps beyond the three provider SDKs) at the cost of needing
 * to keep this file in sync by hand if render.mjs's algorithm ever changes.
 * packages/llm/tests/prompt-render-parity.test.mjs fuzzes both
 * implementations against the same inputs and asserts identical output,
 * which is this repo's actual enforcement mechanism for that sync, not just
 * a comment promising it.
 *
 * Every regex, the section-pairing algorithm, and the missing-variable rule
 * below are unchanged from the source; only type annotations were added.
 */

// SPEC-0003: extractVariables, render. Pure functions, CON-004 syntax.
const TOKEN_RE = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
// SPEC-0007: matches EITHER fence, opening or closing. Deliberately not a
// pair-matching pattern -- SL-003's `<!--OPTIONAL:(id)-->([\s\S]*?)<!--/
// OPTIONAL:\1-->` re-scanned to end-of-string once per opening fence, so a
// body of unterminated fences cost O(n^2) and blew NFR-002's 100ms budget at
// 99,994 chars, a size FR-001's CHECK allows. This one has no nested
// quantifier and cannot backtrack; pairing happens in one linear pass below.
const FENCE_RE = /<!--(\/?)OPTIONAL:([A-Za-z0-9_-]+)-->/g;

interface SectionSpan {
  id: string;
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

// Complete section pairs, left-to-right and non-overlapping -- the same set
// the old non-greedy pair-regex produced, at O(n). "First open wins" (an id
// already open is not reopened) reproduces its pairing; a closing fence with
// no matching open is ignored, which is what keeps mismatched ids, stray
// closers, and lone opening fences as literal text. Overlapping pairs are
// dropped left-to-right, so interleaved sections degrade to the established
// behavior instead of corrupting output; nested sections remain undefined.
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

/** Ordered, deduplicated list of {{NAME}} token names in `body`. Malformed
 * spans (`{{}}`, unterminated `{{`) never match the regex, so they are
 * simply not tokens. */
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

/** Ordered, deduplicated list of well-formed section ids. Reads the same
 * span list applySections does, so the two cannot disagree about what
 * counts as a section. */
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

// Keeps a listed section's content and drops an unlisted section entirely,
// removing the fence comments either way. Membership is a set test, so the
// order of `includes` cannot matter.
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

/**
 * Substitutes every {{NAME}} occurrence with values[NAME]. A name is
 * "missing" only when its key is absent or its value is undefined -- an
 * empty string is a supplied value. On success returns { ok: true, text };
 * on any missing variable, never substitutes partially -- returns
 * { ok: false, missing } naming every missing name in extraction order.
 *
 * Sections resolve BEFORE variables substitute: a variable living only in an
 * excluded block is not in the text being rendered, so it must not demand a
 * value for text that is about to be deleted. `includes` defaults to empty.
 */
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
