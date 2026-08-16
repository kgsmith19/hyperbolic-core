# netcheck

Finds out **which layer** is breaking your LLM API connections — Wi-Fi,
router, ISP, or the far end — by recording every layer (gateway, DNS, TLS,
HTTP, Wi-Fi) in one row per tick and reading across the row for which probes
failed together. It also reads Claude Code's own error logs and reports which
of your past API errors were network trouble on your side versus the far
side. Pure Python 3 standard library — nothing to install, no `pip`, no build
step.

`state` has three values: `ok` (measured, healthy), `fail` (measured,
broken), and `unavailable` (could not measure — never treated as evidence).
Errors are grouped into bursts so a single dropout isn't counted as several.

## Quick start

```bash
git clone https://github.com/kgsmith19/hyperbolic-core
cd hyperbolic-core/apps/toolbelt/apps/network-checker
python -m netcheck scan        # one-shot snapshot of every environment section
python -m netcheck probe       # one measured tick across every network layer
```

For a problem that comes and goes, leave a monitor running so the *next*
failure gets caught with data next to it:

```bash
python -m netcheck watch      # leave running in a terminal, tmux pane, etc.
python -m netcheck diagnose   # ranked causes, once watch has a few samples
python -m netcheck serve      # dashboard at http://127.0.0.1:8787
```

The dashboard (`frontend/`) pushes new samples over Server-Sent Events and
installs as an offline-capable app (a Service Worker caches the shell and the
last-known-good report, so it still opens during the outage it's
diagnosing). It is zero dependencies and zero build step: hand-written
HTML/CSS/JS, nothing vendored.

Running in a container, or cutting a release? See
`docs/notes/2026-08-07-deploying-and-releasing-netcheck.md`.

## Optional device credentials

Modem and router status (DOCSIS levels, uptime, clients, DPI state) needs
credentials in a local `.env` (gitignored, never committed). Run
`scripts/configure.ps1` for an interactive prompt that writes it for you, or
set the keys yourself: `MODEM_HOST`, `MODEM_USER`, `MODEM_PASS`,
`ROUTER_HOST`, `ROUTER_USER`, `ROUTER_PASS`, and optionally `SUPABASE_URL` and
`SUPABASE_KEY` for cross-machine history. Every value is optional — absent
ones report `unavailable`, not fail. No `.env.example` ships on purpose: a
committed template is one careless edit away from holding a live key.

## Tests

```bash
python -m unittest discover -s tests -t .
```

Most tests are hermetic and make no real API calls, using fixtures in
`tests/fixtures/`; a small integration slice needs a local dashboard socket or
the real network stack and runs only on CI or an unrestricted host. See
`TEST_LEDGER.md` for the current suite breakdown.

## Documentation

- `AGENTS.md` — repository facts, commands, product invariants, and delivery guidance
- `docs/notes/` — runbooks and design notes, including deployment and releases
- `CHANGELOG.md` — what changed, by version
- `TEST_LEDGER.md` — this app's own test suites

There is deliberately no hand-written API reference — the docstrings are the
reference. Known issues and accepted risks are tracked as
[hyperbolic-core GitHub issues](https://github.com/kgsmith19/hyperbolic-core/issues),
not in application documentation.
