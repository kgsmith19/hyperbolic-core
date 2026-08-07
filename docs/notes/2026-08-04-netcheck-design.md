# netcheck — design

Date: 2026-08-04
Status: awaiting approval

## Problem

Intermittent connection failures that hit long-lived / streaming connections
(Claude Code, direct LLM API calls) harder than ordinary browsing. Prior
theory — the modem's built-in Wi-Fi interfering with the separate router's
Wi-Fi — helped when the modem radio was disabled, but errors persist.

The tool must answer one question: **which layer is at fault, and how do I
prove it.**

## Measured facts about this machine (2026-08-04)

Gathered before design, not assumed:

| Fact | Value | Why it matters |
|---|---|---|
| Gateway | `192.168.50.1` | ASUS default subnet — router is an ASUS |
| DNS server | `192.168.50.1` | **The router resolves everything.** Prime suspect. |
| Modem | `192.168.100.1` responds **401** | DOCSIS stats scrapeable with credentials |
| Wi-Fi | Intel AX201, 5 GHz, ch 44, 95%, 1170/1733 Mbps | Healthy *now* — consistent with intermittent |
| Wi-Fi mode | AX card negotiating **802.11ac** | Not running at capability; worth recording |
| Tailscale | installed, up, **not** in route to `api.anthropic.com` | Not currently implicated; state can change |
| Claude Code logs | 308 `.jsonl` in `~/.claude/projects` | Error history already on disk |
| Codex logs | `~/.codex` absent | Support the path, expect nothing today |

Raw error-signature counts in those transcripts: `529`/`overloaded_error` in
the thousands, `fetch failed` 86, `ECONNRESET` 19, `socket hang up` 18,
`EPIPE` 9, `ETIMEDOUT` 6.

**Caveat on that count:** it came from substring grep, so `529` false-positives
on any number containing 529. The implementation must parse the JSON and read
the actual status/error-type field. Correcting this inflation is itself a
finding worth surfacing.

## The core insight

Most home-network monitors probe one target and tell you "up" or "down". The
diagnostic signal is not any single probe — it is **which probes fail at the
same instant**. So every tick records all layers in one row, and the rules
read across the row.

The second insight, which no prior-art tool does: the failure timestamps are
already sitting in the Claude Code transcripts. Joining those to the network
samples tells you whether a given error was **your network or Anthropic's
capacity** — and given the 529 volume, a large share is likely the latter.
Rebuilding a network to chase someone else's capacity problem is the specific
waste this tool exists to prevent.

## Assumptions taken (user did not answer clarifying questions)

1. **SQLite is the source of truth; Supabase is a mirror.** Cloud-only storage
   cannot record an outage while it is happening. Local always writes; a sync
   pushes rows when the link is healthy.
2. **Lean core always-on; device internals credential-gated.** Modem DOCSIS
   and ASUS router stats activate only when `.env` holds credentials. Absent
   credentials the feature stays dark — no broken code path, no silent
   fallback.
3. **Single HTML file, no build step** — upgraded per user to a current stack:
   **Alpine.js 3 (~15KB, vendored locally) + modern CSS**. Alpine is the 2026
   consensus for "a little reactivity, not an application architecture," and it
   removes the manual DOM plumbing that would otherwise dominate the file, so
   the upgrade *reduces* line count rather than adding to it. Vendored, not
   CDN-loaded: the dashboard must render during an outage, which forbids remote
   assets. Styling is hand-written modern CSS with design tokens — `@layer`,
   nesting, `light-dark()`, `color-mix()`, container queries — not a CDN
   utility framework. Charts stay hand-rolled inline SVG; a charting library
   would be a second dependency for line charts Alpine can template directly.

## Architecture

Seven files. Each has one job and is readable in a single sitting.

```
netcheck/
  __main__.py   CLI dispatch: probe | watch | scan | diagnose | serve   ~60
  probes.py     per-tick network measurements                          ~180
  environ.py    wifi / driver / modem / router / event log             ~140
  llmlog.py     LLM error extraction + classification                   ~90
  store.py      sqlite, plus optional Supabase mirror                   ~90
  diagnose.py   correlation rules -> ranked causes                     ~120
  ui.html       dashboard, single file                                 ~260
```

~940 lines. That is the honest cost of what is being asked; a smaller number
would be achieved by dropping features, not by writing denser code.

