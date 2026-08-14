// Bottom-anchored autoscroll (docs/planning/09-design-system.md section 6,
// "Autoscroll contract": "pinned-to-bottom while the operator is at the
// bottom; any upward scroll unpins; a 'jump to latest' affordance appears
// with the count of unseen messages"). Pure state transitions; the
// scroll-container ref wiring lives in transcript.tsx.

export interface AutoscrollState {
  readonly pinned: boolean;
  readonly unseenCount: number;
}

/** Slack for "at the bottom" -- sub-pixel scroll rounding must not read as "scrolled up". */
export const BOTTOM_THRESHOLD_PX = 24;

export function initialAutoscrollState(): AutoscrollState {
  return { pinned: true, unseenCount: 0 };
}

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Re-evaluates pin state from the scroll container's current metrics -- call on every `scroll` event. */
export function onScroll(state: AutoscrollState, metrics: ScrollMetrics): AutoscrollState {
  const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
  if (atBottom) return { pinned: true, unseenCount: 0 };
  if (!state.pinned) return state;
  return { pinned: false, unseenCount: 0 };
}

/**
 * Call when a new transcript item lands. While pinned, the caller scrolls to
 * bottom itself and this is a no-op (no unseen count to track: everything is
 * visible as it arrives). While unpinned, each call grows the unseen count
 * that the "jump to latest" affordance displays.
 */
export function onNewContent(state: AutoscrollState): AutoscrollState {
  if (state.pinned) return state;
  return { ...state, unseenCount: state.unseenCount + 1 };
}

/** The operator clicked "jump to latest" (or reduced motion made an equivalent instant jump). */
export function jumpToLatest(): AutoscrollState {
  return { pinned: true, unseenCount: 0 };
}
