// Finding #72 (PR #8 security review): apps/shell/package.json previously
// had no "version" field, so vite.config.ts's `__APP_VERSION__` define
// evaluated to the literal JS `undefined` (not a string) -- an unsound `as
// { version: string }` cast hid that from tsc, and it rendered as
// "Shell vundefined" in Settings (src/pages/settings.tsx).
//
// This test imports the REAL resolved build-time constant, not a mock: this
// file runs through the same vite.config.ts `define` block
// (vitest.config.ts's own `test` block reuses the top-level defineConfig)
// that a real `vite build` uses, so a regression that reintroduces a
// missing/malformed "version" field fails vite.config.ts's own loud
// `resolvePackageVersion` assertion at config-load time, before this test
// (or any other) even gets to run -- and if that assertion were ever
// weakened back to a silent fallback, this test is the second line of
// defense that still catches the wrong shape reaching the running app.
import { describe, expect, it } from "vitest";
import { APP_VERSION, BUILD_SHA, BUILD_TIME } from "./build-info";

describe("build-info: __APP_VERSION__ (Finding #72 regression net)", () => {
  it("is a real, non-empty string -- never the literal undefined", () => {
    expect(typeof APP_VERSION).toBe("string");
    expect(APP_VERSION.length).toBeGreaterThan(0);
    expect(APP_VERSION).not.toBe("undefined");
  });

  it("looks like a real semver-ish version, not a stray literal (e.g. package.json's own 0.1.0)", () => {
    // Loose on purpose (not a strict semver regex): the point is ruling out
    // exactly the failure mode this finding is about -- "undefined" or
    // empty -- not pinning the version scheme.
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("BUILD_SHA and BUILD_TIME are also real, non-empty strings (same define block)", () => {
    expect(typeof BUILD_SHA).toBe("string");
    expect(BUILD_SHA.length).toBeGreaterThan(0);
    expect(typeof BUILD_TIME).toBe("string");
    expect(BUILD_TIME.length).toBeGreaterThan(0);
  });
});
