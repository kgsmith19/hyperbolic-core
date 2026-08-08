# netcheck — front door

Local-first network diagnostic. Names *which layer* breaks LLM API connections
by correlating multi-layer probes against errors already recorded in Claude
Code transcripts.

## Sources of truth, in order

| Rank | Artifact | Governs |
|---|---|---|
| 1 | `docs/PRD.md` | What the product does and why. Living document — if code and PRD disagree, one is a defect. |
| 2 | `docs/SYSTEM-REQUIREMENTS.md` | What the system must be |
| 3 | `docs/DATA-FLOW-DIAGRAM.md` | Where data comes from, goes, rests |
| 4 | This file | How to work in this repo |

`rules/` holds the fuller development-process rules (budgets, gates, writing
standard, spec/test discipline) this project draws on; not all of it applies
at this project's current scale, but nothing here contradicts it. Known
issues and accepted risks are tracked as GitHub issues, not in this repo.

## Stack

Python 3.12, **standard library only**. No pip, no npm, no build step — this is
a hard constraint, not a preference. Tests are `unittest`. The Supabase mirror
talks to PostgREST over `urllib.request`. The dashboard is one HTML file plus a
vendored Alpine.js.

## Commands

Run from the repo root.

```bash
python -m unittest discover -s tests -t .     # full suite
python -m netcheck watch                       # the useful one; leave running
python -m netcheck probe                       # one sample
python -m netcheck scan                        # environment snapshot
python -m netcheck diagnose                    # ranked causes
python -m netcheck serve                       # dashboard on 127.0.0.1:8787
python -m netcheck sync                        # push to Supabase
```

## Layout

| File | Responsibility |
|---|---|
| `netcheck/probes.py` | Per-tick measurement: ping, TLS, HTTP, idle-hold |
| `netcheck/resolver.py` | Name resolution, incl. a minimal DNS/UDP client |
| `netcheck/dualstack.py` | IPv4-vs-IPv6 reachability, measured per family |
| `netcheck/route.py` | Default gateway and the ISP's first hop |
| `netcheck/wlan_probes.py` | `netsh`/`airport` Wi-Fi parsers |
| `netcheck/docsis.py` | DOCSIS status-page parser |
| `netcheck/ssdp.py` | SSDP/UPnP gateway discovery: the multicast query, the device-description parser, and `identify_gateway()` |
| `netcheck/snmp.py` | Hand-rolled SNMPv2c GET client, scoped to MIB-II scalar OIDs, and `modem_snmp()` |
| `netcheck/topology.py` | Address-resolution table (`arp -a`/`ip neigh`) parser and `map_devices()`, cross-referencing SSDP-identified names |
| `netcheck/environ.py` | This host: Wi-Fi, driver, event log, TCP, MTU, Tailscale; composes `scan()` |
| `netcheck/remote.py` | Reached over the network: modem, router, WAN address, provider status |
| `netcheck/llmlog.py` | Transcript scraping, error classification, offsets, and `ingest()` |
| `netcheck/watch.py` | The `netcheck watch` loop: one probe per interval, re-resolved route |
| `netcheck/store.py` | SQLite schema and writes; Supabase mirror |
| `netcheck/diagnose.py` | Culprit rules for one row, error correlation, bursts |
| `netcheck/rank.py` | `_SCAN_RULES`, `_FIXES`, and the ranked report |
| `netcheck/server.py` | stdlib HTTP + JSON API |
| `netcheck/ui.html` | Single-file Alpine dashboard |

## Standards

**Three states, never two.** Every probe returns `state` ∈ `ok` | `fail` |
`unavailable`. `unavailable` means *we could not measure*. Never collapse it
into `fail`: a missing modem password is not a broken modem, and the ranking
engine refuses to cite `unavailable` sections as evidence. This is enforced by
tests in `test_environ.py` and `test_diagnose.py`.

**Parsers are pure functions over text.** Anything parsing command output takes
a string and returns a dict, so tests use captured fixtures in
`tests/fixtures/` and never shell out. This is also what makes a macOS backend
an additive change rather than a rewrite.

**Never substring-match transcripts.** Error detection keys on the
`isApiErrorMessage` flag and `type: system` error objects. Grepping for `529`
or `ECONNRESET` over raw lines matches token counts, request ids, and
conversations *about* errors — it produced an estimate roughly 200× too high
before `llmlog.py` existed. `test_llmlog.py` holds the adversarial cases.

**SQLite is the source of truth.** A cloud database cannot record an outage
during the outage. Supabase is a mirror; a failed push must leave rows
unsynced for retry, never mark them done.

**Tests are hermetic, and none of them skip.** No network, no sleeps beyond a
probe's own timing, no shared state. A test that does not run on the machine
running the suite is not coverage, so anything needing `sudo`, `tc`, or
`CAP_NET_ADMIN` does not belong here. Add the test before the code and watch
it fail first.

## Adding a diagnostic

A new standing condition is a **row in `rank._SCAN_RULES`**, not a new
module. The row names the `environ.scan()` section it reads, a confidence,
and a callback returning either an evidence string or `None`.

1. Write the test first, in `tests/test_diagnose.py::ScanCauseTest`: one that
   the cause fires on a realistic section, one that it does *not* fire on the
   healthy version of the same section. Watch both fail.
2. If it needs a new scan section, that section is a pure function over text
   or a thin I/O wrapper around one, with a captured fixture in
   `tests/fixtures/`.
3. Give the cause a `_FIXES` entry saying what to actually do. A cause with
   no fix is a complaint, and
   `test_every_scan_cause_carries_an_actionable_fix` enforces it.

`rank._scan_causes()` skips any section whose state is not `ok`, so neither an
unmeasured section nor a broken query can invent a fault.

## Gates

`bash tools/check.sh` is the gate, and CI runs the same script. It runs the
suite, `code_simplification` at the ceilings in `rules/01-BUDGETS.md`
(40 lines, 4 params, cyclomatic 8, nesting 3), the security and documentation
scanners, and shell syntax checks. It must exit 0 before a merge.
