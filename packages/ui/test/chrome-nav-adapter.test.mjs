// Finding #70 (PR #8 security review): NavRail and CommandPalette rendered
// every ZONE_ENTRIES item as a plain native `<a href>`, forcing a full
// document reload on every internal-Shell-route click. The fix threads an
// optional `navigate` adapter through Chrome -> NavRail/CommandPalette, and
// `shouldNavigateClientSide` (zones.ts) is the one shared decision both
// consumers call instead of each hand-rolling their own copy of the rule.
//
// This imports src/chrome/zones.ts directly (not dist/index.cjs), matching
// test/notifications.test.mjs's established precedent: `ZONE_ENTRIES`,
// `NavigateAdapter`, and `shouldNavigateClientSide` are plain TypeScript
// with no JSX (Node's built-in type stripping runs the file directly, no
// build step to go stale) and are NOT re-exported through packages/ui's
// public entry (src/index.ts exports only the `Zone` type from this
// module) -- testing them through dist would force them into the package's
// public surface just to be reachable. NavRail's and CommandPalette's own
// USE of this function (the actual onClick wiring) is JSX and therefore
// cannot be exercised this way; that behavioral half is proven in
// apps/shell's jsdom-backed component tests and e2e/chrome.spec.ts's real
// browser proof instead -- see this issue's report for why.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchRoutes } from "react-router";

const { classifyNavigationTarget, ZONE_ENTRIES, shouldNavigateClientSide } = await import("../src/chrome/zones.ts");

describe("classifyNavigationTarget: document boundaries come from the zone registry", () => {
  test("LifeOS roots and descendants require document navigation without losing suffixes", () => {
    for (const target of [
      "/life",
      "/life/",
      "/life/today",
      "/life/today?view=compact#entry-4",
    ]) {
      assert.equal(classifyNavigationTarget(target), "document", target);
    }
  });

  test("similar prefixes and Shell routes remain client navigation", () => {
    for (const target of [
      "/",
      "/settings",
      "/tools/foo",
      "/ideas/123?view=detail#notes",
      "/lifefoo",
      "/lifestyle",
    ]) {
      assert.equal(classifyNavigationTarget(target), "client", target);
    }
  });

  test("uses the browser-normalized pathname for dot segments without losing suffixes", () => {
    const origin = "https://shell.example";
    for (const [target, expectedPath, expectedKind] of [
      [
        "/tools/../life/capture?mode=quick#details",
        "/life/capture",
        "document",
      ],
      ["/life/../settings?tab=theme#system", "/settings", "client"],
    ]) {
      assert.equal(new URL(target, origin).pathname, expectedPath, target);
      assert.equal(classifyNavigationTarget(target), expectedKind, target);
    }
  });

  test("uses origin-equivalent decoding at encoded zone boundaries", () => {
    const origin = "https://shell.example";
    const lifeRoutes = [{ path: "/life/*" }];
    const encodedLife = "/%6cife/capture?mode=quick#entry";
    const encodedLifePath = new URL(encodedLife, origin).pathname;

    assert.ok(matchRoutes(lifeRoutes, encodedLifePath), encodedLife);
    assert.equal(classifyNavigationTarget(encodedLife), "document", encodedLife);

    for (const target of ["/life%2Fcapture", "/%6cife%2Fcapture"]) {
      const originPath = decodeURIComponent(new URL(target, origin).pathname);
      assert.equal(originPath, "/life/capture", target);
      assert.equal(classifyNavigationTarget(target), "document", target);
    }

    for (const target of [
      "/%6cifefoo/capture",
      "/%6cifestyle",
      "/life%252Fcapture",
      "/%6cife/../%73ettings?tab=theme#system",
    ]) {
      const browserPath = new URL(target, origin).pathname;
      assert.equal(matchRoutes(lifeRoutes, browserPath), null, target);
      assert.equal(classifyNavigationTarget(target), "client", target);
    }
  });

  test("malformed percent sequences classify without throwing", () => {
    for (const [target, expected] of [
      ["/%zzlife/capture", "client"],
      ["/life/%zz", "document"],
    ]) {
      assert.doesNotThrow(() => classifyNavigationTarget(target), target);
      assert.equal(classifyNavigationTarget(target), expected, target);
    }
  });
});

describe("zones.ts: hardNavigate marks exactly the one genuinely cross-zone entry", () => {
  test("life is hardNavigate:true; every other zone is falsy", () => {
    for (const entry of ZONE_ENTRIES) {
      if (entry.zone === "life") {
        assert.equal(entry.hardNavigate, true, "life must be hardNavigate:true");
      } else {
        assert.ok(
          !entry.hardNavigate,
          `zone "${entry.zone}" must NOT be hardNavigate -- it is a genuine internal Shell route`
        );
      }
    }
  });

  test("ZONE_ENTRIES still has exactly the six route-map zones (sanity check for the loop above)", () => {
    assert.deepEqual(
      ZONE_ENTRIES.map((e) => e.zone),
      ["home", "life", "acc", "tools", "prompts", "ideas"]
    );
  });
});

describe("shouldNavigateClientSide: the exact decision matrix", () => {
  const internalEntry = { hardNavigate: undefined };
  const hardNavigateEntry = { hardNavigate: true };
  const navigate = () => {};

  test("true: navigate supplied AND entry is not hardNavigate", () => {
    assert.equal(shouldNavigateClientSide(internalEntry, navigate), true);
  });

  test("false: no navigate adapter supplied, even for an internal entry", () => {
    assert.equal(shouldNavigateClientSide(internalEntry, undefined), false);
  });

  test("false: entry is hardNavigate, even with a navigate adapter supplied", () => {
    assert.equal(shouldNavigateClientSide(hardNavigateEntry, navigate), false);
  });

  test("false: hardNavigate entry AND no navigate adapter (today's default state for every caller)", () => {
    assert.equal(shouldNavigateClientSide(hardNavigateEntry, undefined), false);
  });

  test("every real ZONE_ENTRIES row: true with a navigate adapter iff it is not life", () => {
    for (const entry of ZONE_ENTRIES) {
      const expected = entry.zone !== "life";
      assert.equal(
        shouldNavigateClientSide(entry, navigate),
        expected,
        `zone "${entry.zone}" expected shouldNavigateClientSide=${expected} with a navigate adapter supplied`
      );
    }
  });
});
