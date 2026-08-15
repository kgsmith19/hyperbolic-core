/**
 * /prompts (m5-01/m5-02, docs/planning/05-d-prompt-organizer.md, ADR-01/
 * ADR-02: "the Shell absorbs... the Toolbelt tool UIs"). Only one real
 * view exists (the searchable, filterable list of expandable prompt
 * cards) -- no sub-routes, unlike /ideas/*, since Prompt Organizer's own
 * established UX (apps/toolbelt/apps/prompt-organizer/frontend/index.html) has
 * always been a single list page with in-place expansion, not a separate
 * editor route.
 */
export { default } from "./prompts/list";
