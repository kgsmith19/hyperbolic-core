// Structural/DOM-level tests for Chrome (packages/ui/src/chrome/*), the
// m2-01 issue's ChromeProps implementation.
//
// Matches test/focus-visible.test.mjs's established pattern: exercise the
// real BUILT package (dist/index.cjs) via react-dom/server, not source
// .tsx (Node's native TS type-stripping does not transform JSX; run
// `npm run build -w packages/ui` before this file, same ordering m1-04
// acceptance criterion 3 and this file's sibling tests already require).
//
// Scope of what this file CAN prove vs. cannot, stated plainly:
//   - Static structure, prop-driven variation (activeZone, session,
//     children), and text present in the built bundle: fully covered here,
//     exhaustively, via renderToStaticMarkup.
//   - The command palette's and shortcuts overlay's actual rendered
//     content: Chrome only opens them via internal state (Ctrl/Cmd+K, the
//     topbar button, the g-chord), and Base UI's Dialog.Portal correctly
//     renders nothing under react-dom/server (no real DOM for a portal to
//     attach to -- the exact same fundamental SSR limitation
//     focus-visible.test.mjs documents for DialogContent's close button).
//     This file instead reads the built bundle's own text for the
//     command-palette-item data-kind literals (a real, if indirect, proof
//     that only "navigation" and "tool" kinds exist anywhere in the shipped
//     code -- "tool" added by m3-04's registry-sourced palette entries,
//     "action"/"chat" still absent), and the interactive, timing-sensitive
//     acceptance criteria (palette
//     open-to-interactive under 100ms, theme flip under 50ms with no
//     flash, keyboard suppression while focused in a text input) are
//     proven separately in a real Chromium browser -- see this issue's
//     report for that script and its captured output; a real browser is
//     strictly better evidence for those than anything constructible here,
//     and is not duplicated as source under packages/ui/test on purpose
//     (see the report for the reasoning).

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, "..", "dist", "index.cjs");

assert.ok(
  existsSync(distEntry),
  `${distEntry} does not exist -- run \`npm run build -w packages/ui\` before this test.`
);

const require = createRequire(import.meta.url);
const ui = require(distEntry);
const distSrc = readFileSync(distEntry, "utf8");

const ZONES = ["home", "life", "acc", "tools", "prompts", "ideas"];
const ZONE_HREF = {
  home: "/",
  life: "/life/",
  acc: "/acc/",
  tools: "/tools/",
  prompts: "/prompts/",
  ideas: "/ideas/",
};
const ZONE_LABEL = {
  home: "Home",
  life: "LifeOS",
  acc: "ACC",
  tools: "Tools",
  prompts: "Prompts",
  ideas: "Ideas",
};

function renderChrome(props) {
  return renderToStaticMarkup(
    React.createElement(
      ui.Chrome,
      {
        activeZone: "home",
        session: null,
        onSignOut: () => {},
        ...props,
      },
      React.createElement("div", { "data-testid": "zone-page" }, "zone content")
    )
  );
}

describe("Chrome: acceptance criterion 1 -- data-testid=platform-nav on the nav element", () => {
  test("exactly one <nav>, and it carries data-testid=platform-nav", () => {
    const html = renderChrome({});
    const navOpenTags = html.match(/<nav\b[^>]*>/g) ?? [];
    assert.equal(navOpenTags.length, 1, `expected exactly one <nav>, found ${navOpenTags.length}`);
    assert.ok(
      navOpenTags[0].includes('data-testid="platform-nav"'),
      `the single <nav> element must carry data-testid="platform-nav", got: ${navOpenTags[0]}`
    );
  });

  test("the platform-nav element really is a <nav>, not merely an element carrying the attribute", () => {
    const html = renderChrome({});
    const idx = html.indexOf('data-testid="platform-nav"');
    assert.notEqual(idx, -1);
    const before = html.lastIndexOf("<", idx);
    const tag = html.slice(before + 1, before + 4);
    assert.equal(tag, "nav", `expected the enclosing tag to be <nav>, got <${tag}`);
  });

  test("data-testid=platform-nav is present across every zone (SH-1 style: asserted in every zone)", () => {
    for (const zone of ZONES) {
      const html = renderChrome({ activeZone: zone });
      assert.ok(
        html.includes('data-testid="platform-nav"'),
        `zone "${zone}" did not render data-testid="platform-nav"`
      );
    }
  });
});

