# 05-b. Agentic Command Center (non-Brain scope)

Scope: the Agentic Command Center (ACC) at `apps/agentic-command-center/`, excluding everything The Brain adds (that is `07-brain-architecture.md`). This artifact realizes ACC-1 through ACC-5 from `03-v1-definition.md`, maps every open defect to a concrete change, and defines the interface the Shell needs from ACC. Names per `00-canonical-names.md`. Labels: `[VERIFIED: <path or command>]`, `[INFERRED: <reasoning>]`, `[UNKNOWN]`.

## 1. Current state summary

- Health: 551 tests, 549 pass, 0 fail, 2 skipped (Windows-only) [VERIFIED: 01-inventory.md section 6 execution table]. Zero S1 defects [VERIFIED: 02-health-audit.md headline].
- Architecture: loopback server `gui/server.mjs` with zero business logic shells subsystem owners via `execFile`, never a shell; secrets travel stdin only [VERIFIED: 01-inventory.md section 2; acc-report dependency graph]. `gui/README.md` is the API contract [VERIFIED: apps/agentic-command-center/AGENTS.md product map].
- UI: React 19 + Vite 8 + Tailwind 4 SPA with exactly four pages (StartWork, Guards, Spending, Kernel), served same-origin through `--ui-dist` [VERIFIED: ui/src/main.tsx:35-40].
- Open defects in scope here: D-01 (Forgepad half-shipped: tested store, no routes, unreachable HTML, test not in the suite), D-02 (`hooks/usage.mjs` coverage debt behind temporary covgate floors), D-06..D-09 (doc drift: README ghost script and purged docs, policy.json deleted-ADR citation, runner README stale paths and `guard.mjs` references, project.yaml stale ci pointer) [VERIFIED: 02-health-audit.md defect register].
- Security findings in scope: SEC-01 (vault stores secret values as plaintext JSON at `<ACC_ROOT>/vault.json`, filesystem-only protection) and SEC-04 (loopback API has no authentication; the `X-ACC: 1` header is CSRF hygiene, not auth) [VERIFIED: 02-health-audit.md security table; gui/README.md security model].
- ACC makes zero network calls and holds zero LLM API keys; the `claude` CLI is its only AI surface [VERIFIED: 01-inventory.md section 2 key edges].

## 2. V1 target state

ACC stays an operator-machine loopback product in V1 (ADR-06: nothing reaches the operator machine from the network). Changes are: close the defect register, demote the vault per ADR-05, add a session credential to the loopback API (ACC-5), define the Shell absorption path for its four UI pages, and supersede Forgepad with Idea Intake. The kernel and runner contracts are frozen for non-Brain work (Section 8).

### Fix register (defect ID to concrete change)

| ID | Change | LOC +/- | Value | Verified by |
| --- | --- | --- | --- | --- |
| D-01 | Delete `gui/forgepad.html`, `forgepad/store.mjs`, `forgepad/store.test.mjs` after the one-shot migration to Idea Intake (Section 7) | +0 / -611 [VERIFIED: wc -l totals 313+137+161] | removes a half-shipped subsystem CI never runs; ideas get a real home | ACC-4 rows |
| D-02 | Write the missing `hooks/usage.mjs` tests (week/sessions/check paths beyond the bucket cache), then delete its three floor-override keys and the migration sentences from the `policy.json` tests `_note` | +250 / -12 | covgate floors return to honest defaults; the documented debt sentence in policy.json is retired [VERIFIED: policy.json tests block names usage.mjs as unresolved follow-up] | ACC-2 rows |
| D-06 | README: remove `npm run e2e:gui` and the references to SYSTEM-REQUIREMENTS, DATA-FLOW, `docs/adr/`, specs TEST-LEDGER; also fix the same stale `npm run e2e:gui` line at the bottom of `gui/README.md` [VERIFIED: gui/README.md final paragraph] | +4 / -10 | docs match the tree | ACC-3 grep |
| D-07 | policy.json:100 `_note`: replace the deleted ADR-0003 citation with a pointer to the lane section of `hooks/lane.mjs` itself | +1 / -1 | no ghost references | ACC-3 grep |
| D-08 | runner/README.md: replace stale `C:\code\guards\...` paths with monorepo paths; replace `guard.mjs` references with the Guards extraction pointer; fix the matching comment at runner/runner.mjs:131-133 | +8 / -8 | onboarding docs stop lying | ACC-3 grep |
| D-09 | project.yaml: point `ci:` at the real root workflow `.github/workflows/acc-ci.yml` | +1 / -1 | tooling that reads project.yaml resolves | ACC-3 grep |
| SEC-01 | Vault demotion per ADR-05 (Section 3) | +50 / -0 | API keys structurally cannot re-enter the plaintext vault | Section 9 EARS V-1 |
| SEC-04 | Loopback session credential (Section 4) | +140 / -0 | any-local-process access ends; precondition for Shell absorption | ACC-5 rows |

