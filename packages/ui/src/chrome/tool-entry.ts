// m3-04 (docs/planning/05-c-toolbelt.md section 4.3; 05-a section 5): the
// command palette's registry-sourced tool entries. Deliberately NOT
// `RegisteredTool` from @hyperbolic/platform-client -- packages/ui does not
// depend on that package (chrome/session.ts's own doc comment already
// states the reason: keeping a hard 60 KB gzipped budget free of
// @supabase/supabase-js's types pulled in transitively). The Shell maps its
// own `RegisteredTool` rows down to this minimal shape before passing them
// into `Chrome`'s `tools` prop.
export interface ToolPaletteEntry {
  id: string;
  label: string;
  href: string;
}
