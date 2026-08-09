# gui/ — the web Command Center

`node gui/server.mjs --port 43117` (or `npm run gui`) serves the control panel
on `http://127.0.0.1:43117`. Pages: `/` and `/kernel.html` (kernel settings),
`/guards` (guards, vault, runbox, spending, start-work). Loopback only.

**External UI (ADR-0006, SPEC-0006):** add `--ui-dist <path>` (or `ACC_UI_DIST`)
pointing at the `agentic-command-center-ui` repo's built `dist/` and `/` plus
every non-API GET serve that app same-origin (SPA fallback to its index;
resolved-path containment, no URL decoding — traversal shapes cannot escape
the dist). The built-in pages stay at `/guards` and `/kernel.html` until the
ADR-0006 parity criterion retires them.

**This file is the API contract.** The external UI repo
(`agentic-command-center-ui`, ADR-0006) builds against exactly what is written
here; any route change lands in the same commit as its edit to this file.

## Security model (all routes)

- Binds `127.0.0.1` only. `Host` must be local, `Origin` absent or local — otherwise 403.
- Every POST demands the header `X-ACC: 1`, enforced once globally in the handler (unsettable cross-origin without a CORS grant this server never issues) — an unknown POST without it is 403, not 404. No CORS header ever leaves.
- Bodies are JSON, capped at 64 KiB (over-cap connections are destroyed unparsed).
- The server holds zero business logic: it shells the real owners (`hooks/engine.mjs`, `hooks/budget.mjs`, `hooks/usage.mjs`, `hooks/route.mjs`, `hooks/directive.mjs`, `hooks/lane.mjs`, `runner/runner.mjs`, `kernel/policy.mjs`) via `execFile` — never a shell, never a browser string as a path or flag.
- Directive ids match `/^d-[A-Za-z0-9_-]{1,38}$/` and are validated **before** any path is built from one.

## Error envelope

Non-2xx responses are `{"error": "<message>"}`. Routes that surface a child
process's outcome return 200 with `{"code": <exit>, "out": "<tail>"}` — a
non-zero engine exit is a result, not a transport error.

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
| GET | `/api/directives` | — | active directives, each decorated with `running` (live runner pid-file check) |
| POST | `/api/directives` | `{text 1..32768, doneWhen? single-line 1..500, cwd absolute+existing, profile ∈ policy profiles or "", wallClockMin?, turns?, tokens?, dollars?}` — numeric ceiling fields are non-negative, `0`/omitted = unlimited | the created directive JSON; text travels via a temp file so newlines survive byte-exact |
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
| `ACC_ENGINE` / `ACC_USAGE` / `ACC_BUDGET` / `ACC_RUNNER` | the shelled script for each owner (fakes in tests; `ACC_RUNNER` is what `/api/launch` spawns) |
| `ACC_DIRECTIVES_DIR` | directive store dir (mirrors `hooks/directive.mjs`) |
| `ACC_ROUTING_MD` | the routing table `route.mjs` reads |
| `ACC_LANE_DIR` | launch-lane state dir |

Tests: `node --test gui/server.test.mjs` (API), `npm run e2e:gui` (Playwright,
single worker — all specs share one sandbox dir).
