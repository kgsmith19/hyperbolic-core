"use client";

// The React binding between a NotificationSurface (05-a section 7) and the
// toast/bell presentation (09 section 4.5). All the *decisions* live in
// toast-machine.ts; this hook only owns the wiring React forces on it --
// subscription lifecycle, one timeout at a time, and the read-tracking the
// bell's unread count needs.

import * as React from "react";

import type { NotificationLevel, NotificationSurface, PlatformNotification } from "./types";
import {
  MAX_VISIBLE_TOASTS,
  pauseTimer,
  remainingMs,
  resumeTimer,
  splitStack,
  startPausedTimer,
  startTimer,
  type ToastTimer,
} from "./toast-machine";

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export interface NotificationStack {
  /** Newest first, at most MAX_VISIBLE_TOASTS: the on-screen toast stack. */
  visible: PlatformNotification[];
  /** Newest first: everything collapsed behind the bell. */
  inbox: PlatformNotification[];
  /** Inbox entries not yet seen by the operator. */
  unreadCount: number;
  /** Removes the notification from the surface (and from every other zone). */
  dismiss: (id: string) => void;
  /** Called when the inbox is opened: marks its current entries seen. */
  markInboxSeen: () => void;
  /**
   * The pointer entered/left the toast region. Tracked separately from
   * focus, not folded into one "paused" flag: an operator can be hovering
   * the stack AND have tabbed focus inside it, and whichever of the two
   * ends first must not resume timers the other one is still holding. 09
   * section 4.5 pauses on "hover/focus", i.e. either.
   */
  setHovered: (hovered: boolean) => void;
  /** Focus entered/left the toast region. */
  setFocusWithin: (focusWithin: boolean) => void;
}

function addAll(previous: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  const next = new Set(previous);
  for (const id of ids) next.add(id);
  return next;
}

/**
 * Drives one notification surface's toast stack.
 *
 * Pausing is region-wide, not per-toast: hovering anywhere in the stack
 * freezes all three timers. Per-toast pausing looks more precise but is
 * worse in practice -- reaching for the dismiss button of the bottom toast
 * would let the one above it expire and yank the button out from under the
 * pointer. 09 section 4.5 says "hover/focus pauses the timer" without
 * choosing; this is the reading that keeps the surface usable.
 */
export function useNotificationStack(surface: NotificationSurface): NotificationStack {
  const [all, setAll] = React.useState<PlatformNotification[]>(() => surface.list());
  const [endedIds, setEndedIds] = React.useState<ReadonlySet<string>>(EMPTY_IDS);
  const [seenIds, setSeenIds] = React.useState<ReadonlySet<string>>(EMPTY_IDS);
  const [hovered, setHovered] = React.useState(false);
  const [focusWithin, setFocusWithin] = React.useState(false);
  const paused = hovered || focusWithin;
  const [tick, scheduleRecheck] = React.useReducer((n: number) => n + 1, 0);
  const timersRef = React.useRef<Map<string, ToastTimer>>(new Map());

  React.useEffect(() => {
    // Re-read on (re)subscribe: a notification could have been published in
    // the window between this component's first render and this effect.
    setAll(surface.list());
    return surface.subscribe(setAll);
  }, [surface]);

  // Pause/resume must be applied to the stored timers BEFORE the scheduling
  // effect below reads them, which is why this effect is declared first --
  // React runs effects in declaration order within a component.
  React.useEffect(() => {
    const at = Date.now();
    const timers = timersRef.current;
    for (const [id, timer] of timers) {
      timers.set(id, paused ? pauseTimer(timer, at) : resumeTimer(timer, at));
    }
  }, [paused]);

  React.useEffect(() => {
    const timers = timersRef.current;
    const at = Date.now();
    const live = new Set(all.map((entry) => entry.id));

    // Forget everything about notifications that left the surface, so a long
    // session cannot accumulate dead ids in these three structures.
    for (const id of [...timers.keys()]) {
      if (!live.has(id)) timers.delete(id);
    }
    const staleEnded = [...endedIds].some((id) => !live.has(id));
    if (staleEnded) {
      setEndedIds(new Set([...endedIds].filter((id) => live.has(id))));
      return;
    }
    const staleSeen = [...seenIds].some((id) => !live.has(id));
    if (staleSeen) {
      setSeenIds(new Set([...seenIds].filter((id) => live.has(id))));
      return;
    }

    // A notification seen for the first time starts its toast. One arriving
    // while the region is hovered starts paused rather than starting a
    // countdown the operator cannot see moving.
    for (const entry of all) {
      if (timers.has(entry.id) || endedIds.has(entry.id)) continue;
      const level: NotificationLevel = entry.level;
      timers.set(entry.id, paused ? startPausedTimer(level) : startTimer(level, at));
    }

    const expired: string[] = [];
    let soonest = Number.POSITIVE_INFINITY;
    for (const [id, timer] of timers) {
      if (endedIds.has(id)) continue;
      const remaining = remainingMs(timer, at);
      if (remaining === null) continue; // error: persists until dismissed
      if (remaining <= 0) expired.push(id);
      else if (remaining < soonest) soonest = remaining;
    }

    if (expired.length > 0) {
      setEndedIds((previous) => addAll(previous, expired));
      return;
    }
    // Nothing can expire while paused, so no timeout is armed: the region
    // simply stops having pending work until the pointer leaves.
    if (paused || !Number.isFinite(soonest)) return;

    const handle = setTimeout(scheduleRecheck, soonest);
    return () => clearTimeout(handle);
  }, [all, paused, endedIds, seenIds, tick]);

  const newestFirst = React.useMemo(() => all.slice().reverse(), [all]);
  const { visible, inbox } = React.useMemo(
    () => splitStack(newestFirst, (entry) => !endedIds.has(entry.id), MAX_VISIBLE_TOASTS),
    [newestFirst, endedIds]
  );

  const unreadCount = React.useMemo(
    () => inbox.reduce((count, entry) => (seenIds.has(entry.id) ? count : count + 1), 0),
    [inbox, seenIds]
  );

  const dismiss = React.useCallback((id: string) => surface.dismiss(id), [surface]);
  const markInboxSeen = React.useCallback(() => {
    setSeenIds((previous) => addAll(previous, inbox.map((entry) => entry.id)));
  }, [inbox]);
  // setHovered/setFocusWithin are useState setters: stable identities, so
  // they never re-render the toaster by changing.
  return { visible, inbox, unreadCount, dismiss, markInboxSeen, setHovered, setFocusWithin };
}