Python 3.12 stdlib only for the core. The Supabase mirror is the sole optional
dependency and is import-guarded.

### Per-tick sample (default every 20s)

One row, all layers measured close together in time:

| Field | Isolates |
|---|---|
| `gw_ms`, `gw_loss` | your LAN / Wi-Fi |
| `hop2_ms`, `hop2_loss` | ISP first hop (discovered once, cached) |
| `inet_ms`, `inet_loss` (1.1.1.1) | the wider internet |
| `dns_router_ms`, `dns_router_ok` | router DNS — prime suspect here |
| `dns_public_ms`, `dns_public_ok` | control: same name via 1.1.1.1 direct |
| `tls_ms`, `tls_ok` | TLS handshake to `api.anthropic.com` |
| `http_ms`, `http_code` | full request path |
| `wifi_rssi`, `wifi_channel`, `wifi_band`, `wifi_rate`, `wifi_bssid` | Wi-Fi conditions at that instant |

### Culprit rules

Read across a single row:

- `gw` fails → Wi-Fi, driver, or router LAN side
- `gw` ok, `hop2` fails → ISP
- `hop2` ok, `inet` fails → upstream / peering
- all pings ok, `dns_router` fails while `dns_public` ok → **router DNS**
- all ok but `tls`/`http` fails → app layer: TLS interception, DPI, or Anthropic
- all ok at tick *and* an LLM error at that timestamp → **not your network**

### Idle-hold test

Retained from the original script, on a slower cadence (every N ticks). Holds a
real TLS connection to `api.anthropic.com` open and watches for something
killing it. This reproduces the exact Claude Code failure shape — a long
streaming response dying mid-flight — which no ping-based probe can detect.
Records `held_seconds` and `result`.

### Environment scan (`netcheck scan`)

On demand, and once when `watch` starts:

- **Channel congestion** — `netsh wlan show networks mode=bssid`, counting
  co-channel BSSIDs on your channel. This directly tests the modem-Wi-Fi
  interference theory: if the modem radio returned, or a neighbour moved onto
  channel 44, it appears here.
- **Driver + power management** — adapter version/date,
  `Get-NetAdapterAdvancedProperty`, `Get-NetAdapterPowerManagement`. Flags the
  known offenders: power saving, "allow the computer to turn off this device",
  roaming aggressiveness, 802.11 mode. Intel AX201 power management is a
  leading cause of precisely this symptom.
- **Windows event log** — `Netwtw*`, `Tcpip`, `DNS Client`, `Dhcp` over the
  last 24h. Hard evidence of driver resets.
- **TCP globals** — `netsh interface tcp show global` (autotuning, RSS).
- **Path MTU** — DF-bit ping walk, retained from the original.
- **Tailscale** — installed, up, and whether it is in the route to the API.
- **Modem** (`192.168.100.1`, credential-gated) — DOCSIS downstream/upstream
  power, SNR, and **uncorrectable codewords**, the single best indicator of
  physical line quality.
- **Router** (`192.168.50.1`, credential-gated) — uptime, client count, and
  critically whether **AiProtection / Trend Micro DPI** is enabled, a
  well-documented cause of killed long-lived TLS streams on ASUS firmware.

### LLM error correlation

- Parse `~/.claude/projects/**/*.jsonl` incrementally, tracking file offset so
  rescans are cheap.
- Support `~/.codex/` on the same interface; it is absent today.
- Classify each error:
  - `server` — 429/500/502/503/529, `overloaded_error`, `rate_limit`
  - `network` — `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `socket hang up`,
    `fetch failed`, `ENOTFOUND`, `EAI_AGAIN`, TLS failures
  - `client` — 400/401/403, context-length
- Join each error to network samples within ±120s and assign a verdict.
- Headline output: *"Of N errors in the last 30 days: X server-side
  (Anthropic), Y correlated with a Wi-Fi/DNS event on your side, Z
  unexplained."*

That sentence is the product.

### Diagnosis output

Ranked causes, each with evidence and one concrete action:

```
1. Router DNS intermittently failing                    confidence: high
   evidence: 14 ticks where dns_router failed while dns_public succeeded
   fix: set adapter DNS to 1.1.1.1 / 8.8.8.8, or change ASUS WAN DNS
