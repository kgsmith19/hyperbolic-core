// Mirrors docs/planning/05-a-hyperbolic-core.md section 6's PlatformSession
// shape exactly (accessToken / expiresAt / userId -- no more, no less).
//
// `packages/platform-client` (m1-02) is that type's real, binding owner and
// already ships the identical shape (see its src/types.ts). This is a
// deliberate, temporary local copy rather than a cross-package type import,
// so this issue (m2-01, scoped packages/ui-only per its own text) doesn't
// need to add a new workspace dependency edge -- and, more importantly,
// doesn't need to pull @supabase/supabase-js's types transitively into a
// package with a hard 60 KB gzipped budget just for one structural type.
// Should become a re-export of platform-client's own PlatformSession
// (a type-only import erases at build time, so it would cost zero bytes)
// once a maintainer is ready to add that dependency edge deliberately,
// not as a side effect of this issue. Flagged here, not silently left to
// drift: keep both definitions structurally identical if either changes.
export interface PlatformSession {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly userId: string;
}
