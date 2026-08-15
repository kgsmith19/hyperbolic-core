"use client";

import * as React from "react";

import { NavRail } from "./nav-rail";
import { Topbar } from "./topbar";
import { CommandPalette } from "./command-palette";
import { ShortcutsOverlay } from "./shortcuts-overlay";
import { useGlobalKeyboardModel } from "./keyboard";
import { ZONE_ENTRIES, type NavigateAdapter, type Zone } from "./zones";
import type { PlatformSession, ToolPaletteEntry } from "./types";
import { NotificationToaster } from "../notifications/toast-stack";
import { useNotificationStack } from "../notifications/use-notification-stack";
import { getNotificationSurface } from "../notifications/surface";
import type { NotificationSurface } from "../notifications/types";

/**
 * docs/planning/05-a-hyperbolic-core.md section 7 gives this as a signature
 * only, exactly three fields: activeZone, session, onSignOut. `children` is
 * added here, not part of that signature -- flagged as an inferred
 * addition, not a silent contract change: 09 section 4.1 requires a
 * "Content" region ("remainder | zone/page content | pages own their
 * internal layout"), and a layout-shell component structurally cannot host
 * that region without a children slot. Every other field matches 05-a
 * section 7 verbatim.
 *
 * `tools` is m3-04's addition (05-a section 5, command-palette.tsx's own
 * pre-written extension-point comment): the command palette's registry-
 * sourced entries, fed in by the Shell (the only zone that owns a registry
 * client) rather than fetched by packages/ui itself -- this package has no
 * dependency on @hyperbolic/platform-client (chrome/types.ts's own doc
 * comment states why) and no HTTP/Supabase awareness at all. Optional and
 * defaults to empty, so every pre-m3-04 caller keeps compiling unchanged.
 *
 * `notifications` is m2-05's addition, following the same pattern: the one
 * NotificationSurface (05-a section 7, contract C-4) whose toasts and bell
 * inbox this chrome renders. Optional, defaulting to the per-document
 * singleton -- which is what makes C-4's "no zone renders its own toast
 * stack for platform-level events" true by construction: a zone that
 * renders Chrome and nothing else already has the platform's one toast
 * surface, and a zone publishing through `getNotificationSurface()` reaches
 * that same instance with no prop threading. Passing an explicit surface is
 * for tests and for a document that genuinely needs an isolated one.
 *
 * `navigate` is Finding #70's addition (PR #8 security review): NavRail and
 * CommandPalette previously rendered every ZONE_ENTRIES item -- five
 * genuinely internal Shell routes alongside `life`, the one real cross-zone
 * entry -- as a plain `<a href>`, forcing a full document reload on every
 * click regardless of which zone was clicked. This optional adapter lets a
 * consumer that DOES own a router (apps/shell, via react-router's
 * `useNavigate()`) hand Chrome a `(href) => void` callback; internal-route
 * clicks then call it instead of following the native anchor. Left
 * undefined by default -- this package still has no router of its own to
 * assume or depend on (see the `hardNavigateToZone` callback below, which
 * covers the ONE navigation Chrome performs on its own, the g-chord, and is
 * unaffected by this prop) -- so every existing caller that doesn't wire a
 * navigator keeps today's plain-anchor behavior unchanged. `hardNavigate`
 * entries (currently just `life`) always hard-navigate regardless of what's
 * wired here; see zones.ts's `shouldNavigateClientSide`.
 */
export interface ChromeProps {
  activeZone: Zone;
  session: PlatformSession | null;
  onSignOut: () => void;
  tools?: readonly ToolPaletteEntry[];
  notifications?: NotificationSurface;
  navigate?: NavigateAdapter;
  children?: React.ReactNode;
}

type OverlayState = "none" | "palette" | "shortcuts";

/**
 * The one nav chrome every zone renders (05-a section 3's ownership table;
 * contract C-3, section 9). ADR-02's reversal trigger is exactly two zones
 * visibly drifting despite a shared component existing -- this is that
 * component. Composes the nav rail + topbar (09 section 4.1), the
 * navigation-only command palette (section 4.2), and the subset of the
 * global keyboard model (section 4.3) Chrome owns: Ctrl/Cmd+K, the g-chord,
 * and Shift+/. As of m2-05 it also renders the platform notification
 * surface: the bottom-right toast stack (section 4.1's region table) and
 * the topbar bell inbox those toasts collapse into. The chat surface
 * (m4-15) remains out of scope.
 *
 * `overlay` is a single tri-state value, not two independent booleans, so
 * the palette and the shortcuts reference can never both be open at once --
 * that would fight over Base UI's modal focus trap and Escape handling.
 */
