# gui/ — the web Command Center

`node gui/server.mjs --port 43117` (or `npm run gui`) serves the loopback API
on `http://127.0.0.1:43117`. ACC itself is headless — it has no page of its
own. Add `--ui-dist <path>` (or `ACC_UI_DIST`) pointing at `ui/`'s built
`dist/` (`cd ui && npm run build`) and `/` plus every non-API GET serve that
app same-origin (SPA fallback to its index; resolved-path containment, no URL
decoding — traversal shapes cannot escape the dist). Without `--ui-dist`,
every non-API GET is a 404.

Previously, `/` and `/guards` served built-in plain-HTML pages
(`kernel.html`, `guards.html`) as an incremental migration step while `ui/`
matured. Those pages were retired once `ui/e2e/contract.spec.ts` went green
against a live ACC server for every page it replaced (guards, vault,
spending, start-work, kernel) — the criterion under which they were always
meant to go. `--ui-dist` is now the only way to reach a browser UI.

**This file is the API contract.** `ui/` builds against exactly what is
written here; any route change lands in the same commit as its edit to this
file.

## Security model (all routes)

- Binds `127.0.0.1` only. `Host` must be local, `Origin` absent or local — otherwise 403.
- Every `/api/*` request — GET and POST alike — demands the header `X-ACC-Token: <value>` (ACC-5), compared to the session credential constant-time; see "Session credential" below. Missing or wrong is `401 {"error":"unauthorized"}`, identical whether the route exists or not, so an unauthenticated caller can't use responses to enumerate routes. This is additive: none of the other checks on this list are replaced or weakened by it.
- Every POST demands the header `X-ACC: 1`, enforced once globally in the handler (unsettable cross-origin without a CORS grant this server never issues) — an unknown POST without it is 403, not 404. No CORS header ever leaves.
- Bodies are JSON, capped at 64 KiB (over-cap connections are destroyed unparsed).
- The server holds zero business logic: it shells the real owners (`hooks/engine.mjs`, `hooks/budget.mjs`, `hooks/usage.mjs`, `hooks/route.mjs`, `hooks/directive.mjs`, `hooks/lane.mjs`, `runner/runner.mjs`, `kernel/policy.mjs`) via `execFile` — never a shell, never a browser string as a path or flag.
- Directive ids match `/^d-[A-Za-z0-9_-]{1,38}$/` and are validated **before** any path is built from one.

## Session credential (ACC-5)

Closes SEC-04: every check above is CSRF hygiene, not authentication — any
*other* local process on the machine could already reach this port with no
privilege check at all. `X-ACC-Token` is the actual auth boundary. A shared
secret, not a platform-JWT verification, because ACC makes zero network
calls today and must keep working fully offline on a single-operator
machine — JWKS fetching would be a new network dependency and failure mode
for a loopback socket that has never needed one.

- **Token file**: `<ACC_ROOT>/gui-token` — one line, 32 random bytes
  base64url, created with owner-only permissions (mode `0600`) the first
  time a server starts and finds none. An existing file is loaded verbatim
  and never rewritten. Loaded once at startup and cached in memory for that
  server's life — never re-read per request.
- **Header**: `X-ACC-Token: <value>`, required on every `/api/*` request.
  Compared with `crypto.timingSafeEqual` over a fixed-length SHA-256 digest
  of each side (never a raw comparison), so a mismatched length can neither
  throw nor short-circuit the check.
- **Bootstrap**: on startup the server prints
  `http://127.0.0.1:43117/#acc-token=<value>` to the console once — the one
  intentional place the token is ever printed. `ui/src/api.ts` reads the
  fragment on load, stores it in `sessionStorage`, strips it from the URL
  with `history.replaceState` (so it never lingers in browser history), and
  attaches it as `X-ACC-Token` on every API call after that. A fragment
  never reaches the server (or any server) at all, which is why the token
  travels there instead of a query string.
- **Rotation**: no dedicated mechanism beyond deleting the token file and
  restarting the server — a fresh one is minted on the next start.
- **Env seam**: `ACC_GUI_TOKEN_FILE` redirects the token file path (see the
  env seams table below).
- Out of scope for now (see the ACC-5 issue): CORS / Chrome Private Network
  Access grants. Not needed while the UI stays same-origin loopback; ships
  when the Shell absorbs ACC's UI pages.

## Error envelope

Non-2xx responses are `{"error": "<message>"}` — including the `401` above.
Routes that surface a child process's outcome return 200 with
`{"code": <exit>, "out": "<tail>"}` — a non-zero engine exit is a result, not
a transport error.

## Routes

