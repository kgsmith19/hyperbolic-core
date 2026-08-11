// SPEC-0001, extended by SPEC-0004 (SL-006): case-insensitive literal
// substring filter over title+tags+body, title-match group first, tag-match
// group second (both "found by name," FR-006), body-only group last, stable
// within groups, input never mutated. `prompt.tags` is optional -- a prompt
// with no `.tags` property is treated as carrying zero tags, so callers that
// predate tags (SL-001's fixtures) are unaffected.
export function searchPrompts(prompts, query) {
  const q = query.toLowerCase();
  const titleMatches = [];
  const tagMatches = [];
  const bodyMatches = [];
  for (const prompt of prompts) {
    const tags = prompt.tags ?? [];
    if (prompt.title.toLowerCase().includes(q)) titleMatches.push(prompt);
    else if (tags.some((tag) => tag.toLowerCase().includes(q))) tagMatches.push(prompt);
    else if (prompt.body.toLowerCase().includes(q)) bodyMatches.push(prompt);
  }
  return titleMatches.concat(tagMatches, bodyMatches);
}

// SPEC-0004 AC-005: the tag filter is a toggle -- clicking the currently
// selected chip again clears it, clicking any other chip selects it.
export function toggleTagFilter(current, tag) {
  return current === tag ? null : tag;
}

// SPEC-0010 AC-001: archived prompts are hidden unless explicitly requested.
// `prompt.isActive` is optional -- absent (undefined) is treated as active,
// so callers that predate archiving are unaffected.
export function filterByActive(prompts, showArchived) {
  return showArchived ? prompts : prompts.filter((p) => p.isActive !== false);
}

// NFR-008: "/" focuses search from anywhere, except while a text field
// already has focus, where it must type a literal "/" instead.
const TYPING_TAGS = ["INPUT", "TEXTAREA", "SELECT"];
export function shouldFocusSearch(key, targetTagName) {
  return key === "/" && !TYPING_TAGS.includes(targetTagName);
}
