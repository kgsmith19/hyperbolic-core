// SPEC-0001: case-insensitive literal substring filter over title+body,
// title-match group first, stable within groups, input never mutated.
export function searchPrompts(prompts, query) {
  const q = query.toLowerCase();
  const titleMatches = [];
  const bodyMatches = [];
  for (const prompt of prompts) {
    if (prompt.title.toLowerCase().includes(q)) titleMatches.push(prompt);
    else if (prompt.body.toLowerCase().includes(q)) bodyMatches.push(prompt);
  }
  return titleMatches.concat(bodyMatches);
}
