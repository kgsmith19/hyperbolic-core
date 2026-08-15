// 05-d-prompt-organizer.md section 5: "system prompts use namespace paths in
// `title`, grammar `^[a-z0-9-]+(/[a-z0-9-]+){1,2}$`... a namespaced prompt's
// name is its API. Renaming a prompt that consumers pin breaks them
// silently, so the UI refuses title edits on namespaced prompts... legacy
// personal titles remain valid and simply live outside the namespace
// grammar." This is the one predicate both the editor (m5-02's rename
// refusal) and its tests need, so it is a named, independently-testable
// function rather than an inline regex at each call site.
const NAMESPACE_RE = /^[a-z0-9-]+(\/[a-z0-9-]+){1,2}$/;

export function isNamespacedTitle(title: string): boolean {
  return NAMESPACE_RE.test(title);
}
