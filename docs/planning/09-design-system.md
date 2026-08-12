# 09. Design System: `packages/ui`, Tokens, and the Shared Application Shell

Scope: the design system for hyperbolic-core V1: the `packages/ui` workspace package decided in ADR-01, the component library and styling decision (forced decision 8), the token set, the shared chrome and interaction primitives the Shell and zones consume (05-a sections 3, 5, 7), the accessibility and performance baselines, and the Agentic Command Center (ACC) run/chat surface specification that `07-brain-architecture.md`'s transport will feed. Names per `00-canonical-names.md`. Labels: `[VERIFIED: <path or command>]`, `[INFERRED: <reasoning>]`, `[UNKNOWN]`.

Style contract compliance: planning only. This artifact contains token tables, CSS variable name skeletons, TypeScript type signatures, directory trees, and interaction rules. It contains zero component implementations.

## 1. Current state summary

- No shared design system exists. `packages/` does not exist yet; it is an ADR-01 addition [VERIFIED: 04-adrs.md target tree; no `packages/` directory at repo root].
- ACC ships a small, modern component stack: React 19, Vite 8, Tailwind 4, `@base-ui/react` 1.7 headless primitives, `class-variance-authority` (CVA), `clsx` + `tailwind-merge` (`cn` helper), `lucide-react` icons, `@fontsource-variable/geist`, TanStack Query 5, react-router 8 [VERIFIED: apps/agentic-command-center/ui/package.json].
- ACC's components follow the shadcn-style copy-in idiom (owned source, `data-slot` attributes, `cn`, CVA variants) built on Base UI primitives: seven files, 248 LOC total (badge, button, card, input, label, radio-group, textarea) [VERIFIED: ls + wc -l apps/agentic-command-center/ui/src/components/ui/; button.tsx imports `@base-ui/react/button` and `cva`; radio-group.tsx imports `@base-ui/react/radio-group`].
- ACC already defines a token layer: shadcn-convention CSS variables in oklch (`--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--border`, `--ring`, `--radius`) mapped into Tailwind via `@theme inline`, with a `.dark` class variant and an OS-preference default persisted in `localStorage.theme` [VERIFIED: ui/src/index.css; ui/src/main.tsx:18-32]. The palette is a neutral gray ramp with one destructive red [VERIFIED: index.css values; INFERRED: values match the shadcn/ui default neutral theme].
- ACC's pages already exercise focus-visible ring styling, `aria-invalid` states, and disabled states in the shared CVA bases [VERIFIED: button.tsx, radio-group.tsx class strings].
- LifeOS frontend: React 19.2, react-router 8, TanStack Query 5, Tailwind 4, Supabase client. No component library, no icon library, no token layer: its Tailwind entry is a single `@import "tailwindcss";` line [VERIFIED: apps/lifeos/frontend/package.json; wc -l src/index.css = 1]. Styling is bespoke utility classes per page [INFERRED: no components/ui directory convention and no shared CSS beyond the import].
- LifeOS has no dark mode [INFERRED: no dark variant configuration in index.css and no theme toggle dependency].
- The three Toolbelt tool clients are vanilla HTML and out of design-system scope until their Shell surfaces are built per 05-c, 05-d, 05-h [VERIFIED: 01-inventory.md via 05-a section 1].

Summary: one app already runs the exact stack a shared package would standardize; the other app has nothing to displace. That asymmetry drives Section 2.

## 2. Component library and styling decision (forced decision 8)

### Options

