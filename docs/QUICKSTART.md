# Quick Start

Pure Python 3 standard library. Nothing to install, no `pip`, no virtualenv.

```bash
git clone https://github.com/kgsmith19/network-checker
cd network-checker
python -m netcheck full-check --format quick
```

That's it — no setup step. Everything below is one of `netcheck`'s
subcommands, run with `python -m netcheck <command>` from the repo root.

## `netcheck full-check` — the one-shot sweep

The fastest way to get a full picture right now, no history required:

```bash
python -m netcheck full-check                  # full JSON, all 15 hypotheses
python -m netcheck full-check --format quick    # short human-readable summary
```

`--format quick` output looks like this:

```
=== Network Diagnostics Summary ===

Running comprehensive diagnostics on all 15 hypotheses...

[Modem] Modem signal degradation or DOCSIS issues
[NAT] Double NAT or restrictive NAT type
[CGNAT] Carrier-Grade NAT limiting port range
[Anthropic] Service status unknown
[WiFi] Running WiFi analysis...
[Interference] Persistent external WiFi interference
[Router] Stale router defaults or outdated firmware

Diagnostics complete. Review full output for details.
```

`--format json` (the default) gives you the full structured result — every
field every module produced, suitable for scripting or feeding into your own
tooling.

`full-check` needs no prior setup and no credentials: modem/router checks
degrade to `unavailable` rather than failing if `.env` doesn't have
`MODEM_HOST`/`ROUTER_HOST` set (see "Credentials" below). It's a snapshot —
one moment in time. If your problem is intermittent, pair it with `watch`.

## `netcheck watch` — for intermittent problems

Most connection drops aren't reproducible on demand. `watch` leaves a
monitor running so that when the next drop happens, there's data sitting
next to it:

```bash
python -m netcheck watch
```

Leave it running (a terminal tab, a `tmux` pane, a background job — your
choice) across the next occurrence of your symptom. It samples every layer
(gateway, ISP hop, internet, router DNS, public DNS, TLS, HTTP, Wi-Fi) every
20 seconds by default, and periodically holds a real TLS connection open to
catch connections that get silently reaped.

```bash
python -m netcheck watch --interval 10 --idle-every 5 --idle-seconds 120
```

It also reads Claude Code's own error transcripts
(`~/.claude/projects/**/*.jsonl`) and correlates each real API error against
the network state within ±120 seconds, entirely locally.

Then:

```bash
python -m netcheck diagnose
```

prints ranked causes, each with the evidence and a suggested fix, e.g.:

```
netcheck - 42 samples, 3 LLM errors

  1. router_dns  [high]
     evidence: 5 of 42 samples (12%) showed this pattern
     fix:      The router is your only resolver and it is intermittently
               failing. Set the adapter's DNS to 1.1.1.1 and 8.8.8.8, or
               change the WAN DNS on the router itself.

  2. llm_error_bursts  [medium]
     evidence: 3 LLM errors in 2 bursts; largest 2 errors over 5s; 1
               occurred with no monitoring running
     fix:      Bursts within seconds indicate a brief total loss of
               connectivity rather than congestion. Leave `watch` running
               so the next burst lands beside a measured sample.

  LLM errors by verdict: 2 your_side, 1 unmonitored
```

## `netcheck serve` — the dashboard

```bash
python -m netcheck serve
```

Opens `http://127.0.0.1:8787` in your browser: layer-status pills, ranked
causes, a latency timeline, a packet-loss/jitter timeline, and the LLM error
table. Single HTML file, no CDN — it renders fully offline, which matters
because it needs to work *during* the outage it's diagnosing.

Click any entry under "Most likely causes" to drill down into the specific
samples behind it. Use the toolbar to export the current view as JSON or
CSV, or "print / save PDF" (this project has no PDF-generation library —
stdlib only — so this uses the browser's own print-to-PDF instead of a
fabricated report format). The page refreshes itself every 15 seconds; there
is no push/streaming update yet, so a manual "refresh" is also there for
right after you've just run something.

## Everything else

```bash
python -m netcheck probe    # one sample, printed — good for a quick gut check
python -m netcheck scan     # full environment snapshot (Wi-Fi, driver, MTU, modem, router...)
python -m netcheck sync     # push unsynced rows to Supabase (optional, cross-machine history)
```

All commands accept `--target` (default `api.anthropic.com`) to point at a
different host.

## Credentials (optional)

Modem and router checks need read access to your devices' admin pages. Drop
a `.env` file (gitignored, never committed — no template ships with this
repo, see the README for why) in the repo root:

```ini
MODEM_HOST=192.168.100.1
MODEM_USER=
MODEM_PASS=
ROUTER_HOST=192.168.50.1
ROUTER_USER=
ROUTER_PASS=
```

Without these, `modem`/`router` sections report `state: unavailable` — never
a false `ok` or a crash.

## Where the data lives

SQLite at `~/.netcheck/netcheck.db` (override with `NETCHECK_DB`). That's the
source of truth; nothing here requires a network service to work. Supabase,
if configured, is only ever a mirror of it.

## Next steps

- Confused by an `unavailable` result? See `TROUBLESHOOTING.md`.
- Want the full function-level reference? See `API.md`.
- Adding a new diagnostic? See `CONTRIBUTING.md`.