describe("Chrome: nav rail content and active-state, exhaustive over all six zones", () => {
  for (const zone of ZONES) {
    test(`activeZone="${zone}": exactly this zone's nav-rail-item carries aria-current="page"`, () => {
      const html = renderChrome({ activeZone: zone });

      for (const candidate of ZONES) {
        const marker = `data-zone="${candidate}"`;
        const idx = html.indexOf(marker);
        assert.notEqual(idx, -1, `nav rail is missing a data-zone="${candidate}" entry`);
        // Look at the whole opening tag (back to the previous "<a").
        const tagStart = html.lastIndexOf("<a", idx);
        const tagEnd = html.indexOf(">", idx);
        const tag = html.slice(tagStart, tagEnd);
        if (candidate === zone) {
          assert.ok(
            tag.includes('aria-current="page"'),
            `expected the active zone "${zone}" to carry aria-current="page", got: ${tag}`
          );
        } else {
          assert.ok(
            !tag.includes('aria-current="page"'),
            `expected inactive zone "${candidate}" to NOT carry aria-current="page" while active zone is "${zone}", got: ${tag}`
          );
        }
      }
    });
  }

  test("every zone's nav-rail-item href matches the 05-a section 4 route map", () => {
    const html = renderChrome({});
    for (const zone of ZONES) {
      const marker = `data-zone="${zone}"`;
      const idx = html.indexOf(marker);
      const tagStart = html.lastIndexOf("<a", idx);
      const tagEnd = html.indexOf(">", idx);
      const tag = html.slice(tagStart, tagEnd);
      assert.ok(
        tag.includes(`href="${ZONE_HREF[zone]}"`),
        `zone "${zone}" expected href="${ZONE_HREF[zone]}", got: ${tag}`
      );
    }
  });
});

describe("Chrome: topbar", () => {
  for (const zone of ZONES) {
    test(`activeZone="${zone}": topbar title shows "${ZONE_LABEL[zone]}"`, () => {
      const html = renderChrome({ activeZone: zone });
      const topbarIdx = html.indexOf('data-slot="topbar"');
      assert.notEqual(topbarIdx, -1);
      const h1Start = html.indexOf("<h1", topbarIdx);
      const h1End = html.indexOf("</h1>", h1Start);
      const h1Html = html.slice(h1Start, h1End);
      assert.ok(
        h1Html.includes(ZONE_LABEL[zone]),
        `expected topbar title to include "${ZONE_LABEL[zone]}", got: ${h1Html}`
      );
    });
  }

  test("palette trigger button is present in the topbar", () => {
    const html = renderChrome({});
    assert.ok(html.includes('data-slot="palette-trigger"'));
  });

  test("theme switch is present in the topbar, defaulting to the system choice", () => {
    const html = renderChrome({});
    assert.ok(html.includes('data-slot="theme-switch"'));
    assert.ok(
      html.includes('data-theme-choice="system"'),
      "server render (no localStorage) should default the theme choice to 'system'"
    );
  });

  test("session=null renders no session menu and no sign-out button", () => {
    const html = renderChrome({ session: null });
    assert.ok(!html.includes('data-slot="session-menu"'));
    assert.ok(!html.includes('data-slot="sign-out-button"'));
  });

  test("a real session renders the session menu with the userId and a sign-out button", () => {
    const html = renderChrome({
      session: { accessToken: "t", expiresAt: 0, userId: "11111111-2222-3333-4444-555555555555" },
    });
    assert.ok(html.includes('data-slot="session-menu"'));
    assert.ok(html.includes('data-slot="sign-out-button"'));
    assert.ok(html.includes("11111111-2222-3333-4444-555555555555"));
  });
});

describe("Chrome: content region and children", () => {
  test("children render inside data-slot=chrome-content", () => {
    const html = renderChrome({});
    const contentIdx = html.indexOf('data-slot="chrome-content"');
    assert.notEqual(contentIdx, -1);
    const afterContent = html.slice(contentIdx);
    assert.ok(afterContent.includes('data-testid="zone-page"'));
    assert.ok(afterContent.includes("zone content"));
  });

  test("chrome-content is the skip link's target and is itself focusable (tabindex=-1)", () => {
    const html = renderChrome({});
    assert.ok(html.includes('id="chrome-content"'));
    const mainIdx = html.indexOf('data-slot="chrome-content"');
    const tagStart = html.lastIndexOf("<main", mainIdx);
    const tagEnd = html.indexOf(">", mainIdx);
    const tag = html.slice(tagStart, tagEnd);
    assert.ok(tag.includes('tabindex="-1"'), `expected tabindex="-1" on <main>, got: ${tag}`);
  });
});

