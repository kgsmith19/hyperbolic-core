"use client";

import * as React from "react";
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from "lucide-react";

import { cn } from "../lib/cn";
import type { NotificationLevel, PlatformNotification } from "./types";

/**
 * Level -> semantic tokens, 09 section 4.5 ("Levels: info, success,
 * warning, error mapped to the Section 3 semantic tokens").
 *
 * Full class strings, never composed at runtime: Tailwind resolves classes
 * by static text scan (`@source "../src"` in styles/tokens.css), so a
 * template-built `text-${level}` would generate no CSS at all.
 *
 * Each `chip` pairing is one of the pairs packages/ui/test/contrast.test.mjs
 * already gates at 4.5:1 in BOTH themes (`--color-<semantic>` on
 * `--color-<semantic>-bg`); no new pairing -- and therefore no new colour --
 * is introduced by this component. `srLabel` is what a screen reader hears
 * in place of the icon, so level survives for a non-visual operator.
 */
const LEVEL_PRESENTATION: Readonly<
  Record<NotificationLevel, { chip: string; icon: React.ElementType; srLabel: string }>
> = {
  info: { chip: "bg-info-bg text-info", icon: Info, srLabel: "Information" },
  success: { chip: "bg-success-bg text-success", icon: CheckCircle2, srLabel: "Success" },
  warning: { chip: "bg-warn-bg text-warn", icon: AlertTriangle, srLabel: "Warning" },
  error: { chip: "bg-danger-bg text-danger", icon: AlertCircle, srLabel: "Error" },
};

interface ToastProps {
  notification: PlatformNotification;
  onDismiss: (id: string) => void;
}

/**
 * One toast (09 section 4.5, Anatomy: "level icon + title (required) + body
 * (optional, 2-line clamp) + optional same-origin link + dismiss").
 *
 * Surface is `--color-surface-raised` per the section 3.2 table's own role
 * text ("popovers, palette, toasts"). Body copy uses
 * `--color-text-secondary`, NOT `--color-text-muted`: contrast.test.mjs's
 * header states muted-on-surface-raised is one of the pairs deliberately
 * left outside the automated gate (it measures 4.339:1 in light theme), so
 * a toast must not use it.
 */
function Toast({ notification, onDismiss }: ToastProps) {
  const { chip, icon: Icon, srLabel } = LEVEL_PRESENTATION[notification.level];

  return (
    <div
      data-slot="toast"
      data-testid="toast"
      data-level={notification.level}
      data-notification-id={notification.id}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border border-border bg-surface-raised p-3 shadow-2",
        // 09 section 3.4: --duration-base is the "toast enter" duration.
        // @starting-style does the enter with zero JavaScript, so nothing
        // here can delay the toast's actual insertion into the DOM.
        "transition-[opacity,translate] duration-base ease-standard",
        "starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none"
      )}
    >
      <span
        data-slot="toast-icon"
        className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", chip)}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text">
          <span className="sr-only">{srLabel}: </span>
          {notification.title}
        </p>
        {notification.body && (
          <p data-slot="toast-body" className="mt-0.5 line-clamp-2 text-sm text-text-secondary">
            {notification.body}
          </p>
        )}
        {notification.href && (
          <a
            data-slot="toast-link"
            href={notification.href}
            className="mt-1 inline-block rounded text-sm font-medium text-text underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            View details
          </a>
        )}
      </div>
      <button
        type="button"
        data-slot="toast-dismiss"
        aria-label={`Dismiss notification: ${notification.title}`}
        onClick={() => onDismiss(notification.id)}
        className="-m-1 flex size-6 shrink-0 items-center justify-center rounded-md text-text-secondary outline-none transition-colors hover:bg-accent-muted hover:text-text focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export interface NotificationToasterProps {
  /** Newest first; the caller has already applied the max-3 stack limit. */
  entries: readonly PlatformNotification[];
  onDismiss: (id: string) => void;
  /** Pointer entered (true) or left (false) the whole stack. */
  onHoverChange: (hovered: boolean) => void;
  /** Focus entered (true) or left (false) the whole stack. */
  onFocusWithinChange: (focusWithin: boolean) => void;
}

/**
 * The toast stack: bottom-right overlay, newest on top (09 section 4.1's
 * region table and section 4.5's Stack row).
 *
 * Interruption budget (09 section 4.5): this component NEVER calls focus().
 * Toasts appear, are announced by the live region, and leave the operator's
 * focus exactly where it was -- the dismiss button is reachable by Tab (it
 * is last in DOM order, after all page content) but is never focused for
 * them.
 *
 * The container is rendered unconditionally, even with zero toasts. That is
 * required, not incidental: assistive technology only announces changes
 * inside a live region that already existed when the change happened, so a
 * region mounted at the same moment as its first toast may announce
 * nothing. `pointer-events-none` on the empty container keeps the fixed
 * overlay from swallowing clicks on the page beneath it.
 */
function NotificationToaster({
  entries,
  onDismiss,
  onHoverChange,
  onFocusWithinChange,
}: NotificationToasterProps) {
  return (
    <div
      data-slot="toast-region"
      data-testid="toast-region"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      onFocusCapture={() => onFocusWithinChange(true)}
      onBlurCapture={(event) => {
        // Tabbing from one toast's dismiss button to the next one's fires a
        // blur before the focus: without this relatedTarget check, focus
        // moving WITHIN the stack would briefly un-pause it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onFocusWithinChange(false);
        }
      }}
    >
      {entries.map((notification) => (
        <Toast key={notification.id} notification={notification} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export { NotificationToaster, LEVEL_PRESENTATION };
