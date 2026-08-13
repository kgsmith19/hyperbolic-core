// Contrast gate for packages/ui/styles/tokens.css.
//
// This test PARSES the real tokens.css (not a hand-duplicated copy of the
// oklch values) so it can never silently drift from what actually ships.
// It extracts the bare `:root` block (light), the
// `:root:not([data-theme="light"])` block nested inside
// `@media (prefers-color-scheme: dark)`, and the `:root[data-theme="dark"]`
// block, then computes WCAG 2.1 contrast ratios for every permitted
// text-on-background token pair in both themes:
//   oklch -> OKLab -> linear sRGB (CSS Color 4 / Ottosson matrices)
//   -> WCAG relative luminance -> WCAG contrast ratio.
//
// Floors: 4.5:1 for text-role tokens; 3:1 for the one non-text UI token
// this package names as a mandatory focus indicator (--color-ring), per
// docs/planning/09-design-system.md section 5 ("Focus visible everywhere").
//
// Scope decisions (read before extending the permitted-pairs tables below):
//   - --color-text-muted is asserted ONLY against --color-bg and
//     --color-surface, exactly the two pairs
//     docs/planning/09-design-system.md section 3.2 names explicitly.
//     Measured but NOT asserted: muted-on-bg-subtle (light) = 4.339:1,
//     under the 4.5:1 floor. Do not style muted metadata text onto
//     --color-bg-subtle or --color-surface-raised in light theme.
//   - --color-border / --color-border-strong are NOT asserted at 3:1.
//     They are structural/decorative hairlines (WCAG 1.4.11's carve-out
//     for non-essential boundaries), not the mandatory focus indicator.
//     Measured, for the record: border-strong on bg = 1.482:1 (light),
//     4.383:1 (dark). If a future primitive leans on border-strong alone
//     (no other cue) to convey a required boundary, that pair should be
//     added here and the light value revisited.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensPath = path.join(here, "..", "styles", "tokens.css");
const rawCss = readFileSync(tokensPath, "utf8");

// ---------------------------------------------------------------------
// Minimal CSS block/declaration scanner (no dependency: this file's own
// grammar is simple enough -- no braces or semicolons inside strings).
// ---------------------------------------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Split `text` into top-level {selector, body} rules by brace matching. */
function parseRules(text) {
  const rules = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const braceIdx = text.indexOf("{", i);
    if (braceIdx === -1) break;
    const selector = text.slice(i, braceIdx).trim().replace(/\s+/g, " ");
    let depth = 1;
    let j = braceIdx + 1;
    while (j < n && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(braceIdx + 1, j - 1);
    if (selector) rules.push({ selector, body });
    i = j;
  }
  return rules;
}

/** Extract `--custom-property: value;` declarations from a rule body. */
function parseDeclarations(body) {
  const decls = {};
  let depth = 0;
  let start = 0;
  const commit = (chunk) => {
    const colonIdx = chunk.indexOf(":");
    if (colonIdx === -1) return;
    const name = chunk.slice(0, colonIdx).trim();
    const value = chunk.slice(colonIdx + 1).trim();
    if (name.startsWith("--") && value) decls[name] = value;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) {
      commit(body.slice(start, i));
      start = i + 1;
    }
  }
  commit(body.slice(start));
  return decls;
}

const stripped = stripComments(rawCss);
const topRules = parseRules(stripped);

const rootRule = topRules.find((r) => r.selector === ":root");
const mediaRule = topRules.find(
  (r) => r.selector === "@media (prefers-color-scheme: dark)"
);
const darkAttrRule = topRules.find(
  (r) => r.selector === ':root[data-theme="dark"]'
);

describe("tokens.css structure", () => {
  test("bare :root block exists", () => {
    assert.ok(rootRule, "expected a bare :root { ... } block");
  });
  test("@media (prefers-color-scheme: dark) block exists", () => {
    assert.ok(mediaRule, "expected @media (prefers-color-scheme: dark) { ... }");
  });
  test(':root[data-theme="dark"] block exists', () => {
    assert.ok(darkAttrRule, 'expected :root[data-theme="dark"] { ... }');
  });
});

