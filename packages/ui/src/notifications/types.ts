// The notification contract, transcribed VERBATIM from
// docs/planning/05-a-hyperbolic-core.md section 7 (platform contract C-4).
// Nothing here is invented: every field, every union member, and every
// method signature below matches that document character for character.
// If this file and 05-a section 7 ever disagree, 05-a wins and this file is
// the defect.
//
// `Unsubscribe` is defined locally rather than imported from
// `@hyperbolic/platform-client` (which also declares it, identically, in its
// src/types.ts) for the exact reason chrome/session.ts states for its own
// local `PlatformSession` copy: packages/ui takes no dependency on that
// package, so a hard 60 KB gzipped budget never inherits
// @supabase/supabase-js's type graph. It is a one-line structural alias;
// keep the two definitions identical if either changes.

/** docs/planning/05-a-hyperbolic-core.md section 6. */
export type Unsubscribe = () => void;

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface PlatformNotification {
  id: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  source: "shell" | "lifeos" | "acc" | "toolbelt" | "brain";
  createdAt: string; // ISO 8601
  href?: string; // same-origin deep link
}

export interface NotificationSurface {
  publish(n: Omit<PlatformNotification, "id" | "createdAt">): string; // returns id
  dismiss(id: string): void;
  list(): PlatformNotification[];
  subscribe(handler: (all: PlatformNotification[]) => void): Unsubscribe;
}

/** The input half of `publish`, named for readability at call sites. */
export type PublishableNotification = Omit<PlatformNotification, "id" | "createdAt">;
