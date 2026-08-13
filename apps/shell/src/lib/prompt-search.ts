// Ported verbatim (algorithm unchanged, only types added) from
// apps/toolbelt/apps/prompt-organizer/web/search.mjs. Not shared through
// @hyperbolic/llm like prompt-render.ts: this logic is Shell-list-UI-only
// (title/tag/body search, tag-filter toggling, archived-visibility, the "/"
// focus shortcut) with no other TypeScript consumer to justify a shared
// package location -- packages/llm's own export exists specifically because
// packages/llm/src/prompt-client.ts needs render() for its cache, which none
// of these four functions apply to.
import type { Prompt } from "./prompts";

/** SPEC-0001, extended by SPEC-0004 (SL-006): case-insensitive literal
 * substring filter over title+tags+body, title-match group first, tag-match
 * group second (both "found by name"), body-only group last, stable within
 * groups, input never mutated. */
export function searchPrompts(prompts: Prompt[], query: string): Prompt[] {
  const q = query.toLowerCase();
  const titleMatches: Prompt[] = [];
  const tagMatches: Prompt[] = [];
  const bodyMatches: Prompt[] = [];
  for (const prompt of prompts) {
    const tags = prompt.tags ?? [];
    if (prompt.title.toLowerCase().includes(q)) titleMatches.push(prompt);
    else if (tags.some((tag) => tag.toLowerCase().includes(q))) tagMatches.push(prompt);
    else if (prompt.body.toLowerCase().includes(q)) bodyMatches.push(prompt);
  }
  return titleMatches.concat(tagMatches, bodyMatches);
}

/** SPEC-0004 AC-005: the tag filter is a toggle -- clicking the currently
 * selected chip again clears it, clicking any other chip selects it. */
export function toggleTagFilter(current: string | null, tag: string): string | null {
  return current === tag ? null : tag;
}

/** SPEC-0010 AC-001: archived prompts are hidden unless explicitly requested. */
export function filterByActive(prompts: Prompt[], showArchived: boolean): Prompt[] {
  return showArchived ? prompts : prompts.filter((p) => p.isActive !== false);
}

/** NFR-008: "/" focuses search from anywhere, except while a text field
 * already has focus, where it must type a literal "/" instead. */
const TYPING_TAGS = ["INPUT", "TEXTAREA", "SELECT"];
export function shouldFocusSearch(key: string, targetTagName: string): boolean {
  return key === "/" && !TYPING_TAGS.includes(targetTagName);
}
