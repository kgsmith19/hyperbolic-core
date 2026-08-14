// docs/planning/09-design-system.md section 6, "Virtualization": "above 200
// rendered transcript items the list virtualizes (windowed rendering with
// stable measured heights)". Correctness of the windowing math, not a
// browser frame-budget measurement -- the 32ms/1,000-item ceiling in
// m4-15's acceptance criteria can only be measured in a real browser
// against a real page, which does not exist yet (page wiring is m4-16's
// scope); this file proves the range computed is correct, not fast.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { VIRTUALIZE_THRESHOLD, shouldVirtualize, buildOffsets, computeVirtualRange } = await import(
  "../src/chat/virtualize.ts"
);

describe("shouldVirtualize (09 section 6: threshold is 200)", () => {
  test("the threshold is exactly 200", () => {
    assert.equal(VIRTUALIZE_THRESHOLD, 200);
  });

  test("200 items does not virtualize (the rule is ABOVE 200)", () => {
    assert.equal(shouldVirtualize(200), false);
  });

  test("201 items virtualizes", () => {
    assert.equal(shouldVirtualize(201), true);
  });

  test("0 items does not virtualize", () => {
    assert.equal(shouldVirtualize(0), false);
  });
});

describe("buildOffsets", () => {
  test("empty heights produce a single zero offset", () => {
    assert.deepEqual(buildOffsets([]), [0]);
  });

  test("prefix sums: offsets[i] is the top of item i, last entry is total height", () => {
    assert.deepEqual(buildOffsets([10, 20, 30]), [0, 10, 30, 60]);
  });

  test("uniform heights", () => {
    const heights = Array.from({ length: 5 }, () => 40);
    assert.deepEqual(buildOffsets(heights), [0, 40, 80, 120, 160, 200]);
  });
});

describe("computeVirtualRange", () => {
  test("empty list: a well-formed zero range, not a crash", () => {
    const range = computeVirtualRange({ offsets: buildOffsets([]), scrollTop: 0, viewportHeight: 500 });
    assert.deepEqual(range, { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 });
  });

  test("totalHeight always equals the sum of every item's height, regardless of scroll position", () => {
    const heights = Array.from({ length: 50 }, (_, i) => 40 + (i % 3) * 10);
    const offsets = buildOffsets(heights);
    const total = heights.reduce((a, b) => a + b, 0);
    for (const scrollTop of [0, 500, 1200, total]) {
      const range = computeVirtualRange({ offsets, scrollTop, viewportHeight: 400 });
      assert.equal(range.totalHeight, total);
    }
  });

  test("at scrollTop 0, the window starts at index 0", () => {
    const offsets = buildOffsets(Array.from({ length: 500 }, () => 50));
    const range = computeVirtualRange({ offsets, scrollTop: 0, viewportHeight: 500, overscan: 0 });
    assert.equal(range.startIndex, 0);
    assert.equal(range.offsetTop, 0);
  });

  test("the rendered window covers every item whose bounds intersect the viewport, with no overscan", () => {
    // 20 items x 50px = 0..1000. Viewport [200, 500) (scrollTop 200, height 300).
    const offsets = buildOffsets(Array.from({ length: 20 }, () => 50));
    const range = computeVirtualRange({ offsets, scrollTop: 200, viewportHeight: 300, overscan: 0 });
    // Item 4 spans [200,250) -- exactly at the top edge; item 9 spans [450,500) -- exactly at the bottom edge.
    assert.equal(range.startIndex, 4);
    assert.equal(range.endIndex, 10); // exclusive, so item 9 is the last included
    assert.equal(range.offsetTop, offsets[4]);
  });

  test("overscan extends the window on both edges, clamped to the list bounds", () => {
    const offsets = buildOffsets(Array.from({ length: 20 }, () => 50));
    const range = computeVirtualRange({ offsets, scrollTop: 200, viewportHeight: 300, overscan: 3 });
    assert.equal(range.startIndex, 1); // 4 - 3
    assert.equal(range.endIndex, 13); // 10 + 3
  });

  test("overscan does not push startIndex below 0 or endIndex above itemCount", () => {
    const offsets = buildOffsets(Array.from({ length: 5 }, () => 50));
    const range = computeVirtualRange({ offsets, scrollTop: 0, viewportHeight: 1000, overscan: 100 });
    assert.equal(range.startIndex, 0);
    assert.equal(range.endIndex, 5);
  });

  test("scrolled to the very bottom, the window includes the last item", () => {
    const heights = Array.from({ length: 300 }, () => 40);
    const offsets = buildOffsets(heights);
    const total = offsets[offsets.length - 1];
    const range = computeVirtualRange({ offsets, scrollTop: total - 200, viewportHeight: 200, overscan: 0 });
    assert.equal(range.endIndex, 300);
  });

  test("variable (non-uniform) heights are handled correctly, not assumed uniform", () => {
    // Items: [0,10), [10,110) <- one tall item, [110,120), [120,130) ...
    const heights = [10, 100, 10, 10, 10, 10];
    const offsets = buildOffsets(heights);
    assert.deepEqual(offsets, [0, 10, 110, 120, 130, 140, 150]);
    // Viewport [50, 90) sits entirely inside the tall item (index 1).
    const range = computeVirtualRange({ offsets, scrollTop: 50, viewportHeight: 40, overscan: 0 });
    assert.equal(range.startIndex, 1);
    assert.equal(range.endIndex, 2);
  });

  test("at least 200 items with variable heights still produces a correct, bounded window (no O(n) leakage into the render set)", () => {
    const heights = Array.from({ length: 1000 }, (_, i) => 40 + (i % 5) * 8);
    const offsets = buildOffsets(heights);
    const range = computeVirtualRange({ offsets, scrollTop: offsets[500], viewportHeight: 600, overscan: 5 });
    const windowSize = range.endIndex - range.startIndex;
    // A 600px viewport over ~40-72px items is roughly 10-15 items; with
    // overscan 5 on each edge that is comfortably under a few dozen --
    // nowhere near all 1000, which is the whole point of virtualizing.
    assert.ok(windowSize < 40, `expected a small window, got ${windowSize} items`);
    assert.ok(range.startIndex <= 500 && range.endIndex > 500, "the window must contain the scrolled-to item");
  });
});
