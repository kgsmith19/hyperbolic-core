// docs/planning/09-design-system.md section 6: "stream events append into
// the active message; DOM writes are coalesced to at most one flush per
// animation frame regardless of event arrival rate." Only the pure
// accumulate/flush half is testable under plain node:test -- the rAF
// scheduling in useCoalescedStream needs a real browser (or a DOM test
// harness this package doesn't have), so it is exercised structurally
// nowhere yet; the accumulation logic it wraps is fully covered here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { createTokenBuffer, appendToken, flushTokenBuffer } = await import("../src/chat/stream-buffer.ts");

describe("appendToken", () => {
  test("a fresh buffer starts with no pending messages", () => {
    assert.equal(createTokenBuffer().pending.size, 0);
  });

  test("appending to a new messageId creates its entry", () => {
    const state = appendToken(createTokenBuffer(), "m1", "hello");
    assert.equal(state.pending.get("m1"), "hello");
  });

  test("repeated appends to the same messageId concatenate in order", () => {
    let state = createTokenBuffer();
    state = appendToken(state, "m1", "The ");
    state = appendToken(state, "m1", "quick ");
    state = appendToken(state, "m1", "fox");
    assert.equal(state.pending.get("m1"), "The quick fox");
  });

  test("different messageIds accumulate independently", () => {
    let state = createTokenBuffer();
    state = appendToken(state, "m1", "a");
    state = appendToken(state, "m2", "b");
    state = appendToken(state, "m1", "c");
    assert.equal(state.pending.get("m1"), "ac");
    assert.equal(state.pending.get("m2"), "b");
  });

  test("appendToken does not mutate the input state (immutable transitions)", () => {
    const before = appendToken(createTokenBuffer(), "m1", "x");
    const after = appendToken(before, "m1", "y");
    assert.equal(before.pending.get("m1"), "x", "the earlier snapshot must be unaffected by the later append");
    assert.equal(after.pending.get("m1"), "xy");
  });
});

describe("flushTokenBuffer", () => {
  test("flushing an empty buffer returns empty updates and the SAME state reference (no-op)", () => {
    const empty = createTokenBuffer();
    const { state, updates } = flushTokenBuffer(empty);
    assert.equal(updates.size, 0);
    assert.equal(state, empty);
  });

  test("flushing returns every pending message's full accumulated text in one call", () => {
    let state = createTokenBuffer();
    state = appendToken(state, "m1", "hello ");
    state = appendToken(state, "m1", "world");
    state = appendToken(state, "m2", "second message");
    const { updates } = flushTokenBuffer(state);
    assert.deepEqual(
      Object.fromEntries(updates),
      { m1: "hello world", m2: "second message" }
    );
  });

  test("flushing clears the buffer -- a second immediate flush is empty", () => {
    const state = appendToken(createTokenBuffer(), "m1", "x");
    const { state: flushed } = flushTokenBuffer(state);
    const second = flushTokenBuffer(flushed);
    assert.equal(second.updates.size, 0);
  });

  test("a full append -> flush -> append -> flush cycle never leaks text across flushes (no duplication, no loss)", () => {
    let state = createTokenBuffer();
    state = appendToken(state, "m1", "one");
    const first = flushTokenBuffer(state);
    assert.equal(first.updates.get("m1"), "one");

    let next = appendToken(first.state, "m1", "two");
    const second = flushTokenBuffer(next);
    assert.equal(second.updates.get("m1"), "two", "the second flush must not repeat 'one'");
  });
});