## 3. Vault demotion (ADR-05)

Target: `vault.json` holds operator-machine convenience values only; API keys live in Infisical and never enter the vault again [VERIFIED: ADR-05 decision text].

- Mechanism, minimal: `hooks/engine.mjs` vault-import gains a denylist of provider key names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) plus the suffix pattern `_API_KEY`. A denied name fails the whole import (matching the existing all-or-nothing import semantics [VERIFIED: gui/README.md vault-import row]) with an error naming Infisical as the home for keys.
- Pattern-suffix scope is deliberate: broader patterns (`TOKEN`, `SECRET`) would break legitimate convenience values; the vault remains for non-key material with filesystem protection, accepted in ADR-05.
- No encryption-at-rest work in V1: ADR-05 chose Infisical for keys rather than hardening the local file; the residual plaintext risk applies only to demoted non-key values.
- One-time sweep: the operator runs `node hooks/engine.mjs vault-keys` (names only [VERIFIED: acc-report secrets section]) and removes any key-shaped names by hand; whether any exist today is machine-local [UNKNOWN].

## 4. Loopback API session credential (realizes ACC-5, closes SEC-04)

### Mechanism choice

| Option | Verdict | Reason |
| --- | --- | --- |
| Shared secret header (chosen) | build | zero network dependencies; ACC currently makes zero network calls [VERIFIED: 01-inventory.md section 2] and stays usable offline; tens of lines in a server that already centralizes request vetting |
| Platform session JWT verification | reject for V1 | requires JWKS fetch from the platform IdP: a new network dependency, a new failure mode when offline, and key-rotation handling, all to protect a loopback socket on a single-operator machine |
| OS-level socket permissions (named pipe / unix socket) | reject | platform-divergent (Windows primary target [VERIFIED: shim/watcher inventory]), larger change than the threat warrants |

### Header contract (extends `gui/README.md`, which remains the API contract)

| Element | Specification |
| --- | --- |
| Token file | `<ACC_ROOT>/gui-token`: one line, 32 random bytes base64url, created with owner-only permissions at first server start if absent |
| Header | `X-ACC-Token: <value>` required on every `/api/*` request, GET and POST alike; compared constant-time |
| Failure | missing or wrong token: `401 {"error":"unauthorized"}`, consistent with the existing error envelope [VERIFIED: gui/README.md error envelope]; no route enumeration difference before auth |
| Retained checks | loopback bind, local Host, Origin absent-or-local, `X-ACC: 1` on POST all stay (defense in depth) [VERIFIED: gui/README.md security model] |
| Browser bootstrap | server startup prints `http://127.0.0.1:43117/#acc-token=<value>` once; the UI reads the fragment (fragments never reach server logs), stores the token in sessionStorage, strips the fragment, and attaches the header in `ui/src/api.ts` |
| Env seam | `ACC_GUI_TOKEN_FILE` redirects the token file for tests, mirroring the existing env-seam table [VERIFIED: gui/README.md env seams] |
| Rotation | delete the file, restart the server |

### Shell relationship

ADR-03 names this the "session credential defined in ADR-03" for ACC; concretely the credential is ACC-local, not the platform JWT, for the offline reason above. When the Shell later absorbs ACC pages (Section 6), the page is served from the tailnet origin while the API stays at `http://127.0.0.1:43117`, which means a cross-origin fetch from a secure context to loopback: ACC must then add an explicit single-origin CORS grant (`ACC_ALLOWED_ORIGIN`) plus the Chrome Private Network Access preflight header, with the token still mandatory. That grant ships with the absorption step, not before [INFERRED: granting CORS before any cross-origin consumer exists only widens the surface].

## 5. Interface contract for the Shell (what the Shell may call)

`gui/README.md` is and remains the contract [VERIFIED: apps/agentic-command-center/AGENTS.md]. Every route below gains the `X-ACC-Token` requirement; no route shapes change.

