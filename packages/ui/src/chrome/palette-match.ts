// Command palette matching (docs/planning/09-design-system.md section 4.2):
// "case-insensitive substring plus initials match ('nc' hits Network
// Checker); no fuzzy-ranking dependency." No fuzzy-search library is added
// (that "no fuzzy-ranking dependency" line is read as binding, not just
// descriptive) -- this is the whole algorithm.
//
// Exported publicly (not folded as an unexported helper inside
// command-palette.tsx) so m3-04's registry-sourced tool entries match with
// exactly the same semantics as the six static zone entries here, rather
// than growing a second, slightly different matcher later.

function initials(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .toLowerCase();
}

export function paletteMatch(label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return label.toLowerCase().includes(q) || initials(label).includes(q);
}
