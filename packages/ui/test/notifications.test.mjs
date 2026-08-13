// m2-05: the notification surface (docs/planning/05-a-hyperbolic-core.md
// section 7) and the toast presentation state machine (09 section 4.5).
//
// These import the SOURCE modules, not dist/index.cjs, unlike this
// directory's older component tests. Two reasons, both deliberate:
//   1. Both modules are plain TypeScript with no JSX, so Node 22's built-in
//      type stripping runs them directly -- no build step to go stale
//      between an edit and the test that is supposed to catch it.
//   2. Testing them through dist would force the timer/stack internals into
//      the package's PUBLIC entry just to be reachable, permanently
//      widening the API (and the 60 KB budget) for a test's convenience.
//      The public entry's own exports are smoke-checked against dist at the
//      bottom of this file instead.
//
// Node's BroadcastChannel has the same two properties the browser's does
// and that this contract depends on -- instances in the same realm deliver
// to each OTHER but never echo to the sender -- so the transport tests here
// exercise a real channel, not a mock. They are still not the cross-DOCUMENT
// proof: that one needs two real pages and lives in
// apps/shell/e2e/notifications.spec.ts.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const machine = await import("../src/notifications/toast-machine.ts");
const { createNotificationSurface, NOTIFICATION_CHANNEL } = await import(
  "../src/notifications/surface.ts"
);

const {
  TOAST_DURATION_MS,
  MAX_VISIBLE_TOASTS,
  toastDurationMs,
  autoDismisses,
  startTimer,
  startPausedTimer,
  pauseTimer,
  resumeTimer,
  elapsedAt,
  remainingMs,
  hasExpired,
  splitStack,
} = machine;

// ---------------------------------------------------------------------
// 09 section 4.5, Duration: "success/info auto-dismiss 5s; warning 8s;
// error persists until dismissed".
// ---------------------------------------------------------------------

describe("level -> duration (09 section 4.5)", () => {
  test("info and success auto-dismiss at exactly 5s", () => {
    assert.equal(toastDurationMs("info"), 5000);
    assert.equal(toastDurationMs("success"), 5000);
  });

  test("warning auto-dismisses at exactly 8s", () => {
    assert.equal(toastDurationMs("warning"), 8000);
  });

  test("error never auto-dismisses (null, not a large number)", () => {
    assert.equal(toastDurationMs("error"), null);
    assert.equal(autoDismisses("error"), false);
  });

  test("every level in the union has an entry", () => {
    assert.deepEqual(Object.keys(TOAST_DURATION_MS).sort(), [
      "error",
      "info",
      "success",
      "warning",
    ]);
  });

  test("an error timer is never expired, however long it runs", () => {
    const timer = startTimer("error", 0);
    assert.equal(remainingMs(timer, 60 * 60 * 1000), null);
    assert.equal(hasExpired(timer, 60 * 60 * 1000), false);
  });

  test("an info timer expires the instant its 5s elapse, and not before", () => {
    const timer = startTimer("info", 1000);
    assert.equal(hasExpired(timer, 5999), false);
    assert.equal(hasExpired(timer, 6000), true);
    assert.equal(remainingMs(timer, 3500), 2500);
  });
});

// ---------------------------------------------------------------------
// 09 section 4.5, Duration: "hover/focus pauses the timer".
// ---------------------------------------------------------------------

describe("timer pause/resume", () => {
  test("pausing freezes elapsed time; a paused toast never expires", () => {
    const running = startTimer("success", 0);
    const paused = pauseTimer(running, 1000);
    assert.equal(elapsedAt(paused, 999_000), 1000);
    assert.equal(hasExpired(paused, 999_000), false);
  });

  test("resuming continues from the frozen progress instead of restarting", () => {
    // 1s of running, 10s of hover, then resumed: 4s of life should remain.
    const timer = resumeTimer(pauseTimer(startTimer("info", 0), 1000), 11_000);
    assert.equal(remainingMs(timer, 11_000), 4000);
    assert.equal(hasExpired(timer, 14_999), false);
    assert.equal(hasExpired(timer, 15_000), true);
  });

  test("pause is idempotent -- a second pause does not rewind progress", () => {
    const once = pauseTimer(startTimer("info", 0), 2000);
    const twice = pauseTimer(once, 9000);
    assert.equal(elapsedAt(twice, 9000), 2000);
  });

  test("resume is idempotent -- a second resume does not restart the timer", () => {
    const running = startTimer("info", 0);
    const resumedAgain = resumeTimer(running, 3000);
    assert.equal(elapsedAt(resumedAgain, 4000), 4000);
  });

  test("a toast created while the region is hovered starts paused at zero", () => {
    const timer = startPausedTimer("info");
    assert.equal(elapsedAt(timer, 60_000), 0);
    assert.equal(hasExpired(timer, 60_000), false);
  });

  test("a backwards clock cannot extend a toast's life", () => {
    const timer = startTimer("info", 10_000);
    assert.equal(elapsedAt(timer, 9_000), 10_000 - 10_000); // clamped to 0 progress
    assert.equal(remainingMs(timer, 9_000), 5000);
  });
});