| Route group | Routes | Shell V1 use |
| --- | --- | --- |
| Guards/runbox | `GET /api/guards/status`, `GET /api/guards/list`, `POST /api/guards/engine`, `POST /api/guards/preview` | absorbed Guards page only |
| Vault | `POST /api/guards/vault-import`, `POST /api/guards/vault-rm` | absorbed Guards page only |
| Spending | `GET /api/process/status`, `POST /api/process/dials`, `POST /api/process/control` | `/acc` status card reads `GET /api/process/status` (tier, weekText, stopped); rest after absorption |
| Launch/directives | `POST /api/route/suggest`, `GET /api/directives`, `POST /api/directives`, `POST /api/directives/status`, `POST /api/directives/note`, `GET /api/directives/log`, `GET /api/lane/status`, `POST /api/launch` | absorbed StartWork page only |
| Kernel | `GET /api/kernel-policy`, `POST /api/kernel-policy` | absorbed Kernel page only |

V1 Shell footprint is exactly one read (`/api/process/status`) for the `/acc` status card, with a link-out to the local ACC UI; the card degrades to "ACC unreachable" when the operator machine is not the browsing machine. Latency budgets: Section 10.

## 6. ACC UI absorption path into the Shell

Preconditions (all before page one): ACC-5 shipped; `ACC_ALLOWED_ORIGIN` CORS + Private Network Access contract added and contract-tested; `packages/ui` chrome available. Then a mechanical port, one page per PR, each page being one file plus its `ui/src/api.ts` slice [VERIFIED: page sizes below]:

| Order | Page | Size today | Why this order |
| --- | --- | --- | --- |
| 1 | StartWork | 146 LOC [VERIFIED: wc -l ui/src/pages/StartWork.tsx] | most-used surface; exercises the widest API slice early |
| 2 | Guards | 142 LOC | vault input handling must preserve the never-persist rule [VERIFIED: ui/AGENTS.md vault rule]; port carefully second, not first |
| 3 | Spending | 101 LOC | read-heavy, low risk |
| 4 | Kernel | 76 LOC | smallest; closes the port |

Per-page step: port the page into `apps/shell/src/pages/acc/`, port the api.ts slice into a Shell-side typed client that adds `X-ACC-Token`, replicate that page's assertions from `ui/e2e/contract.spec.ts` in the Shell e2e suite, then delete the page from `acc/ui`. After page 4: delete `apps/agentic-command-center/ui/` entirely and drop the `--ui-dist` serving mode.

Timing: V1 ships the link-out model (Section 5); the port is a post-V1 mechanical follow-up unless V1 lands early, matching ADR-01's "absorbed by shell over time" [VERIFIED: 04-adrs.md target tree annotation]. The deletion of `ui/` (~1,900 LOC including e2e and config [INFERRED: 465 page LOC + 66 client + main/components/e2e/config]) is therefore listed as deferred, not counted in the V1 net delta.

## 7. Forgepad supersession by Idea Intake (D-01, ACC-4)

Forgepad is a complete, tested, orphaned idea store: JSON files at `<ACC_ROOT>/forgepad/ideas/f-*.json`, states draft/definite/research-needed/rejected, a reserved `githubIssue` field, zero server routes, an unreachable HTML page, and a test file absent from the suite list [VERIFIED: forgepad/store.mjs; acc-report; 02-health-audit.md D-01]. Idea Intake (`05-h`) supersedes it.

### Data migration note (file shape to idea-intake rows)

Source shape per `createIdea` [VERIFIED: forgepad/store.mjs:63-84]: `{id, title, problem, outcome, confidence, notes, state, target, source, created, updated, githubIssue}`.

| Forgepad field | Idea Intake column (names final in `05-h`) | Rule |
| --- | --- | --- |
| `id` (`f-xxxxxxxx`) | `source_ref` | stored as `forgepad:<id>` for provenance and idempotent re-runs |
| `title`, `problem`, `outcome`, `notes` | same-named columns | verbatim |
| `confidence` (low/medium/high) | `confidence` | verbatim |
| `state: draft` | `draft` | direct |
| `state: definite` | `idea` | the "do this" signal maps to the ready state in the draft-to-idea-to-submitted model (II-1) |
| `state: research-needed` | `draft` | notes prefixed `research needed:`; no equivalent state exists in Idea Intake |
| `state: rejected` | not migrated | archived to a local tarball by the migration tool; gate question 2 |
| `target`, `source` | `target`, `source` | verbatim |
| `created` / `updated` | `created_at` / `updated_at` | verbatim ISO timestamps |
| `githubIssue` | `github_issue` | expected null everywhere [INFERRED: promote-to-GitHub was only ever planned in docs/notes/2026-08-09-forgepad-shape.md, never implemented] |

