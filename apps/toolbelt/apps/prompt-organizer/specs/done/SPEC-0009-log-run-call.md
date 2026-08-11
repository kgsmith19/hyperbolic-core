---
title: Call toolbelt's log_run RPC on copy
spec_id: SPEC-0009-log-run-call
slice: SL-007
status: done
created: 2026-08-07
owner: Kyle
completed: 2026-08-07
traces: [NFR-010]
---

# SPEC-0009: Call toolbelt's log_run RPC on copy

## 1. In one sentence

Every copy that already writes a `prompt.usage` row now also calls `toolbelt`'s `core.log_run` RPC, delivering `NFR-010` without this repo ever writing a schema-qualified statement against `core.*`.

## 2. Why this, why now

`NFR-010` was `blocked` since `SPEC-0008` (2026-08-07): its literal wording requires a `core.run`/`core.cost` write, and this repo's own `CLAUDE.md` forbids writing to any schema but `prompt`. Kyle decided the mechanism directly the same day: `toolbelt` `SPEC-0003` shipped `core.log_run`, a `security definer` RPC any authenticated tool calls through the same REST surface every tool already uses. This spec is the small, second half of that decision — the actual call site in this repo.

## 3. Scope

### 3.1 In scope

- `web/index.html`'s `api()` gains an optional `profile` parameter (default `"prompt"`, unchanged for every existing caller), so it can also call `toolbelt`'s exposed `core` schema
- `web/panel.mjs`'s copy handler measures the `render()` call's own wall-clock time and, after the existing `prompt.usage` write, calls `POST /rest/v1/rpc/log_run` with `p_app_id=prompt-organizer`, `p_kind=render`, `p_wall_clock_ms=<measured>`

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| A new automated test exercising the RPC's own correctness | `toolbelt`'s `T-A-006`/`T-I-009` already prove `core.log_run` creates the right rows and cannot swallow a bad `app_id` — re-asserting that from this repo would duplicate an already-mutation-verified test (`GATE-TEST-JUSTIFIED` J5), same reasoning `SPEC-0008` used for `prompt.usage`'s own click-wiring (AC-013, no automated test) | Covered by the browser drill in section 12, same as `SPEC-0008`'s precedent |
| Measuring `wall_clock_ms` around the clipboard write, not just `render()` | `navigator.clipboard.writeText`'s latency is a browser/OS property, not this application's; `NFR-002`'s own precedent times `render()` specifically, and `NFR-010` asks for the same kind of wall-clock figure | Never — `render()`'s own duration is the correct measurement |
| Logging a rejected render (missing variable, `FR-010`) | `FR-011`'s trigger is "rendered **and copied**"; a rejected render never reaches the clipboard write and never writes a `prompt.usage` row either — this call sits in the same place, same trigger condition | Never; a render that never completes has nothing to log |
| Retrying or queuing a failed `log_run` call | No `AC` demands delivery guarantees beyond what `prompt.usage`'s own write already has (none — `ASM-017`); adding retry logic here without one demanding it is unrequested complexity | A later slice, if dropped runs turn out to matter in practice |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A saved prompt with at least one variable, its render panel open, values filled | The copy control is activated | `toolbelt`'s `core.run` gains one row with `app_id=prompt-organizer, kind=render, status=ok`, and `core.cost` gains one linked row with `wall_clock_ms` equal to the render's own measured duration | NFR-010 |

No failure case: this call site shares `FR-011`'s exact trigger condition, already covering the one real failure path (a rejected render never reaches this code, section 3.2).

