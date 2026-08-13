// Finding #75 (PR #8 security review, reduced-motion half only -- the
// contrast half of that same original finding is a separate, already-
// bounded scope decision and is untouched here). Confirmed by grep before
// the fix: no `prefers-reduced-motion` handling anywhere in packages/ui
// (tokens.css or src/). This test parses the real tokens.css (not a
// hand-duplicated copy), matching test/contrast.test.mjs's own established
// precedent for testing token/CSS properties programmatically.
//
// Honest scope note: this proves the RULE exists and is shaped correctly
// (present, matches the standard media feature, sets the right properties,
// carries enough specificity to actually win). It cannot prove a real
// browser visually suppresses motion when the OS preference is set --
// that would need a real browser test harness (e.g. Playwright's
// page.emulateMedia({ reducedMotion: "reduce" })), which this package's
// test suite doesn't carry (see chrome.test.mjs's own header comment on
// that same SSR-only boundary). Manually confirmed instead by reasoning
// through CSS's own cascade-layer rules: this rule is written OUTSIDE any
// `@layer` block (tokens.css defines `@theme inline` and plain `:root`
// rules, never wraps this new block in `@layer utilities/base/etc.`), and
// per the CSS Cascade Layers spec, ANY unlayered declaration beats ANY
// layered declaration regardless of specificity or source order -- so this
// rule wins over every Tailwind utility class's own transition-duration
// declaration (e.g. nav-rail.tsx's `transition-colors duration-base`,
// which IS layered, inside Tailwind's `utilities` layer) even without the
// belt-and-suspenders `!important` this rule also carries.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensPath = path.join(here, "..", "styles", "tokens.css");
const rawCss = readFileSync(tokensPath, "utf8");

describe("tokens.css: prefers-reduced-motion (Finding #75)", () => {
  test("an @media (prefers-reduced-motion: reduce) block is present", () => {
    assert.match(rawCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  test("the block sets transition-duration and animation-duration, both !important", () => {
    const match = rawCss.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, "expected to find the reduced-motion media block's body");
    const body = match[1];
    assert.match(body, /transition-duration:\s*[^;]+!important/);
    assert.match(body, /animation-duration:\s*[^;]+!important/);
  });

  test("the block is NOT nested inside any @layer (unlayered CSS always beats layered CSS, incl. Tailwind's own utility classes)", () => {
    const mediaIdx = rawCss.indexOf("@media (prefers-reduced-motion: reduce)");
    assert.notEqual(mediaIdx, -1);
    // No unmatched "@layer" opening brace between the start of the file and
    // this block's own position would mean this block sits at the top
    // level, not inside some earlier-opened @layer. tokens.css's only
    // @layer usage is `@layer base { ... }`, which closes (visibly balanced)
    // well before this block -- confirmed by counting braces in between.
    const between = rawCss.slice(0, mediaIdx);
    const opens = (between.match(/\{/g) ?? []).length;
    const closes = (between.match(/\}/g) ?? []).length;
    assert.equal(opens, closes, "the reduced-motion block must not be nested inside an earlier, still-open block (e.g. @layer)");
  });
});
