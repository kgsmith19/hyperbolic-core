Title: FEAT(ui): promote ACC primitives and state components into packages/ui
Type: FEAT
Component: hyperbolic-core
Milestone: M1 Platform foundations
Depends on: m1-03-feat-ui-tokens.md
Blocks: m2-01-feat-ui-chrome-palette.md, m4-15-feat-ui-chat-primitives.md

## Problem
The Agentic Command Center ships seven proven Base UI + CVA components (248 LOC) that only ACC can use; 09-design-system.md forced decision 8 selects promoting this stack into packages/ui as the single shared library (09 section 2, Option A).

## Scope
In scope:
- Roughly 10 primitives (button, badge, card, input, label, textarea, radio-group, select, dialog, tabs) seeded from ACC's components, per 09 section 2 package shape
- Empty, loading (skeleton and spinner), and error state components per 09 section 4.4
- Single public entry (index.ts); deep imports are a contract violation
Out of scope:
- Deleting ACC's local copies (deferred to UI absorption per 05-b section 6)
- Chrome, palette, toasts, chat pieces (m2-01, m2-05, m4-15)

## Acceptance criteria
Every primitive shall style itself with semantic tokens only: a grep for raw color values in src/ shall return zero hits outside styles/.
Every interactive primitive shall carry the focus-visible ring treatment in its base variant.
Consumers shall be able to import every primitive from the single public entry.

## Verification
grep -rn "oklch(\|#[0-9a-fA-F]\{3,8\}\b" packages/ui/src --include='*.tsx' --include='*.css' returns zero hits
node --test packages/ui/test/ (variant and focus-visible class assertions)
node -e "require('./packages/ui/dist/index.js')" or equivalent build import check exits 0

## Estimated LOC delta
Added: 700  Deleted: 0  Net: +700

## Risk
Low; code is promoted from a production surface, not written fresh.
