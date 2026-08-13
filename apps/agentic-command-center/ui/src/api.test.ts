// node --test src/api.test.ts
//
// Mirrors gui/server.test.mjs's convention for the ACC server suite (plain
// `node --test`, no test framework beyond Node's own). This package has no
// unit-test setup of its own — only Playwright, wired for end-to-end
// contract tests against a real server (see e2e/contract.spec.ts) — and
// this fix's scope forbids adding a new devDependency. Node 22.22+ (this
// package's own `engines` floor) runs .ts source directly via built-in type
// stripping, so `node --test src/api.test.ts` needs nothing new installed.
//
// bootstrapTokenFromFragment() (Finding #67, gui/server.mjs's sibling fix in
// src/api.ts) runs at MODULE LOAD TIME. Ordinary `import` caches per
// specifier, so every scenario below needs its own fresh module evaluation —
// each test appends a unique cache-busting query string to the import
// specifier, a standard Node ESM trick (the module cache key includes the
// full specifier, query string included), not a second test-runner
// dependency.
//
// @ts-nocheck — tsconfig.json's `include: ["src"]` pulls this file into
// `npm run build`'s `tsc -b` pass alongside the real product source, but
// this package has no `@types/node` (only `vite/client` is in `types`), so
// the bare `node:test`/`node:assert/strict` specifiers below are otherwise
// unresolvable to tsc — TS2591. Adding `@types/node` would need a
// package.json/tsconfig.json edit, both outside this fix's file scope.
// This file's actual correctness is verified by running it (`node --test`,
// evidenced in the PR), not by tsc — same division of labor as
// gui/server.test.mjs, which tsc never looks at because it lives outside
// any `tsconfig.json` `include`. `@ts-nocheck` reproduces that same
// hands-off-for-tsc treatment for this file without editing shared config.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const STORAGE_KEY = "acc-gui-token";
// Shape-valid stand-in for a real token: gui/server.mjs's loadOrCreateToken()
// always produces exactly 43 base64url characters (32 random bytes) — see
// that function and gui/README.md's "Token file" section, and the matching
// TOKEN_SHAPE_RE this fix adds in src/api.ts.
const VALID_TOKEN = "A".repeat(43);

class FakeSessionStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

// Installs a minimal fake `window` with just the surface
// bootstrapTokenFromFragment() touches: `location.hash` (read once, at
// import time), `location.href` + `history.replaceState` (the fragment-
// stripping `finally`), and `sessionStorage`. `hash` is static per test
// (the real code only ever reads it once, synchronously, during its own
// module-load-time call) — matches how a browser's `location.hash` already
// includes the leading "#".
function installFakeWindow(hash: string) {
  const sessionStorage = new FakeSessionStorage();
  let currentHref = `http://127.0.0.1:43117/${hash}`;
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      hash,
      get href() {
        return currentHref;
      },
    },
    sessionStorage,
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        currentHref = url;
      },
    },
  };
  return {
    sessionStorage,
    strippedFragment: () => !currentHref.includes("#"),
  };
}

beforeEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

let importCounter = 0;
// Fresh module evaluation per call (see the file header comment) — every
// call site re-runs bootstrapTokenFromFragment() against whatever fake
// `window` the calling test just installed.
function importApiFresh(): Promise<unknown> {
  importCounter += 1;
  return import(`./api.ts?bust=${importCounter}`);
}

test("Finding 67: a malformed fragment (#acc-token=%) does not throw, and results in no stored token", async () => {
  const { sessionStorage, strippedFragment } = installFakeWindow("#acc-token=%");
  // decodeURIComponent("%") throws URIError — the regression this fix
  // closes is that throw propagating, uncaught, out of module evaluation.
  await assert.doesNotReject(importApiFresh());
  assert.equal(sessionStorage.getItem(STORAGE_KEY), null, "a malformed fragment must never end up stored as a token");
  assert.ok(strippedFragment(), "the fragment must still be stripped from the URL even when parsing failed");
});

test("Finding 67: a validly-shaped token is still accepted and stored correctly (positive control)", async () => {
  const { sessionStorage, strippedFragment } = installFakeWindow(`#acc-token=${VALID_TOKEN}`);
  await importApiFresh();
  assert.equal(sessionStorage.getItem(STORAGE_KEY), VALID_TOKEN, "a real, correctly-shaped token must still round-trip into storage");
  assert.ok(strippedFragment());
});

test("Finding 67: a token whose decoded value contains CR/LF is rejected by the shape check, never stored or later used in a header", async () => {
  const injected = encodeURIComponent(`${"a".repeat(20)}\r\nX-Injected: evil`);
  const { sessionStorage } = installFakeWindow(`#acc-token=${injected}`);
  await assert.doesNotReject(importApiFresh());
  assert.equal(sessionStorage.getItem(STORAGE_KEY), null, "a decoded CR/LF must be rejected by TOKEN_SHAPE_RE rather than stored verbatim");
});

test("Finding 67: an otherwise well-formed but wrong-length/alphabet value is rejected by the shape check", async () => {
  for (const bad of ["short", VALID_TOKEN + "X", `${VALID_TOKEN.slice(0, 42)}!`]) {
    const { sessionStorage } = installFakeWindow(`#acc-token=${encodeURIComponent(bad)}`);
    await importApiFresh();
    assert.equal(sessionStorage.getItem(STORAGE_KEY), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("Finding 67: no fragment at all is a silent no-op — no crash, nothing stored", async () => {
  const { sessionStorage } = installFakeWindow("");
  await assert.doesNotReject(importApiFresh());
  assert.equal(sessionStorage.getItem(STORAGE_KEY), null);
});

test("Finding 67: non-browser eval (typeof window === \"undefined\") never throws (existing guard, unaffected by this fix)", async () => {
  delete (globalThis as unknown as { window?: unknown }).window;
  await assert.doesNotReject(importApiFresh());
});
