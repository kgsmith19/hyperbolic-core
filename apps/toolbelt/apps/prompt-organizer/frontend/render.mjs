// SPEC-0003: extractVariables, render. Pure functions, CON-004 syntax.
const TOKEN_RE = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
// SPEC-0007: matches EITHER fence, opening or closing. Deliberately not a
// pair-matching pattern -- SL-003's `<!--OPTIONAL:(id)-->([\s\S]*?)<!--/
// OPTIONAL:\1-->` re-scanned to end-of-string once per opening fence, so a
// body of unterminated fences cost O(n^2) and blew NFR-002's 100ms budget at
// 99,994 chars, a size FR-001's CHECK allows. This one has no nested
// quantifier and cannot backtrack; pairing happens in one linear pass below.
const FENCE_RE = /<!--(\/?)OPTIONAL:([A-Za-z0-9_-]+)-->/g;

// Complete section pairs, left-to-right and non-overlapping -- the same set
// the old non-greedy pair-regex produced, at O(n). "First open wins" (an id
// already open is not reopened) reproduces its pairing; a closing fence with
// no matching open is ignored, which is what keeps mismatched ids, stray
// closers, and lone opening fences as literal text (SPEC-0006 AC-004, and
// SL-002's PROP-005 byte-for-byte guarantee). Overlapping pairs are dropped
// left-to-right, so interleaved sections degrade to the established
// behavior instead of corrupting output; nested sections remain undefined.
function sectionSpans(body) {
  const open = new Map();
  const pairs = [];
  for (const match of body.matchAll(FENCE_RE)) {
    const [text, closing, id] = match;
    if (!closing) {
      if (!open.has(id)) open.set(id, { start: match.index, contentStart: match.index + text.length });
    } else if (open.has(id)) {
      const started = open.get(id);
      open.delete(id);
      pairs.push({ id, ...started, contentEnd: match.index, end: match.index + text.length });
    }
  }
  pairs.sort((a, b) => a.start - b.start);
  const spans = [];
  let cursor = 0;
  for (const pair of pairs) {
    if (pair.start >= cursor) {
      spans.push(pair);
      cursor = pair.end;
    }
  }
  return spans;
}

// Ordered, deduplicated list of {{NAME}} token names in `body` (AC-004,
// PROP-002). Malformed spans (`{{}}`, unterminated `{{`) never match the
// regex, so they are simply not tokens (RISK-001).
export function extractVariables(body) {
  const seen = new Set();
  const names = [];
  for (const match of body.matchAll(TOKEN_RE)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  return names;
}

// Ordered, deduplicated list of well-formed section ids (AC-003, PROP-002).
// Reads the same span list applySections does, so the two cannot disagree
// about what counts as a section.
export function extractSections(body) {
  const seen = new Set();
  const ids = [];
  for (const { id } of sectionSpans(body)) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// Keeps a listed section's content and drops an unlisted section entirely,
// removing the fence comments either way (FR-005, AC-001/AC-002). Membership
// is a set test, so the order of `includes` cannot matter (PROP-006).
function applySections(body, includes) {
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

// Substitutes every {{NAME}} occurrence with values[NAME]. A name is
// "missing" only when its key is absent or its value is undefined -- an
// empty string is a supplied value (AC-002's Given, PROP-001). On success
// returns { ok: true, text }; on any missing variable, never substitutes
// partially -- returns { ok: false, missing } naming every missing name in
// extraction order (PROP-001, PROP-006: order of `values`' keys is
// irrelevant since lookup is by name, not iteration).
//
// Sections resolve BEFORE variables substitute: a variable living only in an
// excluded block is not in the text being rendered, so FR-010 must not demand
// a value for text that is about to be deleted (AC-005). `includes` defaults
// to empty, which leaves every SL-002 caller's behavior unchanged (AC-006).
export function render(body, values, includes = []) {
  const kept = applySections(body, includes);
  const names = extractVariables(kept);
  const missing = names.filter((name) => !(name in values) || values[name] === undefined);
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  const text = kept.replace(TOKEN_RE, (_match, name) => String(values[name]));
  return { ok: true, text };
}
