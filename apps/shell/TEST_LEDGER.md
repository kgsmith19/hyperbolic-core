# Test Ledger

The Shell's suites. All of them run in the `Shell PR Gate`
(`.github/workflows/shell-ci.yml`) except where noted.

| Suite | Covers | Command |
| --- | --- | --- |
| `src/**/*.test.ts(x)` (25 files) | Route table, page behavior, and every `src/lib/` client and helper. Colocated with the module each one covers. | `npm run test:unit` |
| `e2e/*.spec.ts` (12 files) | The real app in Chromium against a sandboxed server: auth gate, single-session, chrome/palette/theme, tools, ideas, prompts, notifications, the ACC bridge, the Brain run surface, the cost dashboard, and the IdP-down path. | `npm run e2e` |
| `test/size-check.mjs` | The 250 KB gzipped bundle budget. | `npm run size-check` |
| `test/healthz-check.mjs` | The deployed health endpoint. Not a PR gate — it targets a running deployment. | `npm run healthz-check` |

## Parity suites

Two `src/lib/` modules are deliberate ports of Prompt Organizer's browser
sources rather than imports, because importing `packages/llm` would pull three
provider SDKs into the bundle and blow the size budget. Each carries a test
that fuzzes it directly against the original, so a hand-edit to either side
that silently diverges fails a test rather than a code review:

- `src/lib/prompt-render.test.ts` vs `apps/toolbelt/apps/prompt-organizer/web/render.mjs`
- `src/lib/prompt-search.test.ts` vs `apps/toolbelt/apps/prompt-organizer/web/search.mjs`

`packages/llm/tests/prompt-render-parity.test.mjs` proves the same original
against `packages/llm`'s own separate copy.

## Performance budgets

Three specs assert documented p95 budgets rather than correctness. They
measure inside the page (`page.evaluate`) or in-process against a local
fixture server, never across the CDP boundary — a budget measured through
Playwright's own round-trip reports the harness, not the app.

| Budget | Where |
| --- | --- |
| Registry list query, p95 ≤ 200 ms over 50 warm calls | `e2e/tools.spec.ts` |
| Session-ready to nav-painted, p95 ≤ 300 ms | `e2e/tools.spec.ts` |
| Command palette open-to-interactive, p95 ≤ 100 ms | `e2e/palette-and-theme.spec.ts` |
| Theme flip, p95 ≤ 50 ms | `e2e/palette-and-theme.spec.ts` |

## Cross-package coupling

The `Shell PR Gate` also type-checks and unit-tests `packages/platform-client`,
`packages/ui`, `packages/llm`, and `services/llm-handler`. A change in this
app can turn the gate red through any of them.
