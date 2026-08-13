// Finding #73 (PR #8 security review): useThemeChoice was plain
// per-component React.useState with no cross-instance channel -- two
// independently mounted consumers (e.g. the topbar's ThemeSwitch and
// Settings' own ThemeChoiceControl) could show stale/disagreeing DISPLAYED
// selections relative to each other until one of them remounted. The fix
// promotes the choice to a module-level store (getThemeChoiceSnapshot /
// setThemeChoiceSnapshot / subscribeThemeChoice) that every useThemeChoice()
// instance reads and subscribes to via React's useSyncExternalStore.
//
// This imports src/chrome/theme.ts directly (not dist/index.cjs), matching
// test/notifications.test.mjs's established precedent: the store primitives
// are plain TypeScript with no JSX and are NOT re-exported through
// packages/ui's public entry (src/index.ts exports only useThemeChoice,
// applyThemeChoice, and the ThemeChoice type from this module).
//
// This file proves the STORE mechanism itself -- the actual cross-React-
// instance behavioral proof (two real rendered components staying in sync)
// needs a DOM this package's test suite deliberately doesn't carry (see
// chrome.test.mjs's own header comment on that scope boundary); that half
// lives in apps/shell's jsdom-backed component tests instead.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const themeModule = await import("../src/chrome/theme.ts");
const {
  getThemeChoiceSnapshot,
  getThemeChoiceServerSnapshot,
  subscribeThemeChoice,
  setThemeChoiceSnapshot,
} = themeModule;

// This module's store is genuinely module-scoped (one instance for the
// lifetime of this test file's single `import` of theme.ts), so tests must
// leave it exactly as they found it -- reset to a known value before each
// test rather than relying on run order.
beforeEach(() => {
  setThemeChoiceSnapshot("system");
});

describe("theme store: getThemeChoiceServerSnapshot", () => {
  test('is always "system", deterministically -- the SSR fallback readStoredChoice() itself uses', () => {
    assert.equal(getThemeChoiceServerSnapshot(), "system");
    setThemeChoiceSnapshot("dark");
    // The SERVER snapshot must stay fixed regardless of the live shared
    // choice -- useSyncExternalStore calls this only during server
    // rendering / hydration, never as a live read.
    assert.equal(getThemeChoiceServerSnapshot(), "system");
  });
});

describe("theme store: cross-instance sync (Finding #73's actual regression net)", () => {
  test("a change from one 'instance' is observed by a second subscriber without either remounting", () => {
    const seenByA = [];
    const seenByB = [];
    const unsubA = subscribeThemeChoice(() => seenByA.push(getThemeChoiceSnapshot()));
    const unsubB = subscribeThemeChoice(() => seenByB.push(getThemeChoiceSnapshot()));

    setThemeChoiceSnapshot("dark");

    // Both subscribers -- standing in for two independently mounted
    // useThemeChoice() consumers, e.g. the topbar switch and Settings' own
    // control -- observe the SAME new value from the SAME change, with no
    // remount of either.
    assert.deepEqual(seenByA, ["dark"]);
    assert.deepEqual(seenByB, ["dark"]);
    assert.equal(getThemeChoiceSnapshot(), "dark");

    setThemeChoiceSnapshot("light");
    assert.deepEqual(seenByA, ["dark", "light"]);
    assert.deepEqual(seenByB, ["dark", "light"]);

    unsubA();
    unsubB();
  });

  test("a subscriber that unsubscribes stops observing further changes, but others keep receiving them", () => {
    const seenByA = [];
    const seenByB = [];
    const unsubA = subscribeThemeChoice(() => seenByA.push(getThemeChoiceSnapshot()));
    const unsubB = subscribeThemeChoice(() => seenByB.push(getThemeChoiceSnapshot()));

    setThemeChoiceSnapshot("dark");
    unsubA();
    setThemeChoiceSnapshot("light");

    assert.deepEqual(seenByA, ["dark"], "unsubscribed listener must not observe the second change");
    assert.deepEqual(seenByB, ["dark", "light"], "still-subscribed listener must observe both changes");

    unsubB();
  });

  test("setThemeChoiceSnapshot updates the snapshot even with zero subscribers (no listener required to take effect)", () => {
    setThemeChoiceSnapshot("dark");
    assert.equal(getThemeChoiceSnapshot(), "dark");
  });

  test("getThemeChoiceSnapshot reflects the most recent write, read fresh (not cached stale) by a brand-new subscriber", () => {
    setThemeChoiceSnapshot("dark");
    // A "new" subscriber (e.g. a component mounting for the first time
    // AFTER an earlier change already happened) must see the CURRENT value
    // immediately, not whatever the store held when the module first
    // loaded.
    const seen = [];
    const unsub = subscribeThemeChoice(() => seen.push(getThemeChoiceSnapshot()));
    assert.equal(getThemeChoiceSnapshot(), "dark");
    setThemeChoiceSnapshot("light");
    assert.deepEqual(seen, ["light"]);
    unsub();
  });
});
