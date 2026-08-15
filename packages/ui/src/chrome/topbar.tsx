"use client";

import { Search, LogOut } from "lucide-react";

import { ZONE_ENTRIES, type Zone } from "./zones";
import { ThemeSwitch } from "./theme-switch";
import type { PlatformSession } from "./types";
import { NotificationBell } from "../notifications/notification-bell";
import type { PlatformNotification } from "../notifications/types";

interface TopbarProps {
  activeZone: Zone;
  session: PlatformSession | null;
  onSignOut: () => void;
  onOpenPalette: () => void;
  /** m2-05: the bell's inbox rows, newest first (see the note below). */
  inbox: readonly PlatformNotification[];
  unreadCount: number;
  onOpenInbox: () => void;
  onDismissNotification: (id: string) => void;
}

/**
 * Topbar (09 section 4.1: top, 48px, sticky -- "never scrolls away"). Renders
 * a `<header>`, not a `<nav>`, so nav-rail.tsx's data-testid="platform-nav"
 * stays unambiguous to the single element 05-a section 7 names.
 *
 * The "notification bell with unread count" (09 section 4.1) that m2-01
 * deferred -- "the bell has no meaningful state without the
 * NotificationSurface contract (05-a section 7) that toast surface owns" --
 * is now rendered here, as of m2-05, which supplied exactly that contract.
 * Its state is computed once by Chrome (useNotificationStack) and passed
 * down, so the bell's unread count and the toast stack can never disagree
 * about which entries are on screen versus collapsed.
 *
 * "session menu (email, sign out)" (09 section 4.1) is also only partially
 * buildable as specified: PlatformSession (05-a section 6) has no `email`
 * field, only accessToken / expiresAt / userId. The session menu here shows
 * `userId` (the one identity field the given type actually carries) rather
 * than inventing JWT-decoding logic to recover an email that isn't part of
 * the contract. Also flagged in the m2-01 report as a genuine cross-section
 * spec inconsistency, not a guess on my part.
 */
function Topbar({
  activeZone,
  session,
  onSignOut,
  onOpenPalette,
  inbox,
  unreadCount,
  onOpenInbox,
  onDismissNotification,
}: TopbarProps) {
  const zoneLabel = ZONE_ENTRIES.find((entry) => entry.zone === activeZone)?.label ?? "";

  return (
    <header
      data-slot="topbar"
      className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3"
    >
      <h1 className="text-sm font-semibold text-text">{zoneLabel}</h1>

      <button
        type="button"
        data-slot="palette-trigger"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        className="ml-2 flex h-8 max-w-sm flex-1 items-center gap-2 rounded-lg border border-border-strong bg-bg-subtle px-2.5 text-sm text-text-muted outline-none transition-colors hover:text-text-secondary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="rounded border border-border bg-surface px-1 font-mono text-xs text-text-muted">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <NotificationBell
          inbox={inbox}
          unreadCount={unreadCount}
          onOpenInbox={onOpenInbox}
          onDismiss={onDismissNotification}
        />
        <ThemeSwitch />
        {session && (
          <div
            data-slot="session-menu"
            className="flex items-center gap-2 border-l border-border pl-2.5"
          >
            <span
              className="max-w-32 truncate text-xs text-text-secondary"
              title={session.userId}
            >
              {session.userId}
            </span>
            <button
              type="button"
              data-slot="sign-out-button"
              onClick={onSignOut}
              aria-label="Sign out"
              className="flex size-8 items-center justify-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-accent-muted hover:text-text focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export { Topbar };