function Chrome({
  activeZone,
  session,
  onSignOut,
  tools,
  notifications,
  navigate,
  children,
}: ChromeProps) {
  const [overlay, setOverlay] = React.useState<OverlayState>("none");

  // Resolved once per mount, not per render: getNotificationSurface() is a
  // lazily-created singleton, and re-resolving it every render would be
  // harmless but pointless. useState's initializer form also means the
  // singleton (and therefore its BroadcastChannel) is still not created at
  // import time -- only when a chrome actually mounts.
  const [fallbackSurface] = React.useState(getNotificationSurface);
  const surface = notifications ?? fallbackSurface;
  const stack = useNotificationStack(surface);

  const openPalette = React.useCallback(() => setOverlay("palette"), []);
  const openShortcuts = React.useCallback(() => setOverlay("shortcuts"), []);

  // The g-chord's own navigation, kept as an always-hard-navigate callback
  // distinct from the `navigate` PROP above (Finding #70's client-side
  // adapter) -- deliberately out of that finding's scope, which named only
  // nav-rail.tsx and command-palette.tsx's anchor-click behavior, not this
  // keyboard shortcut. Renamed from the prior `navigate` to avoid shadowing
  // the new prop of the same conceptual name but a different signature
  // (Zone here vs. href for the prop).
  const hardNavigateToZone = React.useCallback((zone: Zone) => {
    // 05-a section 4 / ADR-02: cross-zone navigation is a full document
    // load, not client-side routing -- there is no router for Chrome (a
    // packages/ui component with no apps/shell yet) to assume or depend on.
    const entry = ZONE_ENTRIES.find((candidate) => candidate.zone === zone);
    if (entry && typeof window !== "undefined") {
      window.location.assign(entry.href);
    }
  }, []);

  useGlobalKeyboardModel({
    onOpenPalette: openPalette,
    onOpenShortcuts: openShortcuts,
    onNavigate: hardNavigateToZone,
  });

  return (
    <div data-slot="chrome" className="flex min-h-dvh bg-bg text-text">
      {/* 09 section 4.3, Focus conventions: "a skip link is the first tab
          stop in the chrome." Must be the first focusable element in the
          tree below, hence its position as Chrome's very first child. */}
      <a
        href="#chrome-content"
        data-slot="skip-link"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-lg focus-visible:border-ring focus-visible:bg-surface-raised focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-text focus-visible:shadow-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Skip to content
      </a>
      <NavRail activeZone={activeZone} navigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          activeZone={activeZone}
          session={session}
          onSignOut={onSignOut}
          onOpenPalette={openPalette}
          inbox={stack.inbox}
          unreadCount={stack.unreadCount}
          onOpenInbox={stack.markInboxSeen}
          onDismissNotification={stack.dismiss}
        />
        <main id="chrome-content" data-slot="chrome-content" tabIndex={-1} className="min-w-0 flex-1">
          {children}
        </main>
      </div>
      <CommandPalette
        open={overlay === "palette"}
        onOpenChange={(open) => setOverlay(open ? "palette" : "none")}
        activeZone={activeZone}
        tools={tools}
        navigate={navigate}
      />
      <ShortcutsOverlay
        open={overlay === "shortcuts"}
        onOpenChange={(open) => setOverlay(open ? "shortcuts" : "none")}
      />
      {/* Last child of the chrome, deliberately: the toast region's dismiss
          buttons are then the LAST tab stops on the page rather than
          interleaving themselves into the page's own focus order, which is
          the DOM-order half of 09 section 4.5's "toasts never steal
          focus". */}
      <NotificationToaster
        entries={stack.visible}
        onDismiss={stack.dismiss}
        onHoverChange={stack.setHovered}
        onFocusWithinChange={stack.setFocusWithin}
      />
    </div>
  );
}

export { Chrome };
