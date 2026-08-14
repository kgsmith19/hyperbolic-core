// Windowed-rendering math for the transcript (docs/planning/09-design-
// system.md section 6, "Virtualization": "above 200 rendered transcript
// items the list virtualizes (windowed rendering with stable measured
// heights)"). Pure functions: no React, no DOM, so the windowing math is
// directly unit-testable without a real scroll container. Frame-budget
// PERFORMANCE at 1,000 items (the 32ms ceiling in the issue's acceptance
// criteria) can only be measured in a real browser against a real page --
// this module only proves the range it computes is correct, not how fast a
// real render of that range takes.

/** 09 section 6: "above 200 rendered transcript items the list virtualizes". */
export const VIRTUALIZE_THRESHOLD = 200;

export function shouldVirtualize(itemCount: number): boolean {
  return itemCount > VIRTUALIZE_THRESHOLD;
}

/**
 * Prefix sums of per-item heights: `offsets[i]` is the top offset of item
 * `i`; `offsets[heights.length]` is the total content height. Length is
 * always `heights.length + 1`. Building this is the caller's O(n) cost to
 * pay once per height change (memoized in the component with `useMemo`),
 * not on every scroll event.
 */
export function buildOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  let total = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i] = total;
    total += heights[i];
  }
  offsets[heights.length] = total;
  return offsets;
}

/**
 * Binary search for the item index covering `target`: the largest `i` such
 * that `offsets[i] <= target`, clamped to a valid item index. `offsets` must
 * be a `buildOffsets` result (monotonically non-decreasing, length
 * itemCount + 1). Used for the viewport's top (inclusive) edge: an item
 * that starts exactly at `scrollTop` is visible.
 */
function indexAtOffset(offsets: readonly number[], target: number): number {
  const itemCount = offsets.length - 1;
  if (itemCount <= 0) return 0;
  let lo = 0;
  let hi = itemCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Binary search for the largest `i` such that `offsets[i] < target`
 * (strictly less). Used for the viewport's bottom (exclusive) edge: an item
 * that starts exactly at `scrollTop + viewportHeight` has zero pixels
 * inside the half-open viewport and must NOT count as visible -- using
 * `indexAtOffset` here would off-by-one include it whenever a scroll
 * position happens to land exactly on an item boundary.
 */
function indexBeforeOffset(offsets: readonly number[], target: number): number {
  const itemCount = offsets.length - 1;
  if (itemCount <= 0) return 0;
  let lo = 0;
  let hi = itemCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] < target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface VirtualRangeInput {
  readonly offsets: readonly number[];
  readonly scrollTop: number;
  readonly viewportHeight: number;
  /** Extra items rendered beyond the visible edges, to absorb fast scroll/keyboard nav before a frame lands. */
  readonly overscan?: number;
}

export interface VirtualRange {
  /** First rendered item index, inclusive. */
  readonly startIndex: number;
  /** Last rendered item index, exclusive. */
  readonly endIndex: number;
  /** Top offset (px) of `startIndex`, i.e. `offsets[startIndex]` -- position the rendered window's spacer at this value. */
  readonly offsetTop: number;
  /** Full (unwindowed) content height, for the scroll container's spacer/sizing element. */
  readonly totalHeight: number;
}

const DEFAULT_OVERSCAN = 5;

export function computeVirtualRange({
  offsets,
  scrollTop,
  viewportHeight,
  overscan = DEFAULT_OVERSCAN,
}: VirtualRangeInput): VirtualRange {
  const itemCount = offsets.length - 1;
  const totalHeight = itemCount > 0 ? offsets[itemCount] : 0;
  if (itemCount === 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 };
  }

  const firstVisible = indexAtOffset(offsets, scrollTop);
  const lastVisible = indexBeforeOffset(offsets, scrollTop + viewportHeight);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(itemCount, lastVisible + 1 + overscan);
  return { startIndex, endIndex, offsetTop: offsets[startIndex], totalHeight };
}
