// Finding #70 (PR #8 security review): NavRail and CommandPalette rendered
// every ZONE_ENTRIES item as a plain native `<a href>`, forcing a full
// document reload on every internal-Shell-route click. The fix threads an
// optional `navigate` adapter through Chrome -> NavRail/CommandPalette, and
// `shouldNavigateClientSide` (zones.ts) is the one shared decision both
// consumers call instead of each hand-rolling their own copy of the rule.
//
// This imports src/chrome/zones.ts directly (not dist/index.cjs), matching
// test/notifications.test.mjs's established precedent: the navigation
// registry and its policy helpers are plain TypeScript with no JSX, so
// Node's built-in type stripping can exercise the source without a build
// step going stale. NavRail's and CommandPalette's own USE of this function
// (the actual onClick wiring) is JSX and therefore cannot be exercised this
// way; that behavioral half is proven in
// apps/shell's jsdom-backed component tests and e2e/chrome.spec.ts's real
// browser proof instead -- see this issue's report for why.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchRoutes } from "react-router";

const {
  classifyNavigationTarget,
  isNavigationTargetMountable,
  normalizeOriginPathname,
  ZONE_ENTRIES,
  shouldNavigateClientSide,
} = await import("../src/chrome/zones.ts");

describe("isNavigationTargetMountable: document owners can mount the browser pathname", () => {
  const lifeRoutes = [{ path: "/*" }];
  const origin = "https://shell.example";

  test("accepts canonical LifeOS boundaries and preserves encoded tail data", () => {
    for (const target of [
      "/life",
      "/life/",
      "/life/capture?mode=quick#entry",
      "/life/entities/id%2Fwith%2Fslashes",
    ]) {
      const browserPathname = new URL(target, origin).pathname;
      assert.ok(matchRoutes(lifeRoutes, browserPathname, "/life"), target);
      assert.equal(isNavigationTargetMountable?.(target), true, target);
    }

    assert.equal(
      isNavigationTargetMountable?.("/life/%FF?mode=quick#entry"),
      true,
      "a non-UTF byte below the literal boundary remains navigation data",
    );
  });

  test("rejects encoded boundaries that nginx assigns to LifeOS but its basename cannot mount", () => {
    for (const target of [
      "/%6cife/capture",
      "/%6cife",
      "/life%2Fcapture",
      "/life%2F",
      "/%6cife%2Fcapture",
      "/%2Flife/capture",
      "/shell/%2e%2e%2Flife%2Fcapture",
    ]) {
      const browserPathname = new URL(target, origin).pathname;
      assert.equal(classifyNavigationTarget(target), "document", target);
      assert.equal(matchRoutes(lifeRoutes, browserPathname, "/life"), null, target);
      assert.equal(isNavigationTargetMountable?.(target), false, target);
    }
  });

  test("does not impose the LifeOS basename on Shell-owned targets", () => {
    for (const target of ["/", "/settings", "/lifefoo", "/life%252Fcapture"]) {
      assert.equal(classifyNavigationTarget(target), "client", target);
      assert.equal(isNavigationTargetMountable?.(target), true, target);
    }
  });
});

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
    const lifeRoutes = [{ path: "/*" }];
    const encodedLife = "/%6cife/capture?mode=quick#entry";
    const encodedLifePath = new URL(encodedLife, origin).pathname;

    assert.equal(
      matchRoutes(lifeRoutes, encodedLifePath, "/life"),
      null,
      encodedLife,
    );
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
      assert.equal(matchRoutes(lifeRoutes, browserPath, "/life"), null, target);
      assert.equal(classifyNavigationTarget(target), "client", target);
    }
  });

  test("decodes valid boundary bytes even when another escaped byte is invalid UTF-8", () => {
    for (const [target, expectedKind] of [
      ["/life%2F%FF?mode=quick#entry", "document"],
      ["/lifefoo%2F%FF", "client"],
    ]) {
      assert.equal(classifyNavigationTarget(target), expectedKind, target);
    }
  });

  test("normalizes decoded separators and dot segments before choosing the nginx-owned zone", () => {
    for (const [target, expectedKind] of [
      ["/%2Flife/capture", "document"],
      ["/%2Flife/capture?mode=quick#entry", "document"],
      ["/shell/%2e%2e%2Flife%2Fcapture", "document"],
      ["/shell/%2e%2e%2Flife%2Fcapture?mode=quick#entry", "document"],
      ["/life%2F..%2Fsettings", "client"],
      ["/life%2F..%2Fsettings?tab=theme#system", "client"],
    ]) {
      assert.equal(classifyNavigationTarget(target), expectedKind, target);
    }
  });

  test("rejects origin-invalid decoded pathnames and classifies them fail-closed", () => {
    const origin = "https://shell.example";

    assert.equal(
      normalizeOriginPathname?.(
        new URL("/shell/%2e%2e%2Flife%2Fcapture", origin).pathname
      ),
      "/life/capture",
      "an in-root decoded traversal remains valid"
    );

    for (const target of [
      "/%2e%2e%2Flife%2Fcapture",
      "/life%2F%00?mode=quick#entry",
    ]) {
      assert.equal(
        normalizeOriginPathname?.(new URL(target, origin).pathname),
        null,
        target
      );
      assert.equal(classifyNavigationTarget(target), "document", target);
    }
  });

  test("rejects malformed original percent sequences and classifies them fail-closed", () => {
    const origin = "https://shell.example";

    for (const target of [
      "/%zzlife/capture",
      "/life/%zz",
      "/life/%2",
      "/life/%",
    ]) {
      assert.doesNotThrow(() => classifyNavigationTarget(target), target);
      assert.equal(
        normalizeOriginPathname(new URL(target, origin).pathname),
        null,
        target
      );
      assert.equal(classifyNavigationTarget(target), "document", target);
    }
  });

  test("keeps an escape exposed by one-pass percent decoding inert", () => {
    const target = "/life%252Fcapture";
    const browserPath = new URL(target, "https://shell.example").pathname;

    assert.equal(normalizeOriginPathname(browserPath), "/life%2Fcapture");
    assert.equal(classifyNavigationTarget(target), "client");
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