// ---------------------------------------------------------------------
// 09 section 4.5, Stack: "max 3 visible, newest on top; overflow collapses
// into the bell inbox with unread count".
// ---------------------------------------------------------------------

const ids = (list) => list.map((entry) => entry.id);

describe("stack split (09 section 4.5)", () => {
  const five = [{ id: "e" }, { id: "d" }, { id: "c" }, { id: "b" }, { id: "a" }]; // newest first

  test("the visible cap is 3", () => {
    assert.equal(MAX_VISIBLE_TOASTS, 3);
  });

  test("at most 3 are visible; the older ones collapse into the inbox", () => {
    const split = splitStack(five, () => true);
    assert.deepEqual(ids(split.visible), ["e", "d", "c"]);
    assert.deepEqual(ids(split.inbox), ["b", "a"]);
  });

  test("newest is first in the visible stack", () => {
    const split = splitStack(five, () => true);
    assert.equal(split.visible[0].id, "e");
  });

  test("an expired toast moves to the inbox and frees its slot", () => {
    const expired = new Set(["d"]);
    const split = splitStack(five, (entry) => !expired.has(entry.id));
    assert.deepEqual(ids(split.visible), ["e", "c", "b"]);
    assert.deepEqual(ids(split.inbox), ["d", "a"]);
  });

  test("visible and inbox are disjoint and together cover every entry", () => {
    const expired = new Set(["c", "a"]);
    const split = splitStack(five, (entry) => !expired.has(entry.id));
    const all = [...ids(split.visible), ...ids(split.inbox)].sort();
    assert.deepEqual(all, ["a", "b", "c", "d", "e"]);
    assert.equal(
      ids(split.visible).some((id) => ids(split.inbox).includes(id)),
      false
    );
  });

  test("the max-3 cap wins over error persistence: the 4th error collapses, it is not dropped", () => {
    // Four error-level toasts, none of which ever expires.
    const errors = [{ id: "4" }, { id: "3" }, { id: "2" }, { id: "1" }];
    const split = splitStack(errors, () => true);
    assert.equal(split.visible.length, 3);
    assert.deepEqual(ids(split.inbox), ["1"]);
  });

  test("fewer than 3 entries produces an empty inbox", () => {
    const split = splitStack([{ id: "b" }, { id: "a" }], () => true);
    assert.equal(split.visible.length, 2);
    assert.deepEqual(split.inbox, []);
  });
});

// ---------------------------------------------------------------------
// 05-a section 7: the NotificationSurface contract itself.
// ---------------------------------------------------------------------

const openSurfaces = [];
function surfaceFor(options = {}) {
  const surface = createNotificationSurface(options);
  openSurfaces.push(surface);
  return surface;
}

/** An isolated surface with no channel at all: pure in-document behaviour. */
function localSurface(options = {}) {
  return surfaceFor({ createChannel: () => null, ...options });
}

afterEach(() => {
  while (openSurfaces.length) openSurfaces.pop().close();
});

const INFO = { level: "info", title: "Import finished", source: "shell" };

