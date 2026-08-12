Title: FEAT(ui): shared chrome, theme switch, and command palette
Type: FEAT
Component: hyperbolic-core
Milestone: M2 Shell and auth
Depends on: m1-03-feat-ui-tokens.md, m1-04-feat-ui-primitives.md
Blocks: m2-02-feat-shell-scaffold.md, m2-08-feat-lifeos-shell-integration.md

## Problem
SH-1 requires one navigation chrome across every zone, rendered from a shared component so zone drift is a defect (05-a sections 3 and 7, contract C-3; ADR-02 reversal trigger). No such component exists. The palette and keyboard model are specified in 09-design-system.md sections 4.1 through 4.3.

## Scope
In scope:
- Chrome component in packages/ui implementing the ChromeProps contract of 05-a section 7, nav rail and topbar regions per 09 section 4.1, data-testid platform-nav
- Theme switch persisting data-theme per 09 section 3.1
- Command palette (navigation only) and the global keyboard model per 09 sections 4.2 and 4.3
Out of scope:
- Toast surface (m2-05), chat pieces (m4-15), tool entries from the registry (m3-04 supplies the data)

## Acceptance criteria
When any zone renders the chrome, the nav element shall carry data-testid platform-nav.
When the theme switch flips, data-theme shall apply within 50 ms with no unstyled flash.
When Ctrl+K or Cmd+K is pressed, the palette shall be interactive within 100 ms and shall contain only navigation entries.
While focus is inside a text input, single-character shortcuts shall be suppressed.

## Verification
cd apps/shell && npx playwright test e2e/chrome.spec.ts
Palette perf assertion in the palette spec (100 ms open-to-interactive)
Theme-switch perf spec (50 ms, no flash)
Keyboard-suppression case in the palette spec

## Estimated LOC delta
Added: 500  Deleted: 0  Net: +500

## Risk
Low; palette is the named cuttable item if the milestone runs long (05-a gate question 1).