```

### UI

Single `ui.html`, dark, no remote assets:

- Live status strip — one pill per layer: LAN / ISP / Internet / DNS / Anthropic
- **Most likely causes** card, the headline
- Timeline chart (inline SVG, one polyline per layer) with outage bands
- LLM error table: time, source, classification, verdict, correlated network state
- Raw sample table, filterable by range
- Buttons: run scan, run idle-hold, export report

### Supabase

Project `netcheck` (`crqhkqmrkhmfnrhtczlf`, us-east-1), $10/mo, confirmed.

Two DDL files — `schema.sql` (SQLite) and `supabase/migrations/0001_init.sql`
(Postgres) — carrying the same logical schema. A single DDL serving both was in
an earlier draft of this spec and is not achievable cleanly; the type systems
differ enough that pretending otherwise would just break at apply time.

The mirror talks to Supabase's PostgREST endpoint over `urllib.request`, so
**the project has zero pip dependencies end to end** — stdlib only, including
tests (`unittest`). Nothing to install, nothing to keep patched.

Tables:

- `hosts` — machine identity, so Surface and Mac both report in
- `samples` — tick rows, FK to `hosts`
- `events` — outages and idle-hold results
- `llm_errors` — extracted errors with classification and verdict
- `env_scans` — environment snapshots (JSONB payload)

RLS enabled. Service key in `.env`, never committed. Batched push with
`on conflict do nothing` keyed on `(host_id, ts)`, making sync idempotent and
safe to retry after an outage.

## Error handling

No silent fallbacks. Every probe records an explicit outcome — success with a
measurement, or failure with the reason. A probe that cannot run (missing
credentials, absent binary, permission denied) records `unavailable` with the
cause, and the UI renders that distinctly from `failed`. Conflating "we did not
measure" with "it is broken" would poison the correlation rules, which is the
one thing this tool cannot afford.

## Test contract

### Matrix

| # | Acceptance criterion | Test | Tier |
|---|---|---|---|
| 1 | Ping output parses on Windows and Unix formats | unit, fixture strings | fast |
| 2 | `netsh wlan` output parses to Wi-Fi fields | unit, fixture | fast |
| 3 | Co-channel BSSID count is correct for a given scan | unit, fixture | fast |
| 4 | LLM error classification maps each signature to the right bucket | unit, fixture jsonl | fast |
| 5 | `529` appearing as a substring in unrelated text is **not** counted as an error | unit, adversarial fixture | fast |
| 6 | Incremental jsonl scan resumes at stored offset, no duplicates | integration, temp files | fast |
| 7 | Each culprit rule fires on its row shape and only its row shape | unit, table-driven | fast |
| 8 | Correlation joins an error only to samples within ±120s | unit, boundary cases | fast |
| 9 | `unavailable` and `failed` stay distinct through storage and diagnosis | unit | fast |
| 10 | SQLite writes succeed with the network down | integration, no network | fast |
| 11 | Supabase sync is idempotent — replay inserts nothing new | integration, fake endpoint | fast |
| 12 | Idle-hold reports `closed_by_peer` vs `still_alive` correctly | integration, local TLS server | fast |
| 13 | Dashboard renders from a seeded DB with no network access | integration | fast |

Every criterion has a test; every test proves a criterion.

### Discipline

- **Red first.** Each test is written and run before its implementation, and
  must fail for the stated reason. A test born green proves nothing.
- **Tiers.** All of the above are the fast tier: hermetic, no network, no real
  LLM calls. Probes are tested against captured fixture output, not live
  commands — which is also why the parsers are pure functions taking text.
- **No e2e tier.** Nothing here makes a cross-process promise that warrants
  spending tokens on a real-claude launch.
- **Lean.** One behaviour per test, no sleeps, no shared state. Thirteen sharp
  tests, not forty flabby ones.

### Gates

- Fast tier green.
- `node hooks/covgate.mjs` green — changed lib files at policy floors.
- Coverage is a floor, not a target: assertions are on observable behaviour,
  never on implementation detail.

## Out of scope

- Speed tests / throughput. Bandwidth is not the reported symptom, and a
  recurring 10MB download would pollute the very measurements being taken.
- Alerting, Discord/webhook notification.
- Running as a service. Manual `watch` first; daemonise only if it earns it.
- macOS support in v1. Parsers are written to take text so a Mac backend is an
  additive change, not a rewrite.

## Open questions

None blocking. The three assumptions above are reversible before
implementation begins and each is isolated to one file.
