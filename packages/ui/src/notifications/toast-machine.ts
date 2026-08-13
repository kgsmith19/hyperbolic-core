// The toast presentation state machine: pure functions, no React, no DOM,
// no timers of its own. Everything that decides *how long a toast lives*
// and *which entries are toasts vs. inbox rows* lives here so it can be
// unit-tested directly (packages/ui/test/notifications.test.mjs imports this
// source file) rather than only observed through a rendered component.
//
// Rules implemented, all from docs/planning/09-design-system.md section 4.5:
//   Duration | "success/info auto-dismiss 5s; warning 8s; error persists
//              until dismissed; hover/focus pauses the timer"
//   Stack    | "max 3 visible, newest on top; overflow collapses into the
//              bell inbox with unread count"

import type { NotificationLevel } from "./types";

/**
 * Level -> auto-dismiss duration in ms. `null` means "persists until
 * dismissed" -- the error row of 09 section 4.5's Duration cell. A missing
 * or wrong value here is exactly the bug class that silently drops an error
 * notification, which is why this table is data, asserted directly by the
 * unit tests, rather than a chain of `if (level === ...)` branches.
 */
export const TOAST_DURATION_MS: Readonly<Record<NotificationLevel, number | null>> = {
  info: 5_000,
  success: 5_000,
  warning: 8_000,
  error: null,
};

/** 09 section 4.5, Stack: "max 3 visible". */
export const MAX_VISIBLE_TOASTS = 3;

export function toastDurationMs(level: NotificationLevel): number | null {
  return TOAST_DURATION_MS[level];
}

/** True when this level auto-dismisses at all (error does not). */
export function autoDismisses(level: NotificationLevel): boolean {
  return toastDurationMs(level) !== null;
}

/**
 * A single toast's timer. Immutable: every transition returns a new value,
 * so a stale copy can never be mutated into a wrong state by a race between
 * a React render and a timeout callback.
 *
 * `elapsedMs` is the time this toast has already spent *running* across all
 * previous unpaused stretches; `runningSince` is the epoch-ms start of the
 * current stretch, or `null` while paused. Pause therefore does not just
 * stop a countdown, it preserves the exact progress -- resuming continues
 * from where it stopped instead of restarting the full duration.
 */
export interface ToastTimer {
  readonly level: NotificationLevel;
  readonly elapsedMs: number;
  readonly runningSince: number | null;
}

export function startTimer(level: NotificationLevel, now: number): ToastTimer {
  return { level, elapsedMs: 0, runningSince: now };
}

/** A timer created while the stack is already hovered/focused: paused at 0. */
export function startPausedTimer(level: NotificationLevel): ToastTimer {
  return { level, elapsedMs: 0, runningSince: null };
}

/** Total running time as of `now`, ignoring paused stretches. */
export function elapsedAt(timer: ToastTimer, now: number): number {
  if (timer.runningSince === null) return timer.elapsedMs;
  // Math.max guards a backwards clock (NTP step, laptop resume): a negative
  // delta would otherwise *extend* the toast's life unpredictably.
  return timer.elapsedMs + Math.max(0, now - timer.runningSince);
}

/** Idempotent: pausing an already-paused timer is a no-op, not a rewind. */
export function pauseTimer(timer: ToastTimer, now: number): ToastTimer {
  if (timer.runningSince === null) return timer;
  return { level: timer.level, elapsedMs: elapsedAt(timer, now), runningSince: null };
}

/** Idempotent: resuming an already-running timer does not restart it. */
export function resumeTimer(timer: ToastTimer, now: number): ToastTimer {
  if (timer.runningSince !== null) return timer;
  return { level: timer.level, elapsedMs: timer.elapsedMs, runningSince: now };
}

/**
 * Milliseconds left before this toast auto-dismisses, or `null` when the
 * level never auto-dismisses. Clamped at 0 (never negative), so callers can
 * feed it straight to setTimeout.
 */
export function remainingMs(timer: ToastTimer, now: number): number | null {
  const duration = toastDurationMs(timer.level);
  if (duration === null) return null;
  return Math.max(0, duration - elapsedAt(timer, now));
}

export function hasExpired(timer: ToastTimer, now: number): boolean {
  const remaining = remainingMs(timer, now);
  return remaining !== null && remaining <= 0;
}

export interface StackSplit<T> {
  /** At most MAX_VISIBLE_TOASTS, newest first. */
  visible: T[];
  /** Everything else, newest first: the bell inbox. */
  inbox: T[];
}

/**
 * Splits the surface's notifications into the visible toast stack and the
 * bell inbox.
 *
 * `newestFirst` must already be newest-first. `stillToasting(entry)` is
 * false once a toast's timer has expired (or the entry arrived from another
 * zone's inbox rather than as a live toast).
 *
 * The two output lists are disjoint and together cover every input entry: a
 * notification is in exactly ONE place at any moment -- on screen as a
 * toast, or collapsed in the inbox. That is the invariant that makes "older
 * entries collapse into the bell inbox with an unread count" (09 section
 * 4.5) countable without double-counting, and it is why an expired toast is
 * not deleted: it moves.
 *
 * Note the interaction with error-level toasts, which "persist until
 * dismissed": if a 4th notification arrives while three errors are on
 * screen, the hard "max 3 visible" cap wins and the oldest error collapses
 * into the inbox. It is NOT dropped -- persistence is honoured by keeping
 * the entry in the surface until an explicit dismiss, not by pinning it to
 * the screen forever in violation of the stack limit.
 */
export function splitStack<T extends { id: string }>(
  newestFirst: readonly T[],
  stillToasting: (entry: T) => boolean,
  max: number = MAX_VISIBLE_TOASTS
): StackSplit<T> {
  const visible: T[] = [];
  const inbox: T[] = [];
  for (const entry of newestFirst) {
    if (stillToasting(entry) && visible.length < max) {
      visible.push(entry);
    } else {
      inbox.push(entry);
    }
  }
  return { visible, inbox };
}