const lightTokens = rootRule ? parseDeclarations(rootRule.body) : {};

let mediaDarkTokens = {};
if (mediaRule) {
  const nested = parseRules(mediaRule.body);
  const mediaDarkRule = nested.find(
    (r) => r.selector === ':root:not([data-theme="light"])'
  );
  test('media block nests :root:not([data-theme="light"])', () => {
    assert.ok(
      mediaDarkRule,
      'expected :root:not([data-theme="light"]) inside the dark media query'
    );
  });
  if (mediaDarkRule) mediaDarkTokens = parseDeclarations(mediaDarkRule.body);
}

const darkAttrTokens = darkAttrRule ? parseDeclarations(darkAttrRule.body) : {};

// Acceptance criterion 1: no token may receive its ONLY definition inside a
// media or [data-theme] block -- every dark-tier key must already exist on
// bare :root, and the two dark tiers must agree with each other exactly.
describe("cascade discipline", () => {
  test("every prefers-color-scheme dark key already has a bare :root definition", () => {
    for (const key of Object.keys(mediaDarkTokens)) {
      assert.ok(
        Object.hasOwn(lightTokens, key),
        `${key} is redefined in the dark media query but has no bare :root definition`
      );
    }
  });
  test("every data-theme=dark key already has a bare :root definition", () => {
    for (const key of Object.keys(darkAttrTokens)) {
      assert.ok(
        Object.hasOwn(lightTokens, key),
        `${key} is redefined in :root[data-theme="dark"] but has no bare :root definition`
      );
    }
  });
  test("the two dark tiers define the exact same set of keys", () => {
    assert.deepEqual(
      Object.keys(mediaDarkTokens).sort(),
      Object.keys(darkAttrTokens).sort()
    );
  });
  test("the two dark tiers agree on every value", () => {
    for (const key of Object.keys(mediaDarkTokens)) {
      assert.equal(
        darkAttrTokens[key],
        mediaDarkTokens[key],
        `${key} differs between the prefers-color-scheme tier and the data-theme tier`
      );
    }
  });

  const EXPECTED_COLOR_TOKENS = [
    "--color-bg", "--color-bg-subtle", "--color-surface", "--color-surface-raised",
    "--color-overlay", "--color-border", "--color-border-strong",
    "--color-text", "--color-text-secondary", "--color-text-muted",
    "--color-accent", "--color-accent-fg", "--color-accent-muted",
    "--color-success", "--color-success-bg", "--color-warn", "--color-warn-bg",
    "--color-danger", "--color-danger-bg", "--color-info", "--color-info-bg",
    "--color-ring",
  ];
  test("every table color token is defined on bare :root", () => {
    for (const key of EXPECTED_COLOR_TOKENS) {
      assert.ok(Object.hasOwn(lightTokens, key), `missing :root definition for ${key}`);
    }
  });
  test("every table color token is redefined in both dark tiers", () => {
    for (const key of EXPECTED_COLOR_TOKENS) {
      assert.ok(Object.hasOwn(mediaDarkTokens, key), `${key} missing from the dark media tier`);
      assert.ok(Object.hasOwn(darkAttrTokens, key), `${key} missing from the data-theme=dark tier`);
    }
  });
});

// ---------------------------------------------------------------------
// oklch -> linear sRGB -> WCAG relative luminance -> WCAG contrast ratio
// ---------------------------------------------------------------------

function parseOklch(value) {
  const m = value.match(
    /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%\s*)?\)/
  );
  if (!m) throw new Error(`not an oklch() color: ${value}`);
  const [, L, C, H, A] = m;
  return { L: Number(L), C: Number(C), H: Number(H), A: A === undefined ? 1 : Number(A) / 100 };
}