describe("NotificationSurface contract (05-a section 7)", () => {
  test("publish returns a non-empty id, unique per call", () => {
    const surface = localSurface();
    const first = surface.publish(INFO);
    const second = surface.publish(INFO);
    assert.equal(typeof first, "string");
    assert.ok(first.length > 0);
    assert.notEqual(first, second);
  });

  test("publish fills in id and an ISO-8601 createdAt, preserving every given field", () => {
    const surface = localSurface({ now: () => Date.parse("2026-08-13T10:00:00.000Z") });
    const id = surface.publish({
      level: "warning",
      title: "Disk almost full",
      body: "92% used on the runner volume.",
      source: "brain",
      href: "/tools/network-checker",
    });
    const [entry] = surface.list();
    assert.deepEqual(entry, {
      id,
      level: "warning",
      title: "Disk almost full",
      body: "92% used on the runner volume.",
      source: "brain",
      href: "/tools/network-checker",
      createdAt: "2026-08-13T10:00:00.000Z",
    });
  });

  test("list() returns a copy: mutating it cannot corrupt the surface", () => {
    const surface = localSurface();
    surface.publish(INFO);
    const listed = surface.list();
    listed.length = 0;
    assert.equal(surface.list().length, 1);
  });

  test("dismiss removes exactly that notification; an unknown id is a no-op", () => {
    const surface = localSurface();
    const keep = surface.publish(INFO);
    const drop = surface.publish({ ...INFO, title: "Second" });
    surface.dismiss(drop);
    assert.deepEqual(
      surface.list().map((entry) => entry.id),
      [keep]
    );
    surface.dismiss("no-such-id");
    assert.equal(surface.list().length, 1);
  });

  test("subscribe receives the full list on every change and returns a working Unsubscribe", () => {
    const surface = localSurface();
    const seen = [];
    const unsubscribe = surface.subscribe((all) => seen.push(all.map((n) => n.title)));

    surface.publish({ ...INFO, title: "one" });
    surface.publish({ ...INFO, title: "two" });
    const id = surface.list()[0].id;
    surface.dismiss(id);

    assert.deepEqual(seen, [["one"], ["one", "two"], ["two"]]);

    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
    surface.publish({ ...INFO, title: "three" });
    assert.equal(seen.length, 3, "handler was called after unsubscribing");
  });

  test("each subscriber gets its own array", () => {
    const surface = localSurface();
    let first = null;
    let second = null;
    surface.subscribe((all) => {
      first = all;
    });
    surface.subscribe((all) => {
      second = all;
    });
    surface.publish(INFO);
    assert.notEqual(first, second);
    assert.deepEqual(first, second);
  });

  test("entries are ordered oldest-first by (createdAt, id), whatever the arrival order", () => {
    // Two documents receiving the same three notifications in DIFFERENT
    // orders must still agree on one order -- the property that keeps two
    // zones' inboxes from disagreeing.
    const stamp = "2026-08-13T10:00:00.000Z";
    const make = (id) => ({ id, level: "info", title: id, source: "shell", createdAt: stamp });
    const forward = [make("a"), make("b"), make("c")];
    const backward = [make("c"), make("b"), make("a")];

    const orderOf = (arrivals) => {
      let onmessage = null;
      const surface = surfaceFor({
        createChannel: () => ({
          postMessage() {},
          close() {},
          set onmessage(handler) {
            onmessage = handler;
          },
          get onmessage() {
            return onmessage;
          },
        }),
      });
      for (const notification of arrivals) {
        onmessage({ data: { kind: "publish", notification } });
      }
      return surface.list().map((entry) => entry.id);
    };

    assert.deepEqual(orderOf(forward), ["a", "b", "c"]);
    assert.deepEqual(orderOf(backward), ["a", "b", "c"]);
  });

  test("publishes inside ONE millisecond keep their publish order (regression)", () => {
    // The bug this locks down, found by the `subscribe` test above during
    // development: Date.now() has 1ms resolution, so a burst of publishes
    // shared a createdAt and fell through to the id tie-break -- with
    // random UUIDs, that reordered notifications published back to back.
    // Descending ids here make the failure deterministic rather than a
    // coin flip: without the strictly-increasing createdAt, this list comes
    // back exactly reversed.
    let index = 0;
    const surface = localSurface({
      now: () => Date.parse("2026-08-13T10:00:00.000Z"),
      createId: () => `id-${9 - index++}`,
    });
    for (const title of ["first", "second", "third"]) surface.publish({ ...INFO, title });

    assert.deepEqual(
      surface.list().map((entry) => entry.title),
      ["first", "second", "third"]
    );
    const stamps = surface.list().map((entry) => entry.createdAt);
    assert.deepEqual(stamps, [...new Set(stamps)], "createdAt must be strictly increasing");
  });

  test("maxEntries drops the OLDEST entries, never the newest", () => {
    const surface = localSurface({ maxEntries: 3 });
    for (const title of ["1", "2", "3", "4", "5"]) surface.publish({ ...INFO, title });
    assert.deepEqual(
      surface.list().map((entry) => entry.title),
      ["3", "4", "5"]
    );
  });
});

// ---------------------------------------------------------------------
// 05-a section 7 transport: BroadcastChannel("platform-notifications").
// ---------------------------------------------------------------------

