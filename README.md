# netcheck

Finds out **which layer** is breaking your LLM API connections — your Wi-Fi,
your router's DNS, your ISP, or the far end — and proves it with data instead
of a hunch.

Pure Python 3 standard library. Nothing to install.

```bash
python -m netcheck watch      # leave this running
python -m netcheck serve      # dashboard at http://127.0.0.1:8787
python -m netcheck diagnose   # ranked causes, in the terminal
python -m netcheck full-check # one-shot sweep across all 15 hypotheses
```

New to this? See `docs/QUICKSTART.md`.

## Why it exists

Ordinary uptime monitors ping one host and tell you "up" or "down". That
cannot distinguish "my Wi-Fi hiccuped" from "the API had a bad minute", which
is the only question worth answering when Claude Code dies mid-response.

netcheck does two things differently.

**Every tick records all layers in one row.** Gateway, ISP first hop, internet,
router DNS, public DNS, TLS, HTTP, and the Wi-Fi state at that instant. The
diagnosis reads *across* the row, because what names the culprit is which
probes failed *together*:

| Pattern in one row | Verdict |
|---|---|
| Gateway fails | Your Wi-Fi or the link to the router |
| Gateway fine, ISP hop fails | Your ISP |
| ISP hop fine, internet fails | Upstream / peering |
| All pings fine, **router DNS fails while public DNS works** | The router's resolver |
| Everything reachable, TLS fails | TLS interception, router DPI, or the far side |
| Everything healthy, but an LLM error at that moment | **Not your network** |

**It reads the errors you already have.** Claude Code writes every API failure
to `~/.claude/projects/**/*.jsonl`. netcheck extracts them, classifies each as
network / server / client, and joins them to the network samples within ±120
seconds. The output is one sentence: *of N errors, X were the far side, Y lined
up with a real event on your side, Z happened while nothing was watching.*

## Reading the output

`state` has **three** values, not two:

- `ok` — measured, healthy
- `fail` — measured, broken
- `unavailable` — **could not measure** (no credentials, no interface, no binary)

`unavailable` is never treated as evidence. A missing modem password is not a
broken modem.

Errors are grouped into **bursts**. A single 20-second dropout throws several
errors as the client retries; counting them separately would badly overstate
how often your link actually breaks.

## What it inspects

Always, no configuration:

- Gateway / ISP hop / internet reachability, latency, loss
- Router DNS vs public DNS, resolved side by side
- TLS handshake and a real HTTPS request to the target
- Wi-Fi: SSID, BSSID, band, channel, RSSI in dBm, link rates, radio type
- Co-channel and 80 MHz-block interference from neighbouring APs
- Adapter driver version/date and the settings that actually cause drops —
  power management, roaming aggressiveness, 802.11 mode
- Windows event log: radio off/on, DHCP, DNS-client timeouts
- Path MTU, TCP autotuning, whether Tailscale is in the route
- An **idle-hold test** that keeps a real TLS connection open to see whether
  something reaps it — the one probe that reproduces a streaming response
  dying mid-flight

With credentials in a local `.env` (gitignored, never committed):

- **Modem** DOCSIS SNR, power levels, uncorrectable codewords
- **Router** uptime, clients, and whether AiProtection / Trend Micro DPI is on

```ini
# All optional. Absent values make the feature report `unavailable`, not fail.
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_KEY=            # service role key: RLS is on with no policies,
                         # so the publishable key deliberately cannot write
MODEM_HOST=192.168.100.1
MODEM_USER=
MODEM_PASS=
ROUTER_HOST=192.168.50.1
ROUTER_USER=
ROUTER_PASS=
# NETCHECK_TARGET=api.anthropic.com
# NETCHECK_DB=~/.netcheck/netcheck.db
```

No `.env.example` ships with this repo on purpose: the filename matches a
secret pattern, and a template one careless edit away from holding a live
service-role key is not worth the convenience.

## Storage

SQLite is the source of truth, at `~/.netcheck/netcheck.db`. That is not a
preference: a cloud database cannot record an outage *while the outage is
happening*, which is precisely the data you need.

Supabase is an optional mirror for cross-machine history. Pushes are
idempotent, keyed on `(host, ts)`, so a sync interrupted by the very outage it
is reporting simply retries. A failed push leaves rows unsynced — never marked
done.

## Tests

```bash
python -m unittest discover -s tests -t .
```

400 tests, hermetic — no network, no real API calls. Parsers are tested against
real command output captured from a live machine, in `tests/fixtures/`.

The adversarial cases in `test_llmlog.py` are the ones worth knowing about:
grepping transcripts for `529` or `ECONNRESET` matches token counts, request
ids, and conversations *about* errors. That approach overcounted this machine's
real error total by roughly 200×. Detection keys on the `isApiErrorMessage`
flag instead.

## Documentation

- `docs/QUICKSTART.md` — running `full-check`, `watch`, and `serve` for the first time
- `docs/TROUBLESHOOTING.md` — symptom → hypothesis → fix, plus the full list of 15
- `docs/API.md` — function-level reference for all 21 diagnostic modules
- `docs/ARCHITECTURE.md` — module map, decision trees, module interactions
- `docs/CONTRIBUTING.md` — adding a new diagnostic, PDD/SDD/TDD standards
- `docs/DEVELOPMENT.md` — local dev setup, test commands, code-quality gates
- `docs/DEPLOYMENT.md` — local, container, and cloud deployment; releases; upgrade path
- `CHANGELOG.md` — what changed, by version
- `OPEN-ISSUES.md` — problems surfaced but not yet fixed