## 5. Properties

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-019 (continued from `SPEC-0008`'s local walk; global numbering is `toolbelt`'s, this repo's is per-spec) | All nine kinds: this slice adds one call to an already-proven external RPC (`toolbelt SPEC-0003` PROP-028..036 cover error totality, round-trip, invariant, idempotence, order independence, oracle, metamorphic, conservation, and monotonicity for `log_run` itself). Nothing new to discharge here beyond section 3.2's scope note: this repo's only new claim is "the call happens, with the right arguments, at the right time" — a wiring fact, not a data-shape property, verified by the browser drill. | n/a | n/a | NFR-010 |

## 6. Budget declaration

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~10 (`index.html` ~3, `panel.mjs` ~7) | 300 | within |
| Test LOC | 0 | 200 | within |
| Source files touched | 2 (`index.html`, `panel.mjs`) | 3 | within |
| Test files touched | 0 | 3 | within |
| New tables/columns/endpoints | 0 | — | within |
| New tests | 0 | 8 | within |

## 7. Changes

### 7.1 Application

`web/index.html`'s `api(path, { method, body, profile = "prompt" })` — one added parameter, used only by the new call.

`web/panel.mjs`'s copy handler:
```js
const startedAt = performance.now();
const result = render(prompt.body, values, ids.filter((id) => boxes[id].checked));
const wallClockMs = Math.round(performance.now() - startedAt);
if (!result.ok) { status.textContent = `Missing: ${result.missing.join(", ")}`; return; }
await navigator.clipboard.writeText(result.text);
status.textContent = "Copied!";
await api("usage", { method: "POST", body: { prompt_id: prompt.id, version_no: prompt.currentVersion } });
await api("rpc/log_run", {
  method: "POST",
  profile: "core",
  body: { p_app_id: "prompt-organizer", p_kind: "render", p_wall_clock_ms: wallClockMs },
});
```

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `web/index.html` | edit | `api()` gains `profile` |
| `web/panel.mjs` | edit | The RPC call itself, AC-001 |

## 8. Test plan

No new test rows. `toolbelt T-A-006`/`T-I-009` cover the RPC's own correctness; this slice's only new claim (the call fires, with the right arguments, at the right time) is verified by the Definition of Done's browser drill, same reasoning `SPEC-0008` used for `prompt.usage`'s wiring.

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Accepted by |
|---|---|---|---|---|---|
| RISK-005 | If `toolbelt` ever changes `core.log_run`'s parameter names or removes it, this repo's copy handler breaks silently (no `try`/`catch` around the call, matching `ASM-017`'s existing posture for `prompt.usage`). | low (an RPC is a more stable contract than a raw table shape, by design — that was the whole point of building it as one) | low (the clipboard copy itself, the user-facing action `FR-007` promises, already succeeded before this call; only observability is lost) | Not mitigated with retry/fallback logic — no `AC` demands it (section 3.2) | Kyle |

## 10. Rollback

Revert the `index.html`/`panel.mjs` commit. No data migration involved; `toolbelt`'s RPC is unaffected either way.

## 11. Assumptions made during implementation

| ID | Assumption | Why |
|---|---|---|
| ASM-022 | The `log_run` call runs sequentially after the `prompt.usage` write, not in parallel (`Promise.all`) | Matches the handler's existing sequential style (no `Promise.all` used anywhere else in this file); the two writes are independent but nothing demands the marginal latency saving, and sequential keeps the diff to the shape `ASM-017` already established |
| ASM-023 | `p_kind` is hardcoded to the literal string `"render"` | The only kind of run this application currently produces; a second kind (e.g. a future `FR-013` render-endpoint call) would pass its own literal, not a shared constant with one caller today |

## 12. Definition of Done

- [x] Browser drill, 2026-08-07 (Chromium via the Node-relay technique, clipboard permissions granted): filled the real `Render Drill 1786072869293` fixture's two variables, clicked copy. Clipboard read back exact rendered text, zero console errors. Queried `toolbelt`'s project directly afterward: a new `core.run` row (`app_id=prompt-organizer, kind=render, status=ok`) with a linked `core.cost` row, `wall_clock_ms=0` (a genuine sub-millisecond render, correctly distinct from the `42` hardcoded in `toolbelt`'s own mutation-verification fixtures). `prompt.usage` gained its own new row in the same window, ~75ms apart — both writes fired from the one click.
- [x] Existing suite still passes unmodified: 45/45 green, 5.4s.
- [x] PRD NFR-010 → `done`; SL-007's row updated (v0.1.9); change-log entry.
- [x] Spec moved to `done/`, dates set.