| Option | Description |
| --- | --- |
| A | Promote ACC's current stack to `packages/ui`: Base UI headless primitives + Tailwind 4 tokens + CVA-variant owned components, hand-curated in one package |
| B | shadcn/ui-style registry copy-in per app (components copied into each consuming app from the shadcn registry, Radix or Base UI flavor) |
| C | Full component kit (Mantine or MUI) |
| D | Tailwind-only bespoke everywhere (LifeOS's current mode, generalized) |

### Scoring

Criteria: fit at single-operator scale, migration cost for each existing app, bundle size, accessibility baseline provided by the library, LOC the repo must own. `+` good, `0` neutral, `-` bad.

| Criterion | A: Base UI + Tailwind + CVA in packages/ui | B: registry copy-in per app | C: Mantine/MUI | D: Tailwind bespoke |
| --- | --- | --- | --- | --- |
| Single-operator scale | + (one curated package, no registry workflow to babysit) | 0 (registry updates are a per-app chore) | - (theme system and API surface sized for teams) | + (nothing to maintain but the pages) |
| ACC migration cost | + (near zero: repoint 7 imports, move 248 LOC) | 0 (re-copy components, re-diff local edits) | - (rewrite all 4 pages' component usage) | - (throw away working primitives) |
| LifeOS migration cost | + (additive; nothing to displace, adopt chrome + tokens only in V1) | + (same) | - (new dependency + restyle) | 0 (status quo, but coherence never arrives) |
| Bundle size | + (headless primitives tree-shake; styling is compiled Tailwind) | + (same runtime shape) | - (kit runtime + theme engine, typically 100 KB+ gz before pages) | + (smallest possible) |
| A11y baseline provided | + (Base UI primitives carry roles, keyboard handling, focus management) | + (same primitives underneath) | + (mature kit a11y) | - (every aria pattern hand-built and hand-audited) |
| LOC owned | 0 (~10 primitives owned, ~550 LOC, but shared once) | - (N apps x copies; drift between copies is the shadcn failure mode at multi-app scale) | + (least owned code) | - (most owned code, duplicated per app) |

### Decision: Option A

Promote ACC's proven stack into `packages/ui` as the single shared library. ACC already ships it in production on the operator machine; LifeOS has no library to displace; the Shell is greenfield and inherits it for free. Option B is rejected because the registry copy-in idiom optimizes for per-project customization, which at three consumers in one monorepo becomes three drifting copies; the shadcn registry remains useful as a one-way source to seed new primitives into `packages/ui`, after which the code is owned and curated there. Option C fails the bundle and migration criteria simultaneously. Option D is what LifeOS's coherence problem looks like already, generalized.

The four named costs of Option A:

| Cost | Statement |
| --- | --- |
| Maturity cost | `@base-ui/react` reached 1.x recently and has a shorter production track record than Radix; minor-version API churn is a live risk. Mitigation: it is already pinned and shipping in ACC's production UI [VERIFIED: package.json ^1.7.0], upgrades are opt-in, and the exposure is confined to ~10 wrapper files in one package. |
| Migration cost | ACC: move 248 LOC of components plus the token CSS into `packages/ui` and repoint imports; roughly a day. LifeOS: zero forced migration in V1 (adopts chrome + tokens per 05-a C-3); the bespoke page restyle to tokens is deferred (Section 9 deletion list). Shell: zero, greenfield. |
| Lock-in | Two layers. Base UI's component API: contained, because apps import `packages/ui` wrappers, never `@base-ui/react` directly (adoption rule 3, Section 8), so swapping the primitive vendor touches ~10 files in one package. Tailwind 4 + CSS custom properties: the deeper commitment, already made independently by both existing apps [VERIFIED: both package.json files], so this decision adds no new lock-in there. |
| Ecosystem gaps | Base UI ships no command palette, no date picker, no data grid, no charts, no toast manager. V1 consequences: the palette is built from Base UI popover/listbox parts plus owned filtering (~200 LOC, already budgeted in 05-a section 5); the toast/notification surface is owned code against the 05-a Section 7 contract (~200 LOC); date picker and data grid are not needed by any V1 surface [INFERRED: no V1 page in 05-a..05-h specifies either]; charts are out of scope for V1. |

Complexity budget: no breach. `packages/ui` is a workspace package inside the existing repo, not a deployable unit, runtime, database, or auth flow [VERIFIED: 04-adrs.md budget dimensions].

### Package shape

```
packages/ui/
  package.json            (name: @hyperbolic/ui; peer deps: react 19, tailwindcss 4)
  styles/
    tokens.css            (Section 3: token definitions, theme blocks, @theme mapping)
  src/
    primitives/           (~10 wrapped Base UI components, CVA variants)
    chrome/               (nav chrome, theme switch, command palette)
    feedback/             (toast surface, empty/error/loading state components)
    chat/                 (ACC/Brain run surface pieces, Section 7; lands with the Brain milestone)
    index.ts              (single public entry; deep imports are a contract violation)
  test/
    contrast.test.mjs     (Section 5: token contrast floors, both themes)
```

## 3. Design tokens

### 3.1 Token architecture and dark mode

Binding rules:

- All color, radius, typography, and motion decisions flow through CSS custom properties defined once in `packages/ui/styles/tokens.css` and mapped into Tailwind utilities via `@theme inline`, the mechanism ACC already uses [VERIFIED: ui/src/index.css @theme block].
- Theme cascade, the standard three-state pattern: bare `:root` defines the complete light palette; `@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])` redefines the dark values; `:root[data-theme="dark"]` redefines them again so an explicit choice wins in both directions. No token may receive its only definition inside a media or `[data-theme]` block.
- The explicit choice is set as `data-theme` on the document element by the shared theme switch component, persisted in `localStorage`, surfaced in the Shell settings page (05-a section 8: light/dark/system). Default with no stored choice: follow the OS.
- Migration note: ACC's current `.dark` class toggle and `@custom-variant dark` [VERIFIED: main.tsx:18-32; index.css] are superseded by `data-theme` when its pages port to the Shell (05-b section 6); until then ACC's local UI keeps its class mechanism unchanged.
- Theme priority rule, both themes mandatory everywhere: dark is the primary design target for operational surfaces (the ACC run/chat surface, transcripts, status strips, dashboards); light is the primary design target for reading-and-forms surfaces (LifeOS zone, settings, Idea Intake). "Primary" means designed and reviewed in that theme first; the other theme is still required to pass every contrast floor in Section 5, enforced by the same contrast test, and visual sign-off covers both.
- Components use semantic tokens only. Raw palette values (`oklch(...)`, hex) in app or component source are a defect, grep-checkable (Section 8).

### 3.2 Color tokens

Values below are reference values in oklch; implementation may tune lightness/chroma within the binding contrast floors (Section 5). Every `text`-role token is contrast-tested against every `bg`/`surface` token it is allowed to sit on, in both themes.

| Token | Role | Light (reference) | Dark (reference) |
| --- | --- | --- | --- |
| `--color-bg` | app background | oklch(1 0 0) | oklch(0.145 0 0) |
| `--color-bg-subtle` | inset/recessed areas, code stream background | oklch(0.97 0 0) | oklch(0.185 0 0) |
| `--color-surface` | cards, panels | oklch(1 0 0) | oklch(0.205 0 0) |
| `--color-surface-raised` | popovers, palette, toasts | oklch(1 0 0) | oklch(0.245 0 0) |
| `--color-overlay` | modal scrim | oklch(0 0 0 / 45%) | oklch(0 0 0 / 60%) |
| `--color-border` | default hairline | oklch(0.922 0 0) | oklch(1 0 0 / 10%) |
| `--color-border-strong` | inputs, emphasized separation | oklch(0.87 0 0) | oklch(1 0 0 / 18%) |
| `--color-text` | primary text | oklch(0.145 0 0) | oklch(0.985 0 0) |
| `--color-text-secondary` | supporting text | oklch(0.44 0 0) | oklch(0.78 0 0) |
| `--color-text-muted` | metadata, timestamps (large/secondary use only) | oklch(0.556 0 0) | oklch(0.708 0 0) |
| `--color-accent` | brand/interactive accent | oklch(0.205 0 0) | oklch(0.922 0 0) |
| `--color-accent-fg` | text on accent | oklch(0.985 0 0) | oklch(0.205 0 0) |
| `--color-accent-muted` | selected/hover fills | oklch(0.97 0 0) | oklch(0.269 0 0) |
| `--color-success` | success text/icon | oklch(0.52 0.15 150) | oklch(0.75 0.16 150) |
| `--color-success-bg` | success fill | oklch(0.96 0.04 150) | oklch(0.28 0.06 150) |
| `--color-warn` | warning text/icon | oklch(0.55 0.13 80) | oklch(0.8 0.14 85) |
| `--color-warn-bg` | warning fill | oklch(0.97 0.05 90) | oklch(0.3 0.06 85) |
| `--color-danger` | destructive text/icon | oklch(0.577 0.245 27) | oklch(0.704 0.191 22) |
| `--color-danger-bg` | destructive fill | oklch(0.97 0.03 27) | oklch(0.3 0.08 25) |
| `--color-info` | informational text/icon | oklch(0.55 0.14 250) | oklch(0.75 0.13 250) |
| `--color-info-bg` | informational fill | oklch(0.96 0.03 250) | oklch(0.29 0.06 250) |
| `--color-ring` | focus ring | oklch(0.708 0 0) | oklch(0.556 0 0) |

Continuity note: ACC's existing shadcn-convention names (`--background`, `--card`, `--muted`, `--primary`, ...) [VERIFIED: index.css] map 1:1 onto this set (`--color-bg`, `--color-surface`, `--color-bg-subtle`/`--color-accent-muted`, `--color-accent`); the promotion into `packages/ui` renames once, at the same time the components move, so there is never a dual-name period in shared code.

### 3.3 Typography

- Sans: Geist Variable, self-hosted via `@fontsource-variable/geist` [VERIFIED: ACC dependency]. It becomes the platform face for all zones.
- Mono: Geist Mono Variable via `@fontsource-variable/geist-mono` (new dependency, same publisher pattern) for code, logs, transcripts, IDs, and streamed tool output; fallback stack `ui-monospace, SFMono-Regular, Menlo, monospace`. Gate question 3 offers the zero-byte alternative.
- Loading: `font-display: swap` plus a metric-compatible local fallback so font arrival causes no layout shift (Section 6).

| Token | Size / line height | Use |
| --- | --- | --- |
| `--text-xs` | 12px / 16px | timestamps, badges, tick labels |
| `--text-sm` | 13px / 18px | dense operational UI: transcript metadata, table cells, status strip |
| `--text-base` | 14px / 21px | body default (matches ACC's current text-sm-dominant density [VERIFIED: page class usage]) |
| `--text-md` | 16px / 24px | reading surfaces (LifeOS zone body) |
| `--text-lg` | 18px / 26px | section headings |
| `--text-xl` | 22px / 28px | page titles |
| `--text-2xl` | 28px / 34px | home/landing headline only |

Weight tokens: `--font-weight-normal` 400, `--font-weight-medium` 500, `--font-weight-semibold` 600. No 700+ in V1; the variable font makes intermediate weights cheap but the scale stays at three stops.

### 3.4 Spacing, radius, elevation, motion

| Group | Tokens | Rule |
| --- | --- | --- |
| Spacing | Tailwind 4 default scale (`--spacing: 0.25rem` base; steps 1, 2, 3, 4, 6, 8, 12, 16 preferred) | no custom spacing tokens; both apps already compose on this scale [VERIFIED: class usage in ACC pages; INFERRED for LifeOS from Tailwind-only styling] |
| Radius | `--radius` 0.625rem base with `--radius-sm` (0.6x), `--radius-md` (0.8x), `--radius-lg` (1x), `--radius-xl` (1.4x), `--radius-full` | inherits ACC's existing multiplier scheme [VERIFIED: index.css @theme radius block] |
| Elevation | `--shadow-0` none; `--shadow-1` card rest; `--shadow-2` popover/palette/dropdown; `--shadow-3` modal | dark theme halves shadow alpha and leans on `--color-surface-raised` + border for depth; shadows never encode meaning, only depth |
| Motion durations | `--duration-fast` 100ms (hover, focus ring); `--duration-base` 180ms (expand/collapse, toast enter); `--duration-slow` 300ms (modal, panel slide) | nothing animates longer than 300ms |
| Motion easings | `--ease-standard` cubic-bezier(0.2, 0, 0, 1); `--ease-exit` cubic-bezier(0.4, 0, 1, 1) | enter decelerates, exit accelerates; no bounce/spring in V1 |
| Reduced motion | `prefers-reduced-motion: reduce` collapses all durations to 0ms except opacity fades capped at 100ms | Section 5 commitment |

### 3.5 CSS variable name skeleton (complete list, definition order)

```
/* color */        --color-bg  --color-bg-subtle  --color-surface  --color-surface-raised
                   --color-overlay  --color-border  --color-border-strong
                   --color-text  --color-text-secondary  --color-text-muted
                   --color-accent  --color-accent-fg  --color-accent-muted
                   --color-success  --color-success-bg  --color-warn  --color-warn-bg
                   --color-danger  --color-danger-bg  --color-info  --color-info-bg
                   --color-ring
/* typography */   --font-sans  --font-mono
                   --text-xs  --text-sm  --text-base  --text-md  --text-lg  --text-xl  --text-2xl
                   --font-weight-normal  --font-weight-medium  --font-weight-semibold
/* shape */        --radius  --radius-sm  --radius-md  --radius-lg  --radius-xl  --radius-full
/* elevation */    --shadow-0  --shadow-1  --shadow-2  --shadow-3
/* motion */       --duration-fast  --duration-base  --duration-slow
                   --ease-standard  --ease-exit
```

## 4. Layout primitives and the shared application shell

### 4.1 Chrome regions

Per 05-a sections 3 and 7, the chrome is a `packages/ui` component rendered by both zones (`ChromeProps` contract, `data-testid="platform-nav"`).

| Region | Placement | Contents | Behavior |
| --- | --- | --- | --- |
| Nav rail | left edge, fixed, 56px collapsed / 220px expanded | zone entries (home, life, acc, tools, prompts, ideas) with icons (lucide-react [VERIFIED: ACC dependency]) and active state from `activeZone` | collapsed by default under 1024px viewport; expansion state persisted locally; entries come from the Section 4 route map of 05-a, tool entries from the Toolbelt registry (TB-2) |
| Topbar | top, 48px | current zone title, command palette trigger, notification bell with unread count, theme switch, session menu (email, sign out) | sticky; never scrolls away; owns the skip-link target order (Section 5) |
| Content | remainder | zone/page content | pages own their internal layout; max reading width 72ch on reading surfaces, full width on operational surfaces |
| Toast stack | bottom right overlay | transient notifications (4.5) | max 3 visible, older collapse into the bell inbox |

### 4.2 Command palette behavior spec (Shell-owned, 05-a section 5)

| Aspect | Specification |
| --- | --- |
| Trigger | Ctrl+K / Cmd+K anywhere, including inside inputs; topbar button as pointer path |
| Scope V1 | navigation only: six route prefixes plus registry-enumerated tools; no actions, no data search, no LLM (05-a non-goals) |
| Matching | case-insensitive substring plus initials match ("nc" hits Network Checker); no fuzzy-ranking dependency |
| Interaction | list keyboard model: Up/Down move, Enter navigates, Escape closes and returns focus to the invoking element; first result preselected |
| Rendering | `--color-surface-raised`, `--shadow-2`, opens within the 100ms budget (05-a section 10) |
| Cross-zone entries | navigating to another zone is a full document load (ADR-02); the palette labels these entries with the zone name so the transition is expected |

### 4.3 Keyboard model (global shortcuts)

| Shortcut | Action | Scope |
| --- | --- | --- |
| Ctrl/Cmd+K | open command palette | global |
| Escape | close topmost overlay; cancel in-progress inline edit | global |
| g then h / l / a / t / p / i | navigate home / life / acc / tools / prompts / ideas | global, outside text inputs; 800ms chord window |
| Shift+/ | shortcut reference overlay | global, outside text inputs |
| Ctrl/Cmd+Enter | submit the focused composer/form | composer surfaces |
| j / k | move focus down/up the transcript or list | ACC run surface, list surfaces; roving tabindex |
| o or Enter | expand/collapse the focused transcript block | ACC run surface |
| y / n | approve / reject the focused approval card | ACC run surface (Section 7.4) |
| d | toggle the diff/evidence panel in the focused approval card | ACC run surface |

Focus conventions, binding: visible `--color-ring` treatment on `:focus-visible` for every interactive element (already the ACC idiom [VERIFIED: button.tsx focus-visible classes]); modal and palette focus is trapped and returned on close; a skip link is the first tab stop in the chrome; single-character shortcuts are suppressed whenever focus is inside a text input.

### 4.4 Empty, loading, and error states

| State class | Rule |
| --- | --- |
| Empty | every list/collection surface ships a designed empty state: icon, one sentence naming what will appear here, and the single primary action that creates the first item (or a link-out when creation lives elsewhere). Bare "No data" text is a defect. |
| Loading, skeleton | skeleton placeholders for any region whose layout is known before data arrives (cards, tables, transcript history). Skeletons appear only after a 200ms delay to prevent flash on fast loads, and match final layout dimensions so completion causes zero shift. |
| Loading, spinner | spinners only for indeterminate inline operations tied to a control (button pending state, palette search). Never a full-page spinner where a skeleton is possible; never both at once. |
| Error, inline | mutation and validation failures render adjacent to the triggering control with `--color-danger` text and the failing action retryable in place; ACC's existing `ApiError` idiom generalizes [VERIFIED: pages import components/api-error]. |
| Error, page-level | route data completely failed: full-content error state with the cause summary, a retry action, and the chrome still rendered (navigation must never be lost to an error). |
| Error, toast | failures of background/async work not tied to a visible surface (notification delivery, stream reconnect exhausted). A toast never carries the only copy of an error: it links to where the error lives. |

### 4.5 Toast and notification spec

Implements the 05-a Section 7 `NotificationSurface` contract; this section adds the presentation rules.

| Aspect | Specification |
| --- | --- |
| Transport | in-memory within a document; `BroadcastChannel("platform-notifications")` across zones, per 05-a [VERIFIED: 05-a section 7 transport paragraph]; the Brain's run events (BR-4) arrive through the same contract |
| Anatomy | level icon + title (required) + body (optional, 2-line clamp) + optional same-origin link + dismiss |
| Levels | `info`, `success`, `warning`, `error` mapped to the Section 3 semantic tokens |
| Duration | success/info auto-dismiss 5s; warning 8s; error persists until dismissed; hover/focus pauses the timer |
| Stack | max 3 visible, newest on top; overflow collapses into the bell inbox with unread count |
| Interruption budget | toasts never steal focus; screen-reader announcement via a polite live region; an error toast may not be the only signal for an operation the operator explicitly triggered (that gets an inline error too) |
| Persistence | none in V1 (session-ephemeral, 05-a gate question 3) |

## 5. Accessibility baseline (WCAG 2.1 AA, checkable commitments)

| Commitment | Enforcement |
| --- | --- |
| Focus visible everywhere | every interactive `packages/ui` primitive carries the `:focus-visible` ring treatment in its base variant; a Playwright spec tab-walks each Shell route asserting a visible focus indicator on every stop |
| Text contrast 4.5:1 (3:1 for large text and non-text UI) | enforced at the token layer: `packages/ui/test/contrast.test.mjs` computes contrast for every permitted text-on-background token pair in both themes and fails under the floor; `--color-text-muted` is restricted to 12px+ secondary metadata and must still clear 4.5:1 on `--color-bg` and `--color-surface` |
| Full keyboard reachability | every action reachable per the Section 4.3 model; the approval flow is explicitly keyboard-complete (Section 7.4); e2e specs drive the palette, approval, and composer flows keyboard-only |
| Reduced motion | `prefers-reduced-motion` collapses durations per Section 3.4; autoscroll becomes instant positioning; the streaming caret does not blink; verified by an e2e spec running with the preference emulated |
| Zoom/reflow | 200% zoom loses no content or function; the chrome collapses to the narrow layout instead of clipping |

Aria responsibility split:

- Delegated to Base UI primitives: roles, state attributes, focus management, and keyboard behavior for the composed widgets (dialog focus trap and restore, radio group roving tabindex, popover/listbox semantics for the palette, switch/checkbox states) [INFERRED: Base UI is a headless accessibility-focused primitive library; ACC's shipped primitives already surface `aria-invalid`, checked, and disabled states through it, per component source].
- Pages and product code must still supply: accessible names and labels (every input labeled, every icon-only button `aria-label`ed, the ACC theme toggle already models this [VERIFIED: main.tsx aria-label="toggle theme"]), heading hierarchy per page, live-region wiring for streams and toasts, table headers, and the empty/error state semantics of Section 4.4.
- Streaming-specific rule: the transcript container is `role="log"`; announcements happen per completed message or state change, never per token; approval requests raise an assertive announcement since they block progress.

## 6. Performance budgets

Measured from a tailnet browser at the gateway, consistent with 05-a section 10; enforced by a size-check script over build output and the Playwright perf specs.

| Budget | Ceiling | Verification |
| --- | --- | --- |
| Shell initial JS (entry + shared chunks to first render) | 250 KB gz | size script in CI over `apps/shell/dist` |
| Any route chunk | 100 KB gz | same script |
| `packages/ui` contribution to any consumer | 60 KB gz | size script over a probe build importing the full public entry |
| Fonts (Geist sans + mono, woff2, subset) | 130 KB total, `font-display: swap`, metric fallback, zero CLS from font arrival | size script + perf spec CLS assertion |
| Time-to-interactive, Shell cold cache | 2.0 s | inherited from 05-a (Playwright trace timing) |
| LifeOS zone initial JS | same 250 KB gz ceiling | size script in the standalone repo pipeline (05-e owns wiring) |

Streaming render behavior for the ACC/Brain chat surface (behavioral spec, not code):

- Progressive token rendering: stream events append into the active message; DOM writes are coalesced to at most one flush per animation frame regardless of event arrival rate.
- Zero layout shift: the transcript is bottom-anchored; content above the viewport never moves when new content arrives; streaming blocks grow downward only; collapsed tool blocks reserve their summary-row height before content lands. Target CLS 0 on the run surface, asserted in the perf spec.
- Autoscroll contract: pinned-to-bottom while the operator is at the bottom; any upward scroll unpins; a "jump to latest" affordance appears with the count of unseen messages; reduced motion makes the jump instant.
- Virtualization: above 200 rendered transcript items the list virtualizes (windowed rendering with stable measured heights); collapsed tool blocks render only their summary row until expanded; expanded raw output above 500 lines renders tail-first with an explicit "load earlier output" step.

## 7. ACC interaction model: the run/chat surface

The heaviest design-system load. ACC's four current pages port mechanically (05-b section 6); the new surface below is the Brain-facing run/chat interface, consuming the typed event stream that `07-brain-architecture.md` owns. The seam, stated once: an SSE or WebSocket stream of typed events (07's transport decision); this artifact specifies only the client-side consumption shape and the rendering behavior. Event names below are the UI's expectation and yield to 07's authoritative schema.

```ts
// Consumption contract expectation (authoritative schema in 07)
type RunEvent =
  | { type: "message_start"; runId: string; messageId: string; role: "operator" | "agent" | "system" }
  | { type: "token"; runId: string; messageId: string; text: string }
  | { type: "message_end"; runId: string; messageId: string }
  | { type: "tool_call"; runId: string; callId: string; phase: "start" | "result";
      tool: string; summary: string; detail?: string; ok?: boolean; durationMs?: number }
  | { type: "approval_request"; runId: string; approvalId: string; title: string;
      evidence: { kind: "diff" | "command" | "text"; body: string }; expiresAt?: string }
  | { type: "approval_resolved"; runId: string; approvalId: string; resolution: "approved" | "rejected" | "expired" }
  | { type: "run_state"; runId: string; state: "queued" | "running" | "awaiting_approval" | "done" | "failed" | "stopped" }
  | { type: "cost"; runId: string; deltaUsd: number; totalUsd: number }
  | { type: "error"; runId: string; message: string; fatal: boolean };
```

### 7.1 Surface anatomy

| Region | Placement | Contents |
| --- | --- | --- |
| Run tree / task panel | left panel, collapsible | hierarchy: directive, then runs, then tasks; per node a status glyph (queued/running/awaiting approval/done/failed/stopped), title, relative time; selecting a node focuses its transcript; keyboard j/k + Enter |
| Transcript | center, dominant | message groups by role; streaming agent messages; tool-call blocks; approval cards inline at their point in the flow; day/run separators |
| Composer | bottom of center column, sticky | multiline input (grows to 8 lines then scrolls), target/profile selector (mirrors StartWork's existing directive fields [VERIFIED: StartWork.tsx cwd/profile/text state]), send (Ctrl/Cmd+Enter), Stop button replaces Send while a run is active |
| Status/health strip | top of center column, 32px | stream connection state (live/reconnecting/offline), lane status, harness process state, current run state; each segment click-through to its owning page |
| Cost ticker | right end of the status strip | current run cost and weekly spend; sourced from `cost` events plus ACC's existing `GET /api/process/status` (tier, weekText) [VERIFIED: 05-b section 5 Spending row]; click opens the Spending surface |

### 7.2 Transcript blocks

| Block | Anatomy | States |
| --- | --- | --- |
| Operator message | plain text on `--color-surface`, right-aligned accent edge | sent; sending (optimistic, subdued until acked) |
| Agent message | streamed text, markdown rendered progressively, mono for code spans | streaming (caret), complete, error-terminated (danger edge + inline error) |
| Tool-call block | collapsed summary row: status icon, tool name, one-line summary, duration; expanded: monospace detail (args/result), tail-first over 500 lines | running (spinner in row), ok, failed (auto-expands), collapsed/expanded |
| System/event row | single muted line (run started, lane acquired, reconnected) | none |
| Approval card | Section 7.4 | pending, approved, rejected, expired |

### 7.3 Interaction rules

- One active composer target at a time; switching run-tree selection while a send is pending requires confirmation.
- Collapsed-by-default tool blocks; a failed tool call auto-expands. Expansion state is per block, remembered for the session.
- Stop is a first-class action: visible whenever `run_state` is running, keyboard-reachable, and always enabled (never blocked behind a pending mutation).
- Disconnect behavior: `reconnecting` shows in the status strip with backoff count; the transcript becomes visibly read-only (composer disabled with reason) after 10 s offline; on reconnect the client requests replay from its last event id (seam requirement on 07's transport: resumable stream with event ids).
- Every id (run, directive, call) renders in `--font-mono` with click-to-copy, matching ACC's existing id styling idiom [VERIFIED: StartWork.tsx font-mono id span].

### 7.4 Approval interaction pattern (keyboard-first, evidence-explicit)

| Element | Rule |
| --- | --- |
| Placement | inline card in the transcript at the point the run blocked; the run tree node and status strip flip to awaiting approval; an assertive live-region announcement fires; a notification publishes through the 05-a surface so other zones see it |
| Anatomy | title stating the requested action in one sentence; evidence panel (rendered diff for file changes, command + cwd for executions, text otherwise); scope line naming the target repo/path; expiry countdown when `expiresAt` present |
| Evidence gate | the Approve control is disabled until the evidence panel has been rendered on screen at least once (expanded by default under 40 diff lines, explicit `d` toggle above); approving unseen evidence is structurally impossible |
| Keyboard | with the card focused: `d` toggles evidence, `y` approves, `n` rejects with an optional one-line reason prompt; Tab order is evidence, reject, approve |
| Resolution | resolved cards persist in the transcript, collapsed, stamped with the resolution and timestamp; expiry renders as expired-rejected |
| Safety | no default-focused approve button, no Enter-to-approve from the composer, no approval inside a toast; approvals live only in the transcript |

## 8. Adoption rule for a new sub-app surface

Friction metric: steps from empty page to on-system surface. Target and rule: 3 steps, enumerated.

| Step | Action | Done when |
| --- | --- | --- |
| 1 | add `@hyperbolic/ui` (workspace dependency) and import its stylesheet entry in the app/zone entry file | tokens and primitives resolve |
| 2 | wrap routes in the exported shell layout (`ChromeProps` per 05-a section 7) | `data-testid="platform-nav"` renders, SH-1 style check passes |
| 3 | build pages with tokens and primitives only | `grep -rn "oklch(\|#[0-9a-fA-F]\{3,8\}\b" <app>/src --include='*.tsx' --include='*.css'` returns zero hits outside `packages/ui/styles` |

Anything requiring a fourth step (theme bootstrapping, font wiring, focus styling, toast wiring) belongs inside `packages/ui`, not in the consuming app; a fourth step appearing in practice is a design-system defect.

## 9. LOC estimate, deletion list, latency budgets

### 9.1 `packages/ui` V1 LOC estimate

Revises the placeholder ~250 line item in 05-a section 14 (which covered tokens + chrome only) now that primitives and chat pieces are specified; 05-a's Shell totals otherwise stand.

| Bucket | Est. LOC | Timing |
| --- | --- | --- |
| `styles/tokens.css` + theme blocks + `@theme` mapping | 250 | V1 core |
| Contrast test + size-check script | 150 | V1 core |
| ~10 primitives (button, badge, card, input, label, textarea, radio-group, select, dialog, tabs; seeded from ACC's 248 LOC seven [VERIFIED: wc -l]) | 550 | V1 core |
| Chrome (nav rail, topbar, theme switch) | 300 | V1 core |
| Command palette | 200 | V1 core (cuttable per 05-a gate question 1) |
| Toast/notification surface (05-a C-4 contract) | 200 | V1 core |
| Empty/loading/error state components | 150 | V1 core |
| Chat surface pieces (transcript, message blocks, tool block, approval card, composer, status strip, cost ticker, virtualization wiring) | 900 | with the Brain milestone (07), not Shell day one |
| Total | ~2,700 | ~1,800 V1 core + ~900 Brain-gated |

### 9.2 Deletion list

| Item | LOC | Timing |
| --- | --- | --- |
| ACC `ui/src/components/ui/*` and the token block of `ui/src/index.css` | ~330 [VERIFIED: 248 + ~80] | deferred: superseded at absorption, already inside 05-b's ~1,900 `ui/` deletion; not double-counted here |
| ACC `.dark` class toggle logic in `ui/src/main.tsx` | ~15 | deferred: same absorption event |
| LifeOS bespoke duplicated styles (page-local button/card/badge patterns re-expressed on `packages/ui`) | [UNKNOWN] until a styling audit of the LifeOS pages; expected low hundreds | deferred: post-V1, marked explicitly as deferred; V1 requires only chrome + tokens adoption (05-a C-3) |

### 9.3 Latency budgets (design-system-owned paths; complements 05-a section 10)

| Path | Budget | Verification |
| --- | --- | --- |
| Theme switch applied (data-theme flip, both zones) | 50 ms, no unstyled flash | perf spec |
| Command palette open to interactive | 100 ms (inherits 05-a) | palette spec |
| First streamed token painted after event arrival in the client | 50 ms | run-surface perf spec |
| Streaming append scripting cost per frame at full token rate | 8 ms (60 fps held) | perf trace |
| Transcript scroll at 1,000 virtualized items | no frame over 32 ms | perf trace |
| Approval card interactive after `approval_request` arrival | 200 ms | run-surface spec |
| Toast visible after publish (same document and cross-zone BroadcastChannel) | 100 ms | notification spec |

## Gate questions (batched, non-blocking)

1. Theme rule: the default with no stored choice follows the OS, with dark as the design-primary theme for operational surfaces and light for reading surfaces. If the operator instead wants a single forced default (for example dark everywhere), it is a one-line change in the theme bootstrap; decide before the tokens issue is cut.
2. `packages/ui` scope revision: this artifact grows the 05-a placeholder (~250 LOC) to ~1,800 V1-core LOC plus ~900 Brain-gated chat LOC. Confirm the chat bucket tracks the Brain milestone (07) rather than Shell day one; if pulled into V1 day one it displaces the command palette and the LifeOS chrome adoption in sequencing.
3. Mono font: the plan adds `@fontsource-variable/geist-mono` (~40-60 KB inside the 130 KB font budget). The zero-byte alternative is the `ui-monospace` system stack; confirm the addition or take the system stack.

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS (token tables, CSS variable names, type signatures, anatomy tables, directory trees only)
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: PASS (Section 2, all four named for the chosen option)
- Machine-verifiable acceptance criteria: PASS (contrast test, size-check script, grep rules, and named Playwright specs per budget)
- LOC delta reported: PASS (Section 9.1, with the 05-a reconciliation stated)
- Deletion list present: PASS (Section 9.2, deferred items marked)
- Latency budgets: PASS (Sections 6 and 9.3)
- Questions batched: PASS (3, non-blocking)
- Zero em dashes: PASS
- Complexity budget breaches: none (`packages/ui` is a workspace package, not a deployable unit, runtime, database, or auth flow)
