Title: FEAT(ui): design tokens, theme cascade, and contrast gate
Type: FEAT
Component: hyperbolic-core
Milestone: M1 Platform foundations
Depends on: m1-01-chore-platform-workspace-setup.md
Blocks: m1-04-feat-ui-primitives.md, m2-01-feat-ui-chrome-palette.md

## Problem
No shared design system exists; LifeOS has a one-line CSS entry and ACC carries its own token block (09-design-system.md section 1). 09 section 3 defines the complete token set, the three-state theme cascade, and the contrast floors that must be enforced at the token layer.

## Scope
In scope:
- packages/ui/styles/tokens.css with every token named in 09 section 3.5, light values on bare :root, dark under the media guard and the data-theme block
- packages/ui/test/contrast.test.mjs and the bundle size-check script (09 sections 5 and 6)
Out of scope:
- Components (m1-04), chrome (m2-01), chat pieces (m4-15)

## Acceptance criteria
The system shall define every token listed in 09 section 3.5 on bare :root, with dark redefinitions present in both the prefers-color-scheme guard and the data-theme block.
When the contrast test runs, every permitted text-on-background token pair shall meet 4.5:1 (3:1 for large text and non-text UI) in both themes.
When a probe build imports the full public entry, the packages/ui contribution shall be at most 60 KB gzipped.

## Verification
node --test packages/ui/test/contrast.test.mjs
node packages/ui/test/size-check.mjs (exits non-zero above 60 KB gz)
grep -c ":root\[data-theme=\"dark\"\]" packages/ui/styles/tokens.css returns at least 1

## Estimated LOC delta
Added: 400  Deleted: 0  Net: +400

## Risk
Low; token values are reference values tunable within the tested contrast floors.
