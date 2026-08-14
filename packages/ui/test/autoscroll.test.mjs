// docs/planning/09-design-system.md section 6, "Autoscroll contract":
// "pinned-to-bottom while the operator is at the bottom; any upward scroll
// unpins; a 'jump to latest' affordance appears with the count of unseen
// messages."

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { initialAutoscrollState, onScroll, onNewContent, jumpToLatest, BOTTOM_THRESHOLD_PX } = await import(
  "../src/chat/autoscroll.ts"
);

describe("initialAutoscrollState", () => {
  test("starts pinned with zero unseen messages", () => {
    assert.deepEqual(initialAutoscrollState(), { pinned: true, unseenCount: 0 });
  });
});

describe("onScroll", () => {
  const atBottom = { scrollTop: 976, scrollHeight: 1000, clientHeight: 24 }; // distance 0
  const scrolledUp = { scrollTop: 200, scrollHeight: 1000, clientHeight: 24 }; // distance 776

  test("scrolling to exactly the bottom pins", () => {
    const state = onScroll({ pinned: false, unseenCount: 3 }, atBottom);
    assert.equal(state.pinned, true);
  });

  test("reaching bottom clears the unseen count", () => {
    const state = onScroll({ pinned: false, unseenCount: 5 }, atBottom);
    assert.equal(state.unseenCount, 0);
  });

  test("scrolling up unpins", () => {
    const state = onScroll(initialAutoscrollState(), scrolledUp);
    assert.equal(state.pinned, false);
  });

  test("within the bottom threshold still counts as pinned", () => {
    const nearBottom = { scrollTop: 1000 - 24 - BOTTOM_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 24 };
    const state = onScroll(initialAutoscrollState(), nearBottom);
    assert.equal(state.pinned, true);
  });

  test("just past the bottom threshold unpins", () => {
    const justPast = { scrollTop: 1000 - 24 - BOTTOM_THRESHOLD_PX - 1, scrollHeight: 1000, clientHeight: 24 };
    const state = onScroll(initialAutoscrollState(), justPast);
    assert.equal(state.pinned, false);
  });

  test("scrolling while already unpinned and still not at bottom does not reset the unseen count", () => {
    const state = onScroll({ pinned: false, unseenCount: 7 }, scrolledUp);
    assert.equal(state.unseenCount, 7);
  });

  test("scrolling while pinned and still at bottom is a stable no-op", () => {
    const state = onScroll(initialAutoscrollState(), atBottom);
    assert.deepEqual(state, initialAutoscrollState());
  });
});

describe("onNewContent", () => {
  test("while pinned, new content is a no-op -- the caller scrolls to bottom itself", () => {
    const pinned = initialAutoscrollState();
    assert.deepEqual(onNewContent(pinned), pinned);
  });

  test("while unpinned, each call increments the unseen count by one", () => {
    let state = { pinned: false, unseenCount: 0 };
    state = onNewContent(state);
    state = onNewContent(state);
    state = onNewContent(state);
    assert.equal(state.unseenCount, 3);
  });

  test("unpinned state is preserved across new-content calls", () => {
    const state = onNewContent({ pinned: false, unseenCount: 0 });
    assert.equal(state.pinned, false);
  });
});

describe("jumpToLatest", () => {
  test("re-pins and clears the unseen count regardless of prior state", () => {
    assert.deepEqual(jumpToLatest(), { pinned: true, unseenCount: 0 });
  });
});

describe("a full scroll-away / stream / return cycle", () => {
  test("scroll up, accumulate unseen, jump to latest, then re-pins with zero unseen", () => {
    let state = initialAutoscrollState();
    state = onScroll(state, { scrollTop: 0, scrollHeight: 5000, clientHeight: 500 }); // scrolled far from bottom
    assert.equal(state.pinned, false);

    for (let i = 0; i < 4; i++) state = onNewContent(state);
    assert.equal(state.unseenCount, 4);

    state = jumpToLatest();
    assert.deepEqual(state, { pinned: true, unseenCount: 0 });
  });
});
