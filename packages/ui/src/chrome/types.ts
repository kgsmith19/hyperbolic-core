// The structural types Chrome's public props are written against.
//
// Both are deliberate local copies rather than imports from
// @hyperbolic/platform-client, which is that shape's real owner. This package
// carries a hard 60 KB gzipped budget, and taking a workspace dependency on
// platform-client to reuse two structural types would pull
// @supabase/supabase-js's types in transitively for no runtime benefit.
//
// Keep both structurally identical to platform-client's own definitions if
// either side changes -- that drift is the cost of this decision, and it is
// flagged here rather than left silent. A type-only re-export erases at build
// time and would cost zero bytes, so this can collapse into one the moment a
// maintainer adds that dependency edge deliberately.

/** Mirrors docs/planning/05-a-hyperbolic-core.md section 6's PlatformSession
 *  shape exactly: accessToken / expiresAt / userId, no more, no less. */
export interface PlatformSession {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly userId: string;
}

/** m3-04 (05-c section 4.3; 05-a section 5): the command palette's
 *  registry-sourced tool entries. The Shell maps its own richer
 *  `RegisteredTool` rows down to this minimal shape before passing them into
 *  `Chrome`'s `tools` prop. */
export interface ToolPaletteEntry {
  id: string;
  label: string;
  href: string;
}
