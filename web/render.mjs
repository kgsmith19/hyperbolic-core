// SPEC-0003: extractVariables, render. Pure functions, CON-004 syntax.
const TOKEN_RE = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

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
export function render(body, values) {
  const names = extractVariables(body);
  const missing = names.filter((name) => !(name in values) || values[name] === undefined);
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  const text = body.replace(TOKEN_RE, (_match, name) => String(values[name]));
  return { ok: true, text };
}
