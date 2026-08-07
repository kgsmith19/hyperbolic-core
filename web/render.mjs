// SPEC-0003: extractVariables, render. Pure functions, CON-004 syntax.
const TOKEN_RE = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
// SPEC-0006: a section is a well-formed PAIR. The closing id is a
// backreference, so `<!--OPTIONAL:x-->...<!--/OPTIONAL:y-->` is not a section;
// the id charset requires at least one character, so `<!--OPTIONAL:-->` is
// not either. Both stay literal text (AC-004), which is what preserves
// SL-002's PROP-005 byte-for-byte guarantee for a lone opening fence.
// Content is non-greedy so sibling sections never merge; nesting is
// undefined behavior by PRD ASM-004.
const SECTION_RE = /<!--OPTIONAL:([A-Za-z0-9_-]+)-->([\s\S]*?)<!--\/OPTIONAL:\1-->/g;

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

// Substitutes every {{NAME}} occurrence with values[NAME]. A name is
// "missing" only when its key is absent or its value is undefined -- an
// empty string is a supplied value (AC-002's Given, PROP-001). On success
// returns { ok: true, text }; on any missing variable, never substitutes
// partially -- returns { ok: false, missing } naming every missing name in
// extraction order (PROP-001, PROP-006: order of `values`' keys is
// irrelevant since lookup is by name, not iteration).
// Ordered, deduplicated list of well-formed section ids (AC-003, PROP-002).
export function extractSections(body) {
  const seen = new Set();
  const ids = [];
  for (const match of body.matchAll(SECTION_RE)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  }
  return ids;
}

// Keeps a listed section's content and drops an unlisted section entirely,
// removing the fence comments either way (FR-005, AC-001/AC-002). Membership
// is a set test, so the order of `includes` cannot matter (PROP-006).
function applySections(body, includes) {
  return body.replace(SECTION_RE, (_match, id, content) =>
    includes.includes(id) ? content : "",
  );
}

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