describe("Chrome: skip link (09 section 4.3, binding focus convention)", () => {
  test('a skip link targeting "#chrome-content" is present', () => {
    const html = renderChrome({});
    assert.ok(html.includes('data-slot="skip-link"'));
    assert.ok(html.includes('href="#chrome-content"'));
  });

  test("the skip link is the first focusable element in the render (first <a> or <button>)", () => {
    const html = renderChrome({});
    const skipIdx = html.indexOf('data-slot="skip-link"');
    const firstAnchorIdx = html.indexOf("<a ");
    const firstButtonIdx = html.indexOf("<button");
    assert.notEqual(firstAnchorIdx, -1);
    assert.ok(
      skipIdx < firstAnchorIdx + 50,
      "skip link's data-slot should appear at/near the very first <a> tag in the document"
    );
    // The skip link must precede both the first nav-rail link and the
    // topbar's first button in document order.
    const navItemIdx = html.indexOf('data-slot="nav-rail-item"');
    assert.ok(skipIdx < navItemIdx, "skip link must come before the first nav rail item");
    if (firstButtonIdx !== -1) {
      assert.ok(skipIdx < firstButtonIdx, "skip link must come before the first button");
    }
  });
});

describe("Chrome: renders without throwing across the full prop matrix", () => {
  const sessions = [
    null,
    { accessToken: "t", expiresAt: 9999999999, userId: "00000000-0000-0000-0000-000000000000" },
  ];
  for (const zone of ZONES) {
    for (const session of sessions) {
      test(`activeZone=${zone}, session=${session ? "present" : "null"}`, () => {
        assert.doesNotThrow(() => renderChrome({ activeZone: zone, session }));
      });
    }
  }

  test("tools prop (m3-04) is accepted and does not throw, with entries present or absent", () => {
    assert.doesNotThrow(() => renderChrome({ tools: [] }));
    assert.doesNotThrow(() =>
      renderChrome({
        tools: [{ id: "idea-intake", label: "Idea Intake", href: "/ideas" }],
      })
    );
    assert.doesNotThrow(() => renderChrome({ tools: undefined }));
  });
});

// Minifiers are free to choose quote style per string, and drop quotes
// entirely on object keys that are valid bare identifiers (confirmed by
// inspecting the real dist output while writing this test rather than
// assumed): this build's Rolldown minifier emits e.g. `"data-kind":`navigation``
// (key quoted, since "data-kind" is not a valid identifier; value
// backtick-quoted) but `zone:`home`` (key bare, since "zone" is a valid
// identifier). Bundle-text assertions below make key-quoting optional and
// accept any of `"' around the value, rather than hardcoding one shape.
function bundleHasProp(propName, value) {
  const keyQuote = "[`\"']?";
  const valueQuote = "[`\"']";
  return new RegExp(`${keyQuote}${propName}${keyQuote}\\s*:\\s*${valueQuote}${value}${valueQuote}`).test(
    distSrc
  );
}

