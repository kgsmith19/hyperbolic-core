# Architecture

## Overview

netcheck is a local-first network diagnostic that names *which layer* is
breaking an LLM API connection, by correlating multi-layer network probes
against errors already recorded in Claude Code transcripts. Everything runs
against pure-Python-stdlib parsers over captured command output — no pip
dependencies, ever (`AGENTS.md`).

Two diagnosis paths exist side by side, at different weights:

- **`diagnose.py`** — the lightweight, always-on ranker behind `netcheck
  diagnose`. Pattern-matches one sample row at a time against an ordered
  rule table. This is what runs continuously via `netcheck watch`.
- **`diagnostic_engine.py`** — the heavier decision-tree engine with
  historical confidence, regression tracking, and per-layer analysis
  (dual-stack, routing, TLS, buffering) for the 15 canonical hypotheses.
  `diagnose.py` imports and re-exports its top-level functions; `diagnose.py`
  itself stays deliberately small and dependency-light.
- **`all_diagnostics.py`** — a third, independent path: a one-shot sweep
  (`netcheck full-check`) across seven hypothesis-specific modules (Wi-Fi,
  modem, NAT, CGNAT, router, interference, Anthropic status). It does not
  read history or correlate with LLM errors; it answers "what does this
  machine's environment look like right now."

## The core tick (`probes.sample` → `diagnose.culprit`)

Every `netcheck watch`/`probe` tick measures every layer close together and
flattens it into one row, then decides the culprit by reading *across* that
row, outermost layer first:

```
                          one sample row
                                |
                 gw_state == fail? ------------------ yes --> "lan"
                    (gateway/Wi-Fi)                    (Wi-Fi or router link)
                                | no
                 hop_state == fail? ------------------ yes --> "isp"
                (gateway ok, ISP hop dead)                    (ISP's first hop)
                                | no
                inet_state == fail? ------------------ yes --> "internet"
             (ISP hop ok, general internet dead)              (upstream/peering)
                                | no
           dns_router_state == fail? ----- yes --> dns_public_state == fail?
        (router's own resolver failing)              |                |
                                | no                 yes              no
                                |                     v                v
                                |                  "dns"         "router_dns"
                                |            (both resolvers    (only the router's
                                |             down: upstream     resolver failing)
                                |              of the router)
                                v
             tls_state == fail or http_state == fail? -- yes --> "app"
                (everything below is healthy,                (TLS interception,
                 but the endpoint itself isn't)                router DPI, or
                                | no                            the far side)
                                v
                              None
                        (row is healthy)
```

This is `diagnose.culprit()` and `diagnose._RULES`/`_FIXES` verbatim — see
`API.md` for the exact function signatures. `diagnose.rank()` then adds two
more signals on top of per-row culprits: burst-grouped LLM errors
(`diagnose.bursts`) and a Wi-Fi-mode check pulled from the environment scan.

## Module interactions

```
netcheck/__main__.py  (CLI: probe, watch, scan, diagnose, serve, sync, full-check)
   |
   |-- probes.py -------- sample()  ---> one row per tick, every layer
   |-- environ.py ------- scan()    ---> Wi-Fi/driver/event-log/MTU/modem/router snapshot
   |-- llmlog.py -------- scan_all() --> new Claude Code transcript errors since last offset
   |-- store.py --------- add_sample/add_error/add_scan, mirror() to Supabase
   |
   |-- diagnose.py ------ culprit(row), correlate(errors, samples), rank(...)
   |      \-- diagnostic_engine.py  (historical confidence, per-layer analysis,
   |           dual-stack/routing/TLS/buffer helpers, ConfigurationMatrix)
   |
   |-- all_diagnostics.py  (netcheck full-check)
   |      |-- wifi_diagnostics.py        (hypothesis #15, WiFi/DFS)
   |      |-- modem_diagnostics.py       (Phase 16 addition)
   |      |-- nat_diagnostics.py         (Phase 17 addition)
   |      |-- cgnat_diagnostics.py       (Phase 18 addition)
   |      |-- anthropic_diagnostics.py   (Phase 19 addition)
   |      |-- interference_diagnostics.py (Phase 20 addition)
   |      \-- router_diagnostics.py      (Phase 21 addition)
   |
   |-- fix_engine.py ---- recommend_fixes_for_diagnosis(diagnosis)
   |      \-- fix_application.py  (FixApplier: applies to ASUS router / CAX80 modem)
   |             \-- verification_engine.py  (did the fix work?)
   |                    \-- monitoring_engine.py  (did it come back?)
   |
   \-- server.py -------- dashboard_payload() --> ui.html (Alpine.js, offline, no CDN)
```

Everything upstream of `diagnose.py`/`all_diagnostics.py` (probes, environ,
llmlog) is pure parsing plus I/O with no diagnostic logic — this is what
lets `tests/fixtures/` drive nearly the whole suite without touching a real
network.

## Design principles

### Three states, never two
Every probe/check returns `state` ∈ `ok` | `fail` | `unavailable`.
`unavailable` means *we could not measure* (no credentials, no interface, no
binary) and the ranking engine refuses to cite it as evidence — a missing
modem password is not a broken modem. Enforced by `test_environ.py` and
`test_diagnose.py`.