Migration tool (one-shot CLI owned by Idea Intake, usage spec only):

```
node apps/toolbelt/apps/idea-intake/tools/migrate-forgepad.mjs \
  --src <ACC_ROOT>/forgepad/ideas [--dry-run] [--archive <tarball-path>]
```

Idempotent on `source_ref`; `--dry-run` prints the row plan and counts. Success criterion: inserted row count equals source JSON file count minus rejected count (the ACC-4 verification query). Live idea count on the operator machine is [UNKNOWN]; the tool must handle zero files cleanly.

After a verified migration: delete the three Forgepad files (Section 11) and remove the `forgepad` state-directory mention from any surviving docs.

## 8. Runner/kernel boundary statement (reference only)

- The Brain builds on `kernel/` (bounded runs, ledger, autonomy, verifier) and `runner/` (directive loop, lane serialization); it consumes them, it does not fork them [VERIFIED: 00-canonical-names.md Brain definition; 07 owns the details].
- No non-Brain V1 change may alter the kernel contract, adapter interface, ledger format, lane semantics, or runner exit-code protocol beyond what `07-brain-architecture.md` explicitly specifies. The changes in this artifact touch none of those surfaces [INFERRED: Sections 2-7 touch gui/server.mjs, hooks/engine.mjs, hooks/usage.mjs tests, policy.json test floors, docs, and forgepad only].
- Existing kernel security posture (deny-by-default guardhook failing closed, bypassPermissions deliberately behind it, SEC-02) is accepted as designed and revisited only in `07` autonomy levels [VERIFIED: 02-health-audit.md SEC-02 row].

## 9. EARS acceptance criteria (realizing ACC-1..ACC-5)

All commands run from `apps/agentic-command-center/` unless stated. `$ACC_ROOT` is the sandbox state root for the test in question.

| # | Criterion (EARS) | Verification command |
| --- | --- | --- |
| ACC-1 | When the suite and covgate run on the V1 branch, the system shall exit 0 with no floor-override keys added to `policy.json` beyond those present today. | `npm test && npm run covgate; git diff main -- policy.json` shows no added override keys |
| ACC-2a | When `hooks/usage.test.mjs` runs after the D-02 test additions, the system shall pass with `hooks/usage.mjs` meeting the default floors. | `node --test hooks/usage.test.mjs && npm run covgate` after deleting the `hooks/usage.mjs` keys from the three override maps; exit 0 |
| ACC-2b | When policy.json is grepped for usage floor overrides, the system shall return zero hits. | `grep -c 'hooks/usage.mjs' policy.json` returns 0 |
| ACC-3 | When the drift grep runs, the system shall return zero hits across the four drifted files. | `grep -n 'e2e:gui\|SYSTEM-REQUIREMENTS\|DATA-FLOW\|docs/adr\|C:\\\\code\\\\guards' README.md gui/README.md policy.json runner/README.md runner/runner.mjs project.yaml` returns nothing, exit 1 |
| ACC-4a | When the repository is grepped for forgepad after migration, the system shall return zero hits in code and HTML. | `grep -rn forgepad . --include='*.mjs' --include='*.html'` returns nothing |
| ACC-4b | When the migration tool has run, the Idea Intake row count with `source_ref like 'forgepad:%'` shall equal the pre-deletion source file count minus rejected. | migration tool `--dry-run` count recorded, then the `05-h` verification query returns the same number |
| ACC-5a | If a request reaches any `/api/*` route without `X-ACC-Token`, then the server shall respond 401 within 50 ms. | `curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://127.0.0.1:43117/api/guards/status` returns `401` and under 0.05 |
| ACC-5b | When a request presents the token from the token file, the server shall serve the route normally. | `curl -s -o /dev/null -w '%{http_code}' -H "X-ACC-Token: $(cat $ACC_ROOT/gui-token)" http://127.0.0.1:43117/api/guards/status` returns `200` |
| ACC-5c | When the server starts with no token file present, the system shall create one with owner-only permissions before accepting requests. | server test in `gui/server.test.mjs` asserting file existence and mode under a temp `ACC_ROOT` |
| V-1 | When vault-import receives a denylisted key name, the engine shall import nothing and exit non-zero naming Infisical. | `printf 'ANTHROPIC_API_KEY=x\n' | ACC_ROOT=$TMP node hooks/engine.mjs vault-import; test $? -ne 0 && node hooks/engine.mjs vault-keys` shows no such key |