/** OKLab -> linear sRGB, CSS Color 4 / Ottosson reference matrices. */
function oklchToLinearSrgb({ L, C, H, A }) {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    A,
  ];
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Alpha-composite a (possibly transparent) linear color over an opaque one. */
function compositeOver([r, g, b, a], [br, bg, bb]) {
  if (a >= 1) return [r, g, b];
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

function relLuminance([r, g, b]) {
  return 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);
}

function contrastRatio(lumA, lumB) {
  const hi = Math.max(lumA, lumB);
  const lo = Math.min(lumA, lumB);
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast ratio of token `fgName` over token `bgName` in a resolved theme. */
function ratioOf(theme, fgName, bgName) {
  const fgRaw = theme[fgName];
  const bgRaw = theme[bgName];
  assert.ok(fgRaw, `unresolved token ${fgName} in theme`);
  assert.ok(bgRaw, `unresolved token ${bgName} in theme`);
  const fgLinear = oklchToLinearSrgb(parseOklch(fgRaw));
  const bgLinear = oklchToLinearSrgb(parseOklch(bgRaw));
  const fgComposited = compositeOver(fgLinear, bgLinear);
  return contrastRatio(relLuminance(fgComposited), relLuminance(bgLinear));
}

// Effective resolved themes: dark = light defaults overridden by the dark tier
// (typography/shape/motion tokens are theme-invariant and never redefined).
const themes = {
  light: lightTokens,
  dark: { ...lightTokens, ...mediaDarkTokens },
};

// ---------------------------------------------------------------------
// Permitted pairs (see the file-header scope decisions for what's excluded
// and why).
// ---------------------------------------------------------------------

const AA_TEXT = 4.5;
const AA_NONTEXT = 3.0;
const GENERAL_BG = ["--color-bg", "--color-bg-subtle", "--color-surface", "--color-surface-raised"];
const SEMANTIC_BG = ["--color-bg", "--color-surface", "--color-surface-raised"];
const SEMANTICS = ["success", "warn", "danger", "info"];

const pairs = [];

// Primary body text and secondary text: any general container.
for (const fg of ["--color-text", "--color-text-secondary"]) {
  for (const bg of GENERAL_BG) {
    pairs.push({ fg, bg, floor: AA_TEXT });
  }
}

// Muted text: restricted per the design-doc's explicit callout (see header).
for (const bg of ["--color-bg", "--color-surface"]) {
  pairs.push({ fg: "--color-text-muted", bg, floor: AA_TEXT });
}

// Text rendered on the accent fill (buttons, selected chips).
pairs.push({ fg: "--color-accent-fg", bg: "--color-accent", floor: AA_TEXT });

// Semantic text/icon tokens: their own tinted fill, plus any general surface
// they might render on as plain colored text (status text, inline icons).
for (const s of SEMANTICS) {
  pairs.push({ fg: `--color-${s}`, bg: `--color-${s}-bg`, floor: AA_TEXT });
  for (const bg of SEMANTIC_BG) {
    pairs.push({ fg: `--color-${s}`, bg, floor: AA_TEXT });
  }
}

// Focus ring: the one token this system names as a mandatory non-text UI
// indicator (docs/planning/09-design-system.md section 5).
for (const bg of GENERAL_BG) {
  pairs.push({ fg: "--color-ring", bg, floor: AA_NONTEXT });
}

describe("token contrast floors", () => {
  for (const themeName of ["light", "dark"]) {
    const theme = themes[themeName];
    describe(themeName, () => {
      for (const { fg, bg, floor } of pairs) {
        test(`${fg} on ${bg} >= ${floor}:1`, () => {
          const ratio = ratioOf(theme, fg, bg);
          assert.ok(
            ratio >= floor,
            `${fg} on ${bg} (${themeName}) = ${ratio.toFixed(3)}:1, below the ${floor}:1 floor`
          );
        });
      }
    });
  }
});