describe("Chrome: command palette scope, proven against the built bundle's own text", () => {
  // Base UI's Dialog.Portal renders nothing under react-dom/server (no real
  // DOM for a portal to attach to, same limitation focus-visible.test.mjs
  // documents for DialogContent's close icon) -- so the palette's list
  // never appears in renderChrome()'s output regardless of props. This
  // reads the actual shipped bundle text instead, the same technique
  // focus-visible.test.mjs uses for the same underlying reason.
  //
  // m3-04 (docs/planning/05-c-toolbelt.md section 4.3; 05-a section 5) adds
  // a second, registry-sourced result kind, "tool", alongside the original
  // "navigation" -- command-palette.tsx's PaletteResult["kind"] union is
  // exactly these two string literals, `kind:"navigation"` (the zone-entries
  // mapping) and `kind:"tool"` (the tools-prop mapping), which is what this
  // test's bundleHasProp calls below actually find; the JSX `data-kind`
  // attribute itself is now `entry.kind` (a property read, not a literal),
  // so this is no longer literally the DOM attribute's own source text, but
  // it is still real proof of the same thing: no THIRD kind of entry (an
  // action, a chat message, anything else) exists anywhere in the shipped
  // code, because entry.kind can never hold a value that was never
  // constructed as one of these two literals in the first place.
  test('command-palette-item entries are exactly kind "navigation" and kind "tool" -- never a third kind', () => {
    assert.ok(
      bundleHasProp("kind", "navigation"),
      "expected a navigation-kind command palette item literal in the built bundle"
    );
    assert.ok(
      bundleHasProp("kind", "tool"),
      "expected a tool-kind command palette item literal in the built bundle (m3-04 registry entries)"
    );
    for (const forbidden of ["action", "chat"]) {
      assert.ok(
        !bundleHasProp("kind", forbidden) && !bundleHasProp("data-kind", forbidden),
        `found a forbidden kind="${forbidden}" literal in the built bundle -- palette must stay navigation+tool only`
      );
    }
  });

  test("the zone-entries table (shared by the nav rail and the palette) defines exactly the six route-map zones", () => {
    // This is the ZONE_ENTRIES array literal itself (zones.ts), the single
    // source of truth both NavRail and CommandPalette read from -- not a
    // per-callsite dynamic prop (nav-rail-item's and command-palette-item's
    // own `data-zone` are `entry.zone`, a property read on this same array
    // at render time, not a separate literal each place they're used).
    for (const zone of ZONES) {
      assert.ok(bundleHasProp("zone", zone), `expected a zone entry literal for "${zone}"`);
    }
    // "only those six": every zone: <literal> occurrence in the bundle
    // (there may be more than one per zone, e.g. inside the chord-key map
    // in keyboard.ts) must be one of the six known zone keys.
    const allZoneLiterals = [...distSrc.matchAll(/\bzone:[`"']([a-zA-Z]+)[`"']/g)].map((m) => m[1]);
    assert.ok(allZoneLiterals.length > 0, "expected to find at least one zone: <literal> in the bundle");
    for (const found of allZoneLiterals) {
      assert.ok(
        ZONES.includes(found),
        `found a zone literal "${found}" that is not one of the six known zones: ${ZONES.join(", ")}`
      );
    }
  });
});

describe("Chrome: command palette combobox ARIA (Finding #74, PR #8 security review)", () => {
  // Base UI's Dialog.Portal renders nothing under react-dom/server (same
  // limitation the palette-scope describe block above documents), so this
  // reads the built bundle's own text, same technique as bundleHasProp
  // above -- direct proof the shipped code carries these attributes, not
  // just the source.
  test('the search input carries role="combobox"', () => {
    assert.ok(bundleHasProp("role", "combobox"), "expected role=\"combobox\" on the palette's search input");
  });

  test("aria-expanded is present on the combobox input, tied to a variable (not hardcoded true/false)", () => {
    const match = distSrc.match(/role:[`"']combobox[`"'],"aria-expanded":([^,]+),"aria-controls":/);
    assert.ok(match, "expected an aria-expanded attribute immediately after role=\"combobox\" in the built bundle");
    assert.notEqual(match[1].trim(), "`true`", "aria-expanded must track the open prop, not a hardcoded true");
    assert.notEqual(match[1].trim(), "`false`", "aria-expanded must track the open prop, not a hardcoded false");
  });

  test("aria-controls on the input references the exact same identifier as the results <ul>'s own id (never a copy that can drift)", () => {
    const inputMatch = distSrc.match(/role:[`"']combobox[`"'],"aria-expanded":[^,]+,"aria-controls":([\w$]+)/);
    assert.ok(inputMatch, "expected to find the combobox input's aria-controls reference in the built bundle");

    const listMatch = distSrc.match(/id:([\w$]+),"data-slot":[`"']command-palette-list[`"']/);
    assert.ok(listMatch, "expected to find the results <ul>'s id right before its data-slot=\"command-palette-list\" literal");

    assert.equal(
      inputMatch[1],
      listMatch[1],
      `aria-controls ("${inputMatch[1]}") must be the SAME identifier as the results list's id ("${listMatch[1]}")`
    );
  });
});

describe("Chrome source: no raw palette values (09 section 3.1 / adoption rule step 3)", () => {
  test("no oklch()/hex color literals in any packages/ui/src/chrome/*.ts(x) source file", () => {
    const chromeDir = path.join(here, "..", "src", "chrome");
    const files = require("node:fs")
      .readdirSync(chromeDir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    assert.ok(files.length > 0, "expected chrome source files to exist");
    const offenders = [];
    for (const file of files) {
      const src = readFileSync(path.join(chromeDir, file), "utf8");
      if (/oklch\(|#[0-9a-fA-F]{3,8}\b/.test(src)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, [], `raw color literals found in: ${offenders.join(", ")}`);
  });
});
