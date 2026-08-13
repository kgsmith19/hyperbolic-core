"use client";

import * as React from "react";
import { Bell, X } from "lucide-react";

import { cn } from "../lib/cn";
import { EmptyState } from "../feedback/empty-state";
import type { PlatformNotification } from "./types";
import { LEVEL_PRESENTATION } from "./toast-stack";

const INBOX_ID = "platform-notification-inbox";

export interface NotificationBellProps {
  /** Newest first: everything not currently on screen as a toast. */
  inbox: readonly PlatformNotification[];
  unreadCount: number;
  /** Called when the inbox opens, so its entries stop counting as unread. */
  onOpenInbox: () => void;
  onDismiss: (id: string) => void;
}

/**
 * The topbar's "notification bell with unread count" (09 section 4.1) and
 * the inbox that older toasts collapse into (section 4.5's Stack row).
 * topbar.tsx deferred this to m2-05 explicitly ("the bell has no meaningful
 * state without the NotificationSurface contract that toast surface owns");
 * this is that bell.
 *
 * Deliberately a hand-rolled disclosure rather than a Base UI Popover: the
 * only behaviours a popover primitive would add here that this does not
 * already implement (aria-expanded/aria-controls wiring, Escape-to-close
 * with focus return, outside-pointerdown-to-close) are the three below, and
 * packages/ui has ~11 KB of gzipped headroom left against a hard 60 KB
 * budget (09 section 6) that a whole new primitive family would eat into
 * for no behavioural gain. It is NOT a modal: it traps no focus and blocks
 * nothing, matching 09 section 4.5's "toasts never steal focus" posture for
 * the surface as a whole.
 */
function NotificationBell({ inbox, unreadCount, onOpenInbox, onDismiss }: NotificationBellProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open || typeof document === "undefined") return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // 09 section 4.3, Focus conventions: Escape "closes and returns focus
      // to the invoking element".
      buttonRef.current?.focus();
    }
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  function toggle() {
    setOpen((current) => {
      if (!current) onOpenInbox();
      return !current;
    });
  }

  return (
    <div ref={rootRef} data-slot="notification-bell-root" className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-slot="notification-bell"
        data-testid="notification-bell"
        data-unread-count={unreadCount}
        aria-label={
          unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications, none unread"
        }
        aria-expanded={open}
        aria-controls={INBOX_ID}
        onClick={toggle}
        className="relative flex size-8 items-center justify-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-accent-muted hover:text-text focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Bell className="size-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            data-slot="notification-unread-count"
            data-testid="notification-unread-count"
            aria-hidden="true"
            // bg-accent/text-accent-fg, not a level colour: that pair is
            // contrast-gated in both themes (contrast.test.mjs), whereas
            // "count text on --color-danger" is not a pairing this token set
            // has ever measured -- and inventing one here is exactly what
            // m1-03's gate exists to prevent. A neutral badge also avoids
            // implying a severity the count itself does not carry.
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-medium text-accent-fg"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          id={INBOX_ID}
          data-slot="notification-inbox"
          data-testid="notification-inbox"
          className="absolute top-9 right-0 z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-surface-raised shadow-2"
        >
          <p className="border-b border-border px-3 py-2 text-sm font-semibold text-text">
            Notifications
          </p>
          {inbox.length === 0 ? (
            <EmptyState
              // Reuses the m1-04 primitive rather than a second, private
              // empty state (09 section 4.4: bare "No data" text is a
              // defect); the className only trims the full-page padding and
              // dashed frame down to popover scale.
              className="gap-2 rounded-none border-0 px-4 py-6"
              icon={<Bell aria-hidden="true" />}
              title="Notifications from the Shell, zones, and runs appear here."
            />
          ) : (
            <ul data-slot="notification-inbox-list" className="max-h-80 overflow-y-auto">
              {inbox.map((notification) => {
                const { chip, icon: Icon, srLabel } = LEVEL_PRESENTATION[notification.level];
                return (
                  <li
                    key={notification.id}
                    data-slot="notification-inbox-item"
                    data-testid="notification-inbox-item"
                    data-level={notification.level}
                    className="flex items-start gap-2.5 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                        chip
                      )}
                    >
                      <Icon className="size-3" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text">
                        <span className="sr-only">{srLabel}: </span>
                        {notification.title}
                      </p>
                      {notification.body && (
                        <p className="line-clamp-2 text-sm text-text-secondary">
                          {notification.body}
                        </p>
                      )}
                      {notification.href && (
                        <a
                          href={notification.href}
                          className="text-sm font-medium text-text underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          View details
                        </a>
                      )}
                    </div>
                    <button
                      type="button"
                      data-slot="notification-inbox-dismiss"
                      aria-label={`Dismiss notification: ${notification.title}`}
                      onClick={() => onDismiss(notification.id)}
                      className="-m-1 flex size-6 shrink-0 items-center justify-center rounded-md text-text-secondary outline-none transition-colors hover:bg-accent-muted hover:text-text focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export { NotificationBell };