describe("cross-zone transport over BroadcastChannel", () => {
  /**
   * Polls instead of sleeping a fixed 20ms. A fixed sleep made the FIRST
   * real-channel test in this process flaky (~1 run in 3): Node's very
   * first BroadcastChannel delivery pays a one-off initialization cost that
   * occasionally exceeded it. Timing under a bound is still asserted -- the
   * 500ms ceiling below is what fails the test if delivery never happens --
   * and the real, calibrated latency assertion for this transport is the
   * two-page one in apps/shell/e2e/notifications.spec.ts, measured in a
   * browser against a wall clock.
   */
  async function waitFor(predicate, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`condition not met within ${timeoutMs}ms`);
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  test("the channel name is the literal 05-a section 7 specifies", () => {
    assert.equal(NOTIFICATION_CHANNEL, "platform-notifications");
  });

  test("a publish in one surface reaches another surface on the same channel", async () => {
    const zoneA = surfaceFor();
    const zoneB = surfaceFor();
    const id = zoneA.publish({ level: "error", title: "Run failed", source: "brain" });
    await waitFor(() => zoneB.list().length === 1);
    const received = zoneB.list();
    assert.equal(received.length, 1);
    assert.equal(received[0].id, id, "the id must survive the transport, not be regenerated");
    assert.equal(received[0].level, "error");
    assert.equal(received[0].title, "Run failed");
  });

  test("a dismiss in one surface clears the other surface's copy", async () => {
    const zoneA = surfaceFor();
    const zoneB = surfaceFor();
    const id = zoneA.publish(INFO);
    await waitFor(() => zoneB.list().length === 1);
    zoneB.dismiss(id);
    await waitFor(() => zoneA.list().length === 0);
    assert.deepEqual(zoneA.list(), []);
    assert.deepEqual(zoneB.list(), []);
  });

  test("a received notification is applied but not re-broadcast (no ping-pong, no duplicates)", async () => {
    const zoneA = surfaceFor();
    const zoneB = surfaceFor();
    const zoneC = surfaceFor();
    zoneA.publish(INFO);
    await waitFor(() => zoneB.list().length === 1 && zoneC.list().length === 1);
    // A second settle: if anything DID re-broadcast, the duplicate would
    // have landed by now.
    await settle();
    assert.equal(zoneA.list().length, 1);
    assert.equal(zoneB.list().length, 1);
    assert.equal(zoneC.list().length, 1);
  });

  test("a subscriber in the receiving zone is notified", async () => {
    const zoneA = surfaceFor();
    const zoneB = surfaceFor();
    const seen = [];
    zoneB.subscribe((all) => seen.push(all.length));
    zoneA.publish(INFO);
    await waitFor(() => seen.length > 0);
    assert.deepEqual(seen, [1]);
  });

  test("malformed and hostile channel traffic is ignored, not stored or thrown on", async () => {
    const zoneB = surfaceFor();
    const raw = new BroadcastChannel(NOTIFICATION_CHANNEL);
    raw.unref?.();
    for (const junk of [
      null,
      "a string",
      42,
      {},
      { kind: "publish" },
      { kind: "publish", notification: { id: "x" } },
      { kind: "publish", notification: { ...INFO, id: "x", createdAt: 1, level: "info" } },
      { kind: "publish", notification: { ...INFO, id: "x", createdAt: "now", level: "critical" } },
      { kind: "publish", notification: { ...INFO, id: "x", createdAt: "now", source: "evil" } },
      { kind: "dismiss" },
      { kind: "explode" },
    ]) {
      raw.postMessage(junk);
    }
    await settle();
    assert.deepEqual(zoneB.list(), []);
    raw.close();
  });

  test("a surface with no BroadcastChannel available still works in-document", () => {
    const surface = localSurface();
    const id = surface.publish(INFO);
    assert.equal(surface.list()[0].id, id);
  });
});

// ---------------------------------------------------------------------
// The public entry actually re-exports what zones are told to import.
// ---------------------------------------------------------------------

describe("public entry (dist/index.cjs)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distEntry = path.join(here, "..", "dist", "index.cjs");

  test("getNotificationSurface / createNotificationSurface / NOTIFICATION_CHANNEL are exported", () => {
    assert.ok(
      existsSync(distEntry),
      `${distEntry} does not exist -- run \`npm run build -w packages/ui\` first.`
    );
    const ui = createRequire(import.meta.url)(distEntry);
    assert.equal(typeof ui.getNotificationSurface, "function");
    assert.equal(typeof ui.createNotificationSurface, "function");
    assert.equal(ui.NOTIFICATION_CHANNEL, "platform-notifications");
  });

  test("getNotificationSurface returns the SAME surface every call (one per document)", () => {
    const ui = createRequire(import.meta.url)(distEntry);
    const first = ui.getNotificationSurface();
    assert.equal(ui.getNotificationSurface(), first);
    for (const method of ["publish", "dismiss", "list", "subscribe"]) {
      assert.equal(typeof first[method], "function", `missing ${method}`);
    }
  });
});