### Parsers are pure functions over text
Anything that parses command output takes a string and returns a dict, so
tests use captured fixtures in `tests/fixtures/` and never shell out. This is
also what makes a new platform backend (see `OPEN-ISSUES.md` #9, macOS)
additive rather than a rewrite.

### Never substring-match transcripts
Error detection in `llmlog.py` keys on the `isApiErrorMessage` flag and
`type: system` error objects. Grepping raw text for `529` or `ECONNRESET`
matches token counts and request IDs — it overcounted this project's real
error total by roughly 200x before `llmlog.py` existed. `test_llmlog.py`
holds the adversarial cases.

### Safe condition evaluation, not `eval()`
`diagnostic_engine.DiagnosticRule.should_run()` evaluates rule conditions
through a small recursive-descent parser (`_safe_eval_condition`), never
Python's `eval()`.

### SQLite is the source of truth
A cloud database cannot record an outage while the outage is happening.
Supabase (`store.mirror`) is an idempotent mirror keyed on `(host, ts)`; a
failed push leaves rows unsynced for retry, never marks them done.

## Hypothesis numbering vs. development-phase numbering

Two numbering schemes coexist in this codebase and answer different
questions — see `TROUBLESHOOTING.md` for the full breakdown:

- **Canonical hypothesis #1-15** — *what* failure mode is this. Defined in
  `all_diagnostics.AllDiagnostics.hypotheses` and
  `tests/test_e2e_faults.py::AcceptanceTest`.
- **Phase 1-23** — *when* it was built, per the git history. Phases 1-14
  built the core engine and the 15th (canonical) hypothesis analyses; Phases
  15-21 added Wi-Fi plus six further diagnostic modules that sit alongside
  the 15, not inside them; Phase 22 unified everything behind `full-check`;
  Phase 23 added end-to-end fault-injection acceptance tests
  (`tests/test_e2e_faults.py`, using `tc netem` where available, skipping
  gracefully where it isn't).

Do not assume a `Phase N` reference and a hypothesis `#N` reference are the
same thing — several module docstrings historically conflated them; this has
been corrected to cite the Phase number instead (see `CONTRIBUTING.md`).

## File structure

```
netcheck/
├── __main__.py                 CLI dispatch
├── probes.py                   per-tick measurement, pure parsers
├── environ.py                  Wi-Fi/driver/event-log/MTU/modem/router snapshot
├── llmlog.py                   Claude Code transcript scraping + classification
├── store.py                    SQLite schema, writes, Supabase mirror
├── schema.sql                  SQLite DDL
├── diagnose.py                 lightweight always-on ranker
├── diagnostic_engine.py        decision-tree engine, historical confidence
├── all_diagnostics.py          unified full-check runner (Phase 22)
├── wifi_diagnostics.py         hypothesis #15: WiFi/DFS (Phase 15)
├── modem_diagnostics.py        modem/DOCSIS (Phase 16)
├── nat_diagnostics.py          double NAT (Phase 17)
├── cgnat_diagnostics.py        Carrier-Grade NAT (Phase 18)
├── anthropic_diagnostics.py    far-side status (Phase 19)
├── interference_diagnostics.py Wi-Fi interference (Phase 20)
├── router_diagnostics.py       router firmware/settings (Phase 21)
├── fix_engine.py                recommend fixes for a diagnosis
├── fix_application.py           apply fixes to router/modem
├── verification_engine.py       confirm a fix worked
├── monitoring_engine.py         watch for regression after a fix
├── server.py                    stdlib HTTP + JSON API
├── ui.html                       single-file Alpine dashboard
└── vendor/                       vendored Alpine.js (no CDN)

supabase/migrations/            Postgres DDL mirroring schema.sql

tools/
├── code_simplification.py      function-length/complexity scanner
├── security_review.py          secrets/injection/unsafe-call scanner
├── documentation_check.py       docstring/README/scaffolding scanner
├── fixer.py                     cross-platform OS-level network fixer
└── *.sh                          platform-specific fix scripts

tests/
├── test_probes.py, test_environ.py, test_llmlog.py, test_store.py
├── test_diagnose.py, test_diagnostic_engine.py, test_configuration_matrix.py
├── test_all_diagnostics.py, test_{wifi,modem,nat,cgnat,router,interference}_diagnostics.py
├── test_fix_application.py, test_verification_engine.py, test_monitoring_engine.py
├── test_server.py, test_diagnostic_website.py
├── test_e2e_faults.py            end-to-end acceptance (Phase 23)
└── fixtures/                     captured real command output
```

See `API.md` for the function-level reference of every module above.

## Testing

Primary test runner is `unittest` (stdlib, matching the "no pip" constraint):

```bash
python -m unittest discover -s tests -t .
```

380 tests, hermetic — no live network calls, no sleeps beyond a probe's own
timing (`test_e2e_faults.py`'s live-fault-injection tests are the one
exception; they need `tc`/`sudo` and skip gracefully without them). CI
(`.github/workflows/tests.yml`) additionally installs `pytest` to run the
same suite with coverage reporting — `pytest` is a CI convenience for
coverage output, not a project dependency; nothing in `netcheck/` imports it,
and local development doesn't need it installed. See `DEVELOPMENT.md` for
day-to-day commands.