## 10. Latency budgets (new or changed paths)

| Path | Budget | Note |
| --- | --- | --- |
| Token check overhead per authorized `/api/*` request | under 1 ms added p95 | token cached in memory at start; constant-time compare, no per-request I/O |
| Unauthorized request rejection | 401 within 50 ms | loopback; ACC-5a measures it |
| Shell `/acc` status card read (`GET /api/process/status`, browser on operator machine) | 100 ms p95 | existing route shells `hooks/usage.mjs`/budget owners; measured today at loopback speed [INFERRED: subprocess shelling dominates; no measurement exists yet, the Shell perf spec records the baseline] |

## 11. Deletion list and net LOC delta

Deletions (V1, after ACC-4b passes):

| File | LOC |
| --- | --- |
| `apps/agentic-command-center/gui/forgepad.html` | 313 [VERIFIED: wc -l] |
| `apps/agentic-command-center/forgepad/store.mjs` | 137 [VERIFIED: wc -l] |
| `apps/agentic-command-center/forgepad/store.test.mjs` | 161 [VERIFIED: wc -l] |
| Doc drift lines across README.md, gui/README.md, policy.json note sentences, runner/README.md, project.yaml | ~32 |
| Deferred (post-absorption, not counted): `ui/` after all four pages port | ~1,900 |

Net LOC delta (V1, this artifact's scope):

| Direction | Amount |
| --- | --- |
| Added: usage tests (+250), token auth server+tests (+140), vault denylist+tests (+50), doc replacement lines (+14) | ~+454 |
| Deleted: forgepad trio (-611), drift lines (-32) | ~-643 |
| Net | ~-189 |

The migration tool (~+80) is counted in `05-h` where it lives.

## 12. Changes ranked by ROI

| Rank | Change | Value | Cost |
| --- | --- | --- | --- |
| 1 | D-01/ACC-4 Forgepad supersession + deletion | removes a whole orphaned subsystem, net -611 LOC, and gives ideas a live home | migration tool (in `05-h`) + deletions |
| 2 | SEC-04/ACC-5 loopback token | closes the only open access-control gap; unblocks Shell absorption | ~140 LOC |
| 3 | D-06..D-09/ACC-3 doc drift sweep | cheap, permanent, stops onboarding lies | ~46 lines churn |
| 4 | SEC-01 vault denylist | enforces ADR-05 structurally instead of by convention | ~50 LOC |
| 5 | D-02/ACC-2 usage.mjs tests + floor removal | retires the last documented covgate debt; highest cost per defect closed | ~250 LOC of tests |

## Gate questions (batched, non-blocking)

1. Token bootstrap UX: the printed fragment URL is the minimal design; if the operator prefers a paste-into-page flow (no URL handling), it is an equal-cost swap, decide before the ACC-5 issue is cut.
2. Rejected Forgepad ideas: the plan archives them to a local tarball and does not migrate them; confirm, or they migrate with an `archived` marker if `05-h` defines one.
3. Absorption timing: V1 ships link-out plus the `/acc` status card; confirm the four-page port is post-V1 so its CORS/Private Network Access work does not displace V1 items.

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS (header contracts, CLI usage specs, mapping tables only)
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: PASS (Section 4 mechanism table states the rejected options' costs; vault and migration costs inline)
- Machine-verifiable acceptance criteria: PASS (Section 9, one command per row)
- LOC delta reported: PASS (Section 11, added and deleted)
- Deletion list present: PASS (Section 11)
- Latency budgets stated for new paths: PASS (Section 10)
- Questions batched: PASS (3, non-blocking)
- Zero em dashes: PASS
- Complexity budget breaches: none (no new deployable unit, runtime, database, or auth flow; the ACC token is a loopback credential inside the existing ACC unit, not a fourth auth flow at the platform layer [INFERRED: ADR budget counts platform auth flows; ACC stays operator-local])