### Kernel settings
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/kernel-policy` | — | `{kernel: {...}}` (defaults merged) |
| POST | `/api/kernel-policy` | the kernel block | `{ok, kernel}`; 400 names the invalid field, file untouched |

### Guards / runbox (SPEC-0002)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/guards/status` | — | engine `status` JSON: `{enabled, secrets[], protected[], projects[], vaultKeys[], pending, trashed}` |
| GET | `/api/guards/list` | — | `{pending: [...], trashed: [...]}` |
| POST | `/api/guards/engine` | `{verb, arg}` — verb ∈ toggle/secret-add/secret-rm/protected-add/protected-rm/projects-add/projects-rm/run/trash/restore, or `{verb:"flush", confirm:true}` | `{code, out}`; unallowlisted verb / bad arg → 400, engine never invoked |
| POST | `/api/guards/preview` | `{ref}` (resolved only through the engine's own list) | `{content}`; unknown ref → 404 |

### Vault (SPEC-0003 — values travel stdin-only, never argv/response/log)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/guards/vault-import` | `{pairs: [{key, value}]}` — key `/^[A-Za-z_][A-Za-z0-9_]*$/` minus proto names; value single-line ≤8192 | `{stored: [names]}` on success; any bad pair → 400, nothing imported |
| POST | `/api/guards/vault-rm` | `{key}` | `{code, out}` (a name is not a secret) |

### Spending / process (SPEC-0004)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/process/status` | — | `{tier, weekText, dials{softK,hardK,amberTokens,redTokens,maxFinders,allow[]}, profiles[], directiveBudget{wallClockMin,turns,tokens,dollars}, stopped}` |
| POST | `/api/process/dials` | all dials, validated | `{ok}`; bad dial → 400, policy.json byte-untouched; unowned policy blocks always preserved |
| POST | `/api/process/control` | `{action}` ∈ stop/resume/fanout | `{ok...}` or `{code, out}` |

### Launch / directives (SPEC-0005)
| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/api/route/suggest` | `{text}` 1..2000 chars after whitespace-collapse | router verdict `{path, label, score, reason, parent}` or `{path: null, ...}` |
| GET | `/api/directives` | — | active directives, each decorated with `running` (live runner pid-file check), normalized `tags: string[]` (legacy entries without tags return `[]`), and optional `doneWhen` when provided |
| POST | `/api/directives` | `{text 1..32768, doneWhen? single-line 1..500, cwd absolute+existing, profile ∈ policy profiles or "", tags?: string[<=16], wallClockMin?, turns?, tokens?, dollars?}` — each tag must match `^[a-z0-9][a-z0-9_-]{0,31}$` (case-insensitive input is normalized), numeric ceiling fields are non-negative, `0`/omitted = unlimited | the created directive JSON; text travels via a temp file so newlines survive byte-exact; if routing returns a label, that label is normalized and auto-added as a tag |
| POST | `/api/directives/status` | `{id, status ∈ done\|paused, why? single-line ≤500}` | `{code, out}`; `done` archives the directive |
| POST | `/api/directives/note` | `{id, text 1..4000}` | `{code, out}`; appends to the log (never touches status) so the next SessionStart's tail carries it — steer a running directive without restarting it |
| GET | `/api/directives/log?id=` | — | `text/plain` tail (last 16 KiB), falling back to the `done/` archive; bad id shape → 400, unknown id → 404 |
| GET | `/api/lane/status` | — | `{automation: [slots...], breaker: {tripped, count, ...}}` |
| POST | `/api/launch` | `{id}` | `{ok, pid}`; 409 while a live runner loop holds the directive (the runner's own pid-file singleton is the real invariant — exit 6) |

## Env seams (tests / sandboxing)

| Var | Redirects |
|---|---|
| `ACC_POLICY` | `policy.json` path |
| `ACC_ROOT` | repo-root-relative state (stop files, directive store, runner pid files) |
| `ACC_GUI_TOKEN_FILE` | the session-credential token file path (default `<ACC_ROOT>/gui-token`) |
| `ACC_ENGINE` / `ACC_USAGE` / `ACC_BUDGET` / `ACC_RUNNER` | the shelled script for each owner (fakes in tests; `ACC_RUNNER` is what `/api/launch` spawns) |
| `ACC_DIRECTIVES_DIR` | directive store dir (mirrors `hooks/directive.mjs`) |
| `ACC_ROUTING_MD` | the routing table `route.mjs` reads |
| `ACC_LANE_DIR` | launch-lane state dir |

Tests: `node --test gui/server.test.mjs` (API), `cd ui && ACC_DIR=.. npm run e2e`
(Playwright, single worker — all specs share one sandbox dir). The Playwright
contract suite carries the session credential the same way a real browser
does: `contract.spec.ts` reads the token straight from the sandbox server's
own `<ACC_ROOT>/gui-token` file (the test harness already knows that path)
and appends it as a `#acc-token=<value>` fragment on each test's first
`page.goto()`, exactly like the one-time bootstrap link the server prints
for a human. Every test gets a fresh browser context (fresh, empty
`sessionStorage`), so every test's first navigation carries it, not just
the suite's first test.
