# @hyperbolic/ui

Shared design tokens, primitives, and state components for every
hyperbolic-core zone (`docs/planning/09-design-system.md`).

TypeScript, React 19, Tailwind CSS 4 (both peer dependencies). Built with
Vite (`vite build` + `tsc --emitDeclarationOnly`); consumers import compiled
output from `dist/`, not source.

## Usage

Deep imports into `@hyperbolic/ui/primitives/*`, `@hyperbolic/ui/feedback/*`,
or any other package-internal path are a contract violation — consume the
package only through its single public entry:

```ts
import { Button, Dialog, EmptyState, Chrome } from "@hyperbolic/ui";
```

Styles are a separate, explicit import (design-system adoption rule 1,
`docs/planning/09-design-system.md` section 8). A consuming app's CSS entry
must, in this order:

```css
@import "tailwindcss";
@import "@hyperbolic/ui/styles/tokens.css";
```

`tokens.css` is the single source of truth for color, typography, shape,
elevation, and motion, cascaded across three tiers (light default, OS
`prefers-color-scheme`, explicit `data-theme` override — see the file's own
header comment for the binding cascade order). It also carries an `@source`
directive so a consuming app's Tailwind build scans this package's
primitives for utility classes automatically.

## What it exports

- **Primitives** — `Button`, `Badge`, `Card`/`CardHeader`/`CardTitle`/
  `CardContent`, `Input`, `Label`, `RadioGroup`/`RadioGroupItem`, `Textarea`,
  `Select`/`SelectItem`, `Dialog` (+ subcomponents), `Tabs` (+ subcomponents).
- **Chrome** — `Chrome`, `ThemeSwitch` (+ `applyThemeChoice`/`useThemeChoice`),
  `paletteMatch`: the app shell chrome shared across zones.
- **Feedback** — `EmptyState`, `Skeleton` (+ `useDelayedVisible`), `Spinner`,
  `InlineError`, `ErrorState`.
- **Notifications** — `getNotificationSurface`/`createNotificationSurface`
  (a singleton a zone publishes through; Chrome renders the toast stack and
  bell inbox itself) and the `NotificationSurface` contract types.
- **Chat** — the Brain run/chat surface primitives: `RunId`,
  `OperatorMessage`/`AgentMessage`/`ToolCallBlock`/`SystemRow`,
  `ApprovalCard` (+ the pure `approval-machine` state/reducer functions),
  `Composer`, `StatusStrip`, `CostTicker`, `Transcript`, plus pure
  streaming/virtualization helpers (`stream-buffer`, `virtualize`,
  `autoscroll`). Page wiring and SSE consumption live in the consuming app;
  this package ships only the presentational pieces and their pure logic.
- `cn` — the shared `clsx` + `tailwind-merge` class-name helper.

## Layout

```
src/index.ts          single public entry — everything above is re-exported here
src/primitives/        base UI primitives (button, dialog, tabs, ...)
src/chrome/             app shell: Chrome, nav rail, topbar, command palette, theme
src/feedback/           empty/error/loading states
src/notifications/      toast stack, notification bell, publish surface
src/chat/               Brain run/chat presentational components + pure logic
src/lib/cn.ts           class-name merge helper
styles/tokens.css       design tokens (see Usage above)
test/                   node --test suite + size-check.mjs (bundle budget)
```

## Documentation

- `docs/planning/09-design-system.md` specifies the token cascade (section
  3), adoption rules (section 8), and the chat surface component set
  (section 7).
- `apps/agentic-command-center/AGENTS.md` documents a known drift: ACC's
  `frontend/src/components/ui/` reimplements seven of this package's
  primitives independently (different tokens, different class names) rather
  than consuming it, because `frontend/` is a standalone npm project, not a
  workspace member. Do not assume this package is ACC's UI source of truth.
