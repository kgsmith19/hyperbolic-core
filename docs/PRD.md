---
title: netcheck Product Requirements Document
status: living
created: 2026-08-07
updated: 2026-08-10
owner: Kyle Smith
version: 1.6.0
---

# netcheck PRD

> **This document is the source of truth.** Code, specs, and tests derive from it. If reality differs from this document, one of them is wrong and it gets fixed the same day. This is a living document: it is updated as requirements are discovered, and every change is logged in section 16.
>
> **Writing standard:** every line must pass the four-reader test (a child, a business person, a programmer, and an LLM must all read it the same way). No adjective without a number. See `rules/03-WRITING.md`.

---

## 1. What this is

This is a program that runs on your computer and tells you which part of your home network broke — your Wi-Fi, your router, your modem, your internet provider, or a specific device on your network. It watches your network in the background and writes down what it sees, so that when something breaks, there is already evidence instead of a guess. One built-in use of that evidence is naming which layer broke when an AI coding tool loses connection, by reading the AI tool's own error log and lining it up with what was measured at that moment — but that is one input to a general report, not the reason the tool exists (see the 2026-08-10 pivot in the change log, section 16). It works on one computer at a time. It costs nothing to run and needs nothing installed beyond Python, which most computers already have.

## 2. Problem

| Field | Answer |
|---|---|
| Who has the problem | A developer whose AI coding assistant (Claude Code) disconnects mid-response |
| What they do today | Guess whether it was their Wi-Fi, their ISP, or the AI provider's servers, with no data to check the guess against |
| What it costs them | Lost work mid-task, repeated troubleshooting of the wrong layer, and no evidence to bring to an ISP or vendor support ticket |
| Why solve it now | Ordinary uptime monitors ping one host and answer "up" or "down" — they cannot distinguish "my Wi-Fi hiccuped" from "the API had a bad minute," which is the one question that matters when a session dies |
| What happens if we do nothing | Every disconnection stays an unresolved guess; the same layer may keep failing, undiagnosed, indefinitely |

## 3. Users

| ID | User type | What they need to do | How often | Technical level |
|---|---|---|---|---|
| U-001 | Developer running Claude Code (or another LLM CLI) on their own machine | Find out which network layer broke after a disconnect, with evidence | Whenever a disconnect happens; `watch` runs continuously in the background | Expert (comfortable with a terminal and `.env` files) |

## 4. Scope

### 4.1 In scope

- Measuring every network layer (gateway, ISP first hop, general internet, router DNS vs. public DNS, TLS, HTTP, Wi-Fi radio state) on a fixed interval and recording every layer's state in one row per tick
- Reading Claude Code's own transcript files to find real API errors and classify each as network, server, or client
- Correlating each API error against the network state recorded near the same moment, and naming which layer broke — or that nothing was watching
- Ranking the most likely culprit layer across all recorded samples, with the evidence and a plain-language fix suggestion
- A one-shot environment snapshot (Wi-Fi link, channel congestion, adapter driver, event log, TCP globals, path MTU, Tailscale, modem DOCSIS, router DPI, WAN address and NAT type, provider status, IPv4-vs-IPv6 reachability), read by the same ranking engine so its findings appear beside the ones measured over time
- A local web dashboard for reading recorded history without the command line
- An optional, best-effort mirror of recorded data to a Supabase project, for reading history from more than one machine
- Local, dry-run-capable OS-level fix scripts for the specific problems this tool can already diagnose (Wi-Fi mode, DNS, adapter power management)
- Three selectable scan tiers (quick, standard, deep) so a routine check and a full investigation are not the same cost
- A map of devices visible on the local network (IP, MAC where available, identified name), built from address-resolution tables already on this machine plus SSDP discovery
- A read-only security-exposure check of devices already identified on the local network: open well-known management ports and a fixed list of no more than 20 known factory-default credential pairs, reported as evidence only, never used to modify a device or gain persistent access
- A coarse (city/region/country) geographic location for the current WAN address, looked up from a free external API
- A controlled-comparison mode that runs the same probes twice under two user-labeled conditions (e.g. "wifi" vs. "ethernet") and reports the measured difference between them, never asserting a difference without a sample on both sides

### 4.2 Out of scope (non-goals)

| ID | Not doing | Why not | Revisit when |
|---|---|---|---|
| OOS-001 | ~~Automatically applying a fix to a router or modem without being asked~~ **Superseded 2026-08-10** — this is now planned product direction (see the pivot note in section 16), not a permanent non-goal. What still holds: a wrong automated write to networking hardware can take a household offline with no easy recovery, so any execution phase must simulate first, pass a stringent quality gate, and get the user's explicit signed-off agreement before touching real hardware — see `.agent/project.yaml`'s R4 classification for automated device writes, which still requires Kyle's manual review regardless of this change. | This tool's device-fix code was built once, never wired to a command, and removed as dead code (2026-08-07, see GitHub issue for the removed capability); user-requested pivot (2026-08-10) to a diagnose → plan → execute workflow reinstated the goal, with the safety bar raised instead of removed | Each execution-phase capability is designed, spec'd, and reviewed on its own before implementation — this row records that the door is open, not that anything auto-applies yet |
| OOS-002 | Monitoring more than one machine from a single running instance | Each machine's Wi-Fi/router/ISP path is independent; the Supabase mirror already covers "read history from elsewhere" without needing a controller process | A user asks for fleet monitoring |
| OOS-003 | Any dependency requiring `pip install` or a build step | Python standard library only is a deliberate hard constraint (see `AGENTS.md`); it keeps the tool runnable on a machine mid-outage with no working package registry | Never |
| OOS-004 | Diagnosing problems inside the AI provider's own infrastructure beyond "is their status page reporting an incident" | This tool has no visibility past its own network path; anything past the far side's edge is the provider's responsibility | Never |
| OOS-005 | ~~A general-purpose network monitor for arbitrary hosts/services chosen by the user at runtime~~ **Superseded 2026-08-10** — netcheck's target widened from one fixed endpoint (an LLM API used by a coding CLI) to the user's whole home network path (modem, router, Wi-Fi, ISP, and devices already on the LAN). What still holds without change: this is diagnosis of the user's own network path, not a general port-scanner or monitor of arbitrary third-party hosts/services the user names at runtime that are not part of their own connection — that remains out of scope | User-requested pivot (2026-08-10): the vision is now a whole-home diagnostic tool, deep enough to find what a typical user could not find themselves, not a tool scoped to one LLM vendor's endpoint | A user asks to monitor or scan an arbitrary third-party host/service unrelated to their own home network path |
| OOS-006 | Capturing raw network packets (pcap-level) | Windows, this project's primary platform (CON-003), has no packet-capture path in the Python standard library; it needs Npcap, a third-party driver install, which breaks CON-001 | CON-001 or CON-003 changes |
| OOS-007 | Any exposure check that modifies a device, exploits a vulnerability beyond an unmodified login attempt, tries more than the fixed 20-pair documented default-credential list, or persists access | FR-019's exposure check exists to tell the user what to fix on their own equipment, not to demonstrate a working intrusion; a scanner that keeps trying past a fixed, bounded list, or that changes device state, is a different kind of tool with a different risk profile | Never — a distinct, explicitly-authorized penetration-testing feature would need its own PRD, not an extension of this one |
| OOS-008 | A `netcheck.toml` configuration file that overrides probe target, public DNS resolver, or classifier thresholds | Every one of those values has exactly one caller and one value today; adding a config file trips M4 ("zero config values nobody configures") in `rules/02-GATES.md`. `NETCHECK_TARGET` and `NETCHECK_DB` already cover the two that vary in practice. Prototyped in branch `claude/network-diagnostics-ui-cont-4cl3r9`, decided out of scope 2026-08-08 (GitHub issue #38) | A user demonstrates a concrete need to tune a value that the env-var approach cannot cover |
| OOS-009 | `netcheck test {latency,loss,mtu,dualstack}` and `netcheck rootcause` CLI subcommands for one targeted live check | `netcheck scan` + `netcheck diagnose` already covers this use case; `dualstack` is specifically redundant after `dualstack.py` landed in PR #39. Prototyped in branch `claude/network-diagnostics-ui-5ortgo`, decided out of scope 2026-08-08 (GitHub issue #38) | A user identifies a workflow not covered by `scan`/`diagnose`/`probe` |
| OOS-010 | `environ.mtu(probe_all=True)` — testing every candidate MTU size rather than stopping at the first success | Marginal improvement: the current walk already reports a correct lower bound, and the `sizes=` parameter already allows a narrower second pass when needed. Prototyped in branch `claude/network-diagnostics-ui-5ortgo`, decided out of scope 2026-08-08 (GitHub issue #38) | A user demonstrates that the lower-bound result is materially misleading |

## 5. Use cases

### UC-001: Find out what broke after a disconnect

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | `netcheck watch` has been running (even intermittently) near the time of the disconnect |
| Trigger | Claude Code (or another supported LLM CLI) throws a real API error |
| Main path | 1. User runs `netcheck diagnose`. 2. Tool reads new errors from the CLI's transcript files. 3. Tool joins each error to the nearest recorded network sample within ±120 seconds. 4. Tool prints a verdict per error and a ranked list of causes across all samples, each with evidence and a fix. |
| Success outcome | User reads one sentence naming the broken layer, or learns nothing was watching at that moment |
| Failure paths | No sample within the window -> verdict `unmonitored`, reported as such, never guessed |
| Frequency | As needed, typically a few times a week |
| Traces to | FR-001, FR-002, FR-003 |

### UC-002: Leave a monitor running to catch the next failure

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | None |
| Trigger | User starts `netcheck watch` in a terminal or background process |
| Main path | 1. Tool measures every layer once per interval (default 20s). 2. Tool stores one row per tick in SQLite. 3. Tool periodically holds a TLS connection open to catch connection reaping. 4. Tool re-checks the default gateway every tick so a network switch (e.g. Wi-Fi to hotspot) is detected, not misread as an outage. |
| Success outcome | A continuous history exists for `diagnose` to correlate against later |
| Failure paths | A probe fails to measure (no credentials, no interface) -> recorded as `unavailable`, never as `fail` |
| Frequency | Continuous, left running |
| Traces to | FR-004, FR-005, FR-011 |

### UC-003: Run a one-shot environment sweep

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | None |
| Trigger | User runs `netcheck scan`, then `netcheck diagnose` |
| Main path | 1. Tool records every environment section, including the WAN address and the provider's declared status. 2. Tool ranks the standing faults those sections reveal beside the ones measured over time. |
| Success outcome | User sees Wi-Fi, modem, NAT/CGNAT, router, interference, and far-side status as ranked causes with evidence and a fix — in the same list, and on the same dashboard, as everything else |
| Failure paths | A section has no credentials/binary -> `unavailable` for that section only, and it is never cited as a cause |
| Frequency | Occasional, when starting a fresh diagnosis |
| Traces to | FR-006, FR-015, FR-016 |

### UC-004: Read history from a dashboard

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | At least one sample has been recorded |
| Trigger | User runs `netcheck serve` |
| Main path | 1. Tool starts a local HTTP server. 2. Browser opens to the dashboard. 3. Dashboard fetches recent samples/errors/culprits and renders charts and a table. |
| Success outcome | User can review history without the command line |
| Failure paths | Malformed query parameter -> HTTP 400, never a crash |
| Frequency | Occasional |
| Traces to | FR-007 |

### UC-005: Run a deep tiered investigation

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | None |
| Trigger | User runs `netcheck scan --tier deep` |
| Main path | 1. Tool runs every quick-tier and standard-tier section (FR-001, FR-006). 2. Tool builds a map of devices visible on the local network. 3. Tool checks each mapped device for open well-known management ports and the fixed default-credential list. 4. Tool looks up a coarse geographic location for the current WAN address. 5. Tool includes all of the above, each with its own state, in the same ranked report as everything else. |
| Success outcome | User sees a full local-network inventory, any exposure findings on their own devices, and a rough sense of where their traffic exits, all in one report |
| Failure paths | Any single tier-deep section that cannot run (missing platform command, unreachable API, a device that fails the LAN check) reports `unavailable` for that section only; the rest of the report is unaffected |
| Frequency | Occasional, when a quick or standard scan is not enough |
| Traces to | FR-017, FR-018, FR-019, FR-020 |

### UC-006: Compare two conditions with a controlled run

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | None |
| Trigger | User runs `netcheck experiment --label wifi`, then later `netcheck experiment --label ethernet` |
| Main path | 1. Tool runs the standard probe set and stores the samples tagged with the given label. 2. User repeats the command under the other condition with a different label. 3. User runs `netcheck experiment --compare wifi ethernet`. 4. Tool reports each layer's median latency and state-mix side by side for the two labels. |
| Success outcome | User sees which layer actually changed between the two conditions, backed by measured samples rather than a guess |
| Failure paths | A requested label with zero stored samples is reported as having no data; the tool never fabricates or infers a comparison for it |
| Frequency | Occasional, when isolating a suspected single variable (e.g. "is it the Wi-Fi adapter or the cable") |
| Traces to | FR-021 |

## 6. Functional requirements

| ID | Requirement | Priority | Acceptance criterion (objective) | Traces to | Status |
|---|---|---|---|---|---|
| FR-001 | The system must measure gateway, ISP first hop, general internet, router DNS, public DNS, TLS, and HTTP reachability in one tick, and store them as one row. | Must | Given `netcheck probe` is run, then one row containing all seven measurements plus a timestamp is printed and stored. | UC-001, UC-002 | done |
| FR-002 | The system must classify every Claude Code transcript entry as a real API error (network/server/client) using the `isApiErrorMessage` flag, never a substring match on error text. | Must | Given a transcript line containing the digits "529" inside a normal conversation (not an error), when scanned, then it is not counted as an error. | UC-001 | done |
| FR-003 | The system must join each classified error to the nearest sample within a 120-second window and report a verdict, or `unmonitored` if none exists. | Must | Given an error at time T with a sample at T+90s and none closer, when correlated, then the verdict is derived from that sample; given no sample within 120s, then the verdict is `unmonitored`. | UC-001 | done |
| FR-004 | The system must re-resolve the default gateway every tick during `watch`, not just at startup. | Must | Given the gateway changes mid-run (e.g. Wi-Fi to hotspot), when the next tick runs, then the new gateway is pinged, not the stale one. | UC-002 | done |
| FR-005 | The system must periodically hold a real TLS connection open and report whether it was closed by the peer, dropped, or survived, to catch connection reaping that a ping-based check cannot see. | Must | Given `watch` runs with `--idle-every N`, then every Nth tick performs an idle-hold check and records its result as an event. | UC-002 | done |
| FR-006 | The system must turn the standing conditions an environment scan measures — provider incident, double NAT, carrier NAT, DOCSIS codeword errors, router DPI, radio power-cycling, channel congestion, DFS channel, tunnelled API route, reduced MTU, pinned Wi-Fi mode — into ranked causes carrying evidence and a fix. | Must | Given a scan whose `anthropic` section reports a declared outage, when ranked, then `anthropic_incident` appears as a `high`-confidence cause naming the indicator; given the same section is `unavailable`, then no such cause appears. | UC-003 | done |
| FR-007 | The system must serve a local dashboard over HTTP showing recent samples, culprits, and LLM error correlation. | Must | Given `netcheck serve`, when a browser requests `/api/data`, then it receives JSON built from the live SQLite database, never fabricated placeholder values. | UC-004 | done |
| FR-008 | Every measurement must report one of exactly three states: `ok`, `fail`, or `unavailable`, and `unavailable` must never be treated as evidence of a fault. | Must | Given a probe has no credentials configured, when run, then it returns `unavailable`, and the ranking engine does not cite it as a cause. | UC-001, UC-002, UC-003 | done |
| FR-009 | The system must rank probable causes across all recorded samples by how large a share of samples showed that pattern, most confident first. | Must | Given 100 samples where 12 show a `lan` culprit and 3 show `isp`, when ranked, then `lan` appears before `isp` with its share stated. | UC-001 | done |
| FR-010 | The system must group LLM errors that arrive within 60 seconds of each other into one burst, rather than counting each retry separately. | Must | Given 5 errors within a 20-second span, when grouped, then they are reported as 1 burst of 5, not 5 separate causes. | UC-001 | done |
| FR-011 | The system must mirror unsynced local rows to an optional Supabase project without blocking local capture, and must never mark a row synced unless the push succeeded. | Should | Given `SUPABASE_URL`/`SUPABASE_KEY` are unset, when `watch` runs, then local capture continues unaffected and `sync` reports `unavailable`. Given the push fails, then the row stays unsynced for retry. | UC-002 | done |
| FR-014 | The system must not send device credentials to any address outside a private network, and must say so instead of sending them. | Must | Given `MODEM_HOST` resolves to a public address, when the modem section runs, then no request is made and the section reads `unavailable` naming the misconfigured variable. | UC-003 | done |
| FR-013 | The system must reach the target over IPv4 and over IPv6 independently, and report a family as broken only when the other family succeeded. | Should | Given IPv6 connects and IPv4 is refused, when ranked, then `broken_ipv4` appears; given the target has no AAAA record, or this host has no IPv6 stack, then the IPv6 section reads `unavailable` and no cause appears. | UC-003 | done |
| FR-012 | The system must provide local, dry-run-capable OS-level fix scripts for Wi-Fi mode, DNS, and adapter power management, runnable independently of diagnosis. | Should | Given `tools/run_fixes.sh --dry-run`, when run, then it prints what each fix would change without applying it. | - | done |
| FR-015 | The system must attempt to identify the LAN gateway's manufacturer and model via SSDP (UPnP) discovery, and must report `unavailable`, never `fail`, when no device responds or the discovered device-description URL does not resolve to a private address. | Should | Given a captured SSDP M-SEARCH response and device-description XML fixture, when parsed, then manufacturer and model are extracted; given no SSDP response arrives within the timeout, then the section reads `unavailable`; given the LOCATION header names a host that resolves off-LAN, then no request is made for it and the section reads `unavailable`. | UC-003 | done |
| FR-016 | The system must attempt a best-effort SNMPv2c GET of the standard MIB-II scalar OIDs `sysDescr` and `sysUpTime` against the modem host, and must report `unavailable`, never `fail`, when the agent does not respond within the timeout. | Could | Given a captured SNMP GET-response fixture for `sysDescr`, when parsed, then the value is extracted and the section reads `ok`; given the modem host does not respond within the timeout, then the section reads `unavailable`, not `fail`. DOCSIS-indexed table OIDs requiring SNMP WALK are explicitly out of scope for this requirement. | UC-003 | done |
| FR-017 | The system must build a map of devices on the local network from address-resolution table output (e.g. `arp -a` / `ip neigh`) plus any SSDP-discovered devices, listing each device's IP, MAC when the table provides one, and identified name when SSDP provided one, and a single device that cannot be further identified must not remove it from the map or block the rest of the map from being built. | Should | Given a captured address-resolution table fixture with 5 entries and one SSDP-discovered device matching one of those IPs, when mapped, then the map lists 5 devices, with the matching one carrying its SSDP-identified name; given the address-resolution command is unavailable on this platform, then the map section reads `unavailable` naming the missing command, not `fail`. | UC-005 | done |
| FR-018 | The system must support three scan tiers — quick (FR-001's layer measurements only), standard (adds every section already defined by FR-006, FR-015, FR-016), and deep (adds FR-017, FR-019, FR-020) — selected by an explicit `--tier` flag on `netcheck scan`, defaulting to standard, and must run only the sections belonging to the requested tier or a shallower one. | Should | Given `netcheck scan --tier quick`, when run, then only FR-001's measurements are attempted and no environment-scan, topology, exposure, or geolocation section appears in the output; given `netcheck scan --tier deep`, then every section from all three tiers appears; given an unrecognized `--tier` value, then the command exits with an error before any probe runs. | UC-005 | done |
| FR-019 | For each device FR-017 maps on the local network, the system must attempt to detect two exposure indicators — an open well-known management port (e.g. 23, 80, 8080, 7547), and a successful login using a fixed, documented list of no more than 20 known factory-default credential pairs against that device's own detected HTTP login endpoint — and must report each finding as evidence naming the port or the matched credential-list entry, must never modify the device, must never attempt a credential beyond the fixed list, and must refuse to run against any host that fails the existing `_on_lan()` check. | Could | Given a captured response fixture showing an open port on a mapped device, when scanned, then the finding names the port and is not treated as a device compromise; given a device's login accepts an entry from the fixed default-credential list, when detected, then the finding names which list entry matched (never the raw credential value forwarded elsewhere) and recommends changing it; given the same check is attempted against a mapped entry that fails `_on_lan()`, then no connection is attempted and its exposure section reads `unavailable` naming the reason. | UC-005 | done |
| FR-020 | The system must look up a coarse (city/region/country) geographic location for the current WAN address using a free external HTTPS geolocation API, attaching it to the existing WAN section, and must report `unavailable` for the geolocation field alone (never affecting the WAN section's own `state`) when the API does not respond or returns no location. | Could | Given the WAN section already reads `ok` with an address, when geolocation is looked up, then a city/region/country string is attached; given the geolocation API is unreachable, then the WAN section's own `state`/`double_nat`/`cgnat` fields are unaffected and only the geolocation field reads `unavailable`. | UC-005 | done |
| FR-021 | The system must let the user tag a run of the standard probe set with a condition label, store each label's samples separately, and on request report each measured layer's median latency and state-mix side by side for two named labels, and must report a label with zero stored samples as having no data rather than inferring or fabricating a value for it. | Could | Given labels "wifi" and "ethernet" each with 5 stored samples, when compared, then the report shows each layer's median latency and state-mix per label; given "ethernet" has zero stored samples, when compared, then the report states it has no data and shows no comparison numbers for it. | UC-006 | done |

**Priority values:** `Must` (product does not exist without it), `Should` (product is materially worse without it), `Could` (nice, cut it first), `Won't` (recorded so it is not re-litigated).

**Status values:** `not-started`, `in-slice-NNN`, `done`, `dropped`. netcheck started (2026-08-07) as a mature, already-shipped tool, where every FR reflected existing, tested behavior rather than a plan; FRs added since then (FR-015 onward) follow the normal `not-started` → `in-slice-NNN` → `done` lifecycle like any other requirement.

## 7. Non-functional requirements

| ID | Category | Requirement | Threshold | How it is measured | Status |
|---|---|---|---|---|---|
| NFR-001 | Portability | The system must run with no dependency outside the Python 3 standard library. | 0 third-party runtime imports in `netcheck/` | `grep` for non-stdlib imports in CI (`code-quality.yml`) | done |
| NFR-002 | Reliability | Every probe must be timeout-protected; none may block indefinitely on an unreachable device. | 100% of network calls in `probes.py`/`environ.py` carry an explicit timeout | Code inspection | done |
| NFR-003 | Data durability | SQLite is the source of truth; a failed Supabase push must never lose or falsely mark a local row as synced. | 0 rows lost or falsely marked on a failed push | `test_store.py::MirrorTest` | done |
| NFR-004 | Security | Credentials for the modem/router must never be committed to the repository or logged in plaintext. | 0 secrets in git history or logs | `tools/security_review.py` in CI | done |
| NFR-005 | Security | No subprocess or PowerShell call may build its command by string interpolation of a caller-supplied value. | 0 interpolated commands | `test_environ.py::PowerShellArgumentSafetyTest` | done |
| NFR-006 | Maintainability | Hermetic test suite: no live network calls, no sleeps beyond a probe's own timing, except explicitly-skippable fault-injection tests. | 0 flaky/networked tests in the default run | `python -m unittest discover -s tests -t .` in CI | done |
| NFR-007 | Cost | The tool must run with $0 required spend; Supabase mirroring is optional and on the free tier by design. | $0 required | Manual verification of `.env` optionality | done |
| NFR-008 | Availability | None, because this is a single-machine local tool with no hosted uptime commitment — the thing it measures is the user's own network, not itself. | - | - | - |
| NFR-009 | Performance | Each scan tier must complete within a fixed time budget so a routine check and a full investigation are never mistaken for a hang. | quick ≤ 10s; standard ≤ 60s (the existing `events()` PowerShell query alone measures ~21s); deep ≤ 120s | `cmd_scan`'s subprocess wall-clock ceiling is the actual enforcement mechanism (per-probe timeouts inside a tier can sum past its budget; the outer `timeout=budget` kill is what guarantees the tier never runs longer). `test_main.py::NFR009BudgetConstantsTest` pins the three budget numbers against drift; `test_main.py::ScanBudgetBoundaryTest` deterministically walks under/at/over-budget cases for all three tiers against a fake `subprocess.run` that models its documented timeout contract from an injected duration, with no live probe and no real sleep. `bash tools/check.sh` runs both in CI. One bounded manual smoke command remains for real hardware-dependent timing: `time python -m netcheck scan --tier deep` (or `quick`/`standard`) | done |
| NFR-010 | Security | The LAN exposure check (FR-019) must never send a request that modifies device state, must never attempt a credential outside its fixed documented list, and must never run against a host that fails `_on_lan()`. | 0 write requests issued by the exposure check; 0 credential attempts beyond the fixed list; 0 requests to a non-LAN host | Code inspection of `exposure.py`, plus `CredentialDestinationTest`-style tests asserting no request is sent to a host that fails `_on_lan()` | done |

## 8. Data requirements

| ID | Data item | Meaning in plain language | Source | Classification | Retention | Traces to |
|---|---|---|---|---|---|---|
| DR-001 | Sample row | One tick's measurement of every network layer | `probes.sample()` | internal | Unbounded locally; user-controlled deletion of `~/.netcheck/netcheck.db` | FR-001 |
| DR-002 | LLM error | A classified real API error scraped from a CLI transcript | Claude Code's `~/.claude/projects/**/*.jsonl` | internal (may reflect the user's own prompt/response timing, not content) | Unbounded locally | FR-002 |
| DR-003 | Environment scan | A full snapshot of Wi-Fi, driver, modem, and router state, including best-effort gateway manufacturer/model and SNMP scalars | `environ.scan()` | confidential (may include SSID, BSSID, adapter identity, gateway manufacturer/model) | Unbounded locally | FR-006, FR-015, FR-016 |
| DR-004 | Modem/router credentials | Login for optional device queries | User's `.env` file, gitignored | secret | Until the user removes them from `.env`; never written to the database | NFR-004 |
| DR-005 | Supabase mirror rows | A copy of samples/events/errors/scans on a remote Postgres project | `store.mirror()` | internal | Governed by the user's own Supabase project retention | FR-011 |
| DR-006 | LAN topology map | Device IP/MAC/name inventory of the user's own local network | `topology.py` (address-resolution table + SSDP) | confidential (a map of the user's home network) | Unbounded locally | FR-017 |
| DR-007 | LAN exposure finding | Which well-known port or which fixed default-credential-list entry matched on a mapped device | `exposure.py` | confidential (describes a live weakness in the user's own equipment) | Unbounded locally | FR-019 |
| DR-008 | WAN/hop geolocation | City/region/country string for the current WAN address | External geolocation API | internal (derived from an address that is already public to anyone the user connects to) | Unbounded locally | FR-020 |
| DR-009 | Experiment condition label | A user-chosen text label (e.g. "wifi") attached to a set of stored samples | `netcheck experiment --label` | internal | Unbounded locally | FR-021 |

Rules:

- Anything classified `PII` or `secret` must have a matching NFR describing how it is protected. DR-004 is covered by NFR-004. DR-007 is covered by NFR-010.
- Retention "unbounded" here is a decision, not an oversight: this is a diagnostic history tool where old samples remain useful evidence, and the user directly controls the database file.

## 9. Constraints

| ID | Constraint | Type | Source | Consequence |
|---|---|---|---|---|
| CON-001 | No `pip install`, no `npm install`, no build step. | technical | Project decision (`AGENTS.md`) | Every dependency choice is either "already in the stdlib" or "don't." |
| CON-002 | Tests use `unittest`, not a third-party test framework. | technical | Project decision, matches CON-001 | CI runs the same `python -m unittest` command and installs nothing. |
| CON-003 | Windows is the primary, most complete platform; macOS is partial; Linux has only cross-platform probe-level support. | technical | The tool was built against the maintainer's own Windows machine first | Some `environ.py` functions report `unavailable` on non-Windows platforms until ported. |
| CON-004 | ASUS routers and NETGEAR CAX80-style modems have no public write/read API; parsers are built against reverse-engineered or community-documented formats. | technical | Device vendor decision, outside this project's control | Some parsers (e.g. `parse_airport_info`, the ASUS write path) carry an unverified-against-live-hardware caveat until confirmed. SSDP discovery and generic SNMP scalars (FR-015, FR-016) add a best-effort, vendor-agnostic identification fallback for gateways that do not match the ASUS/NETGEAR-specific parsers, but do not replace those parsers for detailed DOCSIS/DPI diagnostics. |
| CON-005 | Wi-Fi diagnostic depth is limited to what the OS Wi-Fi driver reports through `netsh`/`airport` — RSSI, channel, and (where the OS exposes it) a noise or SNR figure. | technical | No dedicated RF hardware (spectrum analyzer) is present on a typical developer machine; measuring the radio signal itself, not just what the driver reports about it, needs that hardware | A spectrum-analyzer USB dongle becomes a supported, commonly-owned accessory |
| CON-006 | FR-019's exposure check uses a fixed, documented list of no more than 20 well-known factory-default credential pairs; it will miss any device with a custom or rotated password. | technical | Deliberate scope limit (OOS-007): this is a check for the most common, highest-impact mistake, not a credential-stuffing tool | Never — expanding the list is a routine content change, but the check stays fixed-list by design |

## 10. Assumptions

| ID | Assumption | How to verify | Cost if wrong | Status |
|---|---|---|---|---|
| ASM-001 | Claude Code's transcript format (`isApiErrorMessage`, `type: system`) is stable across CLI versions. | Re-run `test_llmlog.py`'s adversarial cases against a new CLI version's transcript sample | Error detection silently stops matching real errors | unverified |
| ASM-002 | A gap of more than 120 seconds between an error and the nearest sample means monitoring genuinely was not running, not that a sample was dropped. | Compare `watch`'s tick interval (default 20s) against observed gaps in real data | A real outage could be misreported as `unmonitored` if ticks are delayed for another reason | verified (matches `watch`'s default interval with margin) |

## 11. External interfaces

| ID | System | Direction | Protocol | Data exchanged | Failure behavior | Rate limit / cost |
|---|---|---|---|---|---|---|
| EXT-001 | Target LLM API (default `api.anthropic.com`) | outbound | HTTPS/TLS | A single reachability request (`GET /v1/models`); a 401 counts as reachable | Recorded as `fail` with a reason; never retried beyond the probe's own bounded retry | None known; low request volume |
| EXT-002 | Supabase project (optional) | outbound | HTTPS/PostgREST | Unsynced sample/event/error/scan rows | Push failure leaves rows unsynced for retry; local capture is unaffected | User's own Supabase plan limits |
| EXT-003 | Cable modem (optional) | outbound | HTTP, Basic Auth or vendor token auth | DOCSIS status page or device-specific status query | `unavailable` without credentials configured | None; local segment only |
| EXT-004 | Router (optional) | outbound | HTTP, ASUS token-auth flow | AiProtection/DPI status query, optional write for settings | `unavailable` without credentials configured | None; local segment only |
| EXT-005 | Anthropic status page | outbound | HTTPS | Public incident/status data | `unavailable` if unreachable | Public page, no known limit |
| EXT-006 | Geolocation API (e.g. `ipapi.co`) | outbound | HTTPS | The current WAN address (already public to anyone the user connects to); a city/region/country string returned | `unavailable` for the geolocation field only if unreachable | Free tier request limit of the chosen provider (e.g. 1,000/day); acceptable at one lookup per deep-tier scan, not per tick |

## 12. Success metrics

| ID | Metric | Definition (exact formula) | Baseline today | Target | Measured by | Review cadence |
|---|---|---|---|---|---|---|
| MET-001 | Unmonitored error rate | (LLM errors with verdict `unmonitored`) / (total LLM errors recorded) | Varies; near 100% before `watch` has run for a period | Trending down as `watch` uptime increases | `netcheck diagnose`'s verdict summary | Ad hoc, per diagnosis session |
| MET-002 | Test suite health | Passing tests / total tests, hermetic run | 100% (post-cleanup baseline) | 100%, always | `python -m unittest discover -s tests -t .` | Every commit (CI) |

**Gaming risk, MET-001:** running `watch` more often trivially improves this number without the underlying network getting any better — it is a coverage metric, not a health metric, and must always be read alongside the actual culprit ranking, never alone.

**Gaming risk, MET-002:** deleting a test that catches a real bug improves this number while making the product worse. `rules/06-TESTS.md`'s deletion-criterion discipline is the control against this.

## 13. Slice plan

netcheck is an already-built, shipped tool (Phases 1-28 in git history predate this PRD). This plan covers work from this document's creation forward.

| Slice | Name | What becomes true | Requirements delivered | Est. net LOC | Depends on |
|---|---|---|---|---|---|
| SL-000 | SDD scaffold + lean-code pass | `docs/PRD.md`, `docs/SYSTEM-REQUIREMENTS.md`, `docs/DATA-FLOW-DIAGRAM.md`, and `rules/` exist; fully-unreachable modules (`diagnostic_engine.py`, `fix_engine.py`, `fix_application.py`, `monitoring_engine.py`, `verification_engine.py`) and their tests are removed; `OPEN-ISSUES.md` is retired in favor of GitHub issues. | none (infrastructure + cleanup only) | negative (net deletion) | - |
| SL-001 | SSDP gateway identification | `remote.identify_gateway()` discovers the LAN gateway's manufacturer/model over SSDP and reports it in `environ.scan()`, guarded by the same LAN-only check as credentialed sections. | FR-015 | ~80 | - |
| SL-002 | Best-effort SNMP scalar probe | `netcheck/snmp.py` GETs `sysDescr`/`sysUpTime` from the modem host over SNMPv2c and reports it in `environ.scan()`, alongside (not replacing) `docsis.py`. | FR-016 | ~120 | - (turned out independent of SL-001; corrected from the original estimate) |
| SL-003 | Scan tiering flag | `netcheck scan --tier {quick,standard,deep}` selects which sections run; deep-tier sections (SL-004/005/006) are opt-in, not the default. | FR-018 | ~60 | - |
| SL-004 | LAN topology map | `netcheck/topology.py` parses address-resolution table output into a device list and merges in SSDP-discovered names. | FR-017 | ~100 | - |
| SL-005 | LAN exposure check | `netcheck/exposure.py` checks each mapped device for an open well-known port and the fixed default-credential list, guarded by `_on_lan()`. | FR-019 | ~140 | SL-004 |
| SL-006 | WAN/hop geolocation | Adds a geolocation lookup to the WAN section via a free HTTPS API. | FR-020 | ~60 | Q-003 answered |
| SL-007 | Controlled experiment mode | `netcheck experiment --label`/`--compare` tags sample runs and reports a side-by-side comparison. | FR-021 | ~120 | - |
| SL-008 | Whole-home pivot: synthesis interface + report reframing | `netcheck/synthesis.py` defines a provider-agnostic `Synthesizer` boundary (`NullSynthesizer` default, no live LLM call yet); `rank.py`'s CLI-transcript-derived cause is reworded to read as one evidence source among several, not the report's organizing purpose; this PRD's section 1 and OOS-001/OOS-005 record the pivot to a whole-home diagnostic tool. | none new (documentation + framing) | ~85 | - |

Future slices are chosen from open GitHub issues and this PRD's not-yet-`done` requirements. SL-001 through SL-008 are `done`. Every slice follows the same thin-slice, budget-respecting, test-first discipline (`bash tools/check.sh` green before merge) — "minimal lines of code for the functionality delivered" is a property of each slice's implementation, not of this document. New probing depth, the plan/simulation subsystem, and the execute/rollout subsystem are each their own future slice(s), scoped when picked up (see GitHub issues #93–#95 for the first wave).

## 14. Glossary

| Term | Definition (plain language) | Not to be confused with |
|---|---|---|
| Tick | One round of measuring every network layer, producing one sample row | An "event," which is something that happens at an arbitrary moment (like an idle-hold result), not on the tick schedule |
| Culprit | The single layer named as the likely cause of a broken sample row | "Verdict," which is the same idea applied to one correlated LLM error |
| Unmonitored | The verdict for an LLM error with no sample recorded near it | "Unavailable," which means a specific measurement could not be taken, not that nothing was watching at all |
| Burst | A group of LLM errors that arrived within 60 seconds of each other, counted as one event | Counting each individual retry as its own error |
| Far side | The AI provider's own infrastructure, past this tool's visibility | "Internet," which refers to the general path between the user and the far side, not the far side itself |
| Hermetic test | A test with no live network call and no sleep beyond a probe's own timing | A test that merely "usually passes" |
| Tier | One of three selectable scan depths: quick, standard, deep | "Slice," which is a unit of development work, not a runtime option |
| Topology map | The list of devices found on the local network, with IP/MAC/name | "Environment scan," which is this machine's own state, not other devices' |
| Exposure finding | One reported result from FR-019's check: an open port or a matched default-credential-list entry | A confirmed compromise — a finding is evidence to act on, not proof the device was actually breached |
| Condition label | The user-chosen text tag (e.g. "wifi") attaching a set of stored samples to one side of a comparison | "Culprit," which names a layer, not a labeled run |

## 15. Open questions

| ID | Question | Blocks | Owner | Needed by | Answer |
|---|---|---|---|---|---|
| Q-001 | Should automated fix-application (recommend → apply → verify → monitor) be rebuilt, and if so, wired to what command? | A future slice reintroducing that capability | Kyle Smith | When next requested | Open — the prior unwired implementation was removed 2026-08-07; see the corresponding GitHub issue |
| Q-002 | Is Linux support (beyond the cross-platform pieces of `probes.py`) worth building, given the primary machine is Windows? | Any Linux-specific `environ.py` work | Kyle Smith | When needed | Open |
| Q-003 | `ipapi.co` is named in EXT-006 as an example free HTTPS geolocation provider; is it the one to actually build against, or is there a preferred alternate? | SL-006 implementation | Kyle Smith | Before SL-006 starts | Open |

## 16. Change log

| Date | Version | Change | Reason | Affected IDs |
|---|---|---|---|---|
| 2026-08-07 | 1.0.0 | Initial PRD written against the already-shipped tool, as part of adopting SDD documentation and a lean-code cleanup pass. Retired `OPEN-ISSUES.md`; unresolved items filed as GitHub issues. | User requested SDD scaffolding (PRD + mandatory docs + rules) and a simplification pass. | All |
| 2026-08-08 | 1.1.0 | Narrowed OOS-005 to explicitly permit read-only, vendor-agnostic gateway identification (it still excludes user-configurable arbitrary-host monitoring). Added FR-015 (SSDP gateway identification) and FR-016 (best-effort SNMP MIB-II scalar GET, DOCSIS table OIDs explicitly out of scope). Updated CON-004 and DR-003 to note the new identification data. Added SL-001/SL-002 to the slice plan. | User asked for the tool to identify/diagnose any router or modem more generically, research-backed and scoped to stay stdlib-only and KISS. | OOS-005, FR-015, FR-016, CON-004, DR-003, UC-003 |
| 2026-08-08 | 1.2.0 | FR-016 shipped: `netcheck/snmp.py` (hand-rolled SNMPv2c GET) and `remote.modem_snmp()`, wired into `environ.scan()` as `modem_snmp`. | SL-002 implementation. | FR-016 |
| 2026-08-08 | 1.2.0 | FR-015 shipped: `netcheck/ssdp.py` (SSDP/UPnP discovery) and `remote.identify_gateway()`, wired into `environ.scan()` as `gateway_id`. | SL-001 implementation. | FR-015 |
| 2026-08-08 | 1.3.0 | Added tiered scanning (FR-018), a LAN topology map (FR-017), a LAN device exposure check bounded to detection-only against a fixed default-credential list (FR-019), WAN/hop geolocation (FR-020), and a controlled-experiment comparison mode (FR-021). Added UC-005/UC-006, NFR-009 (per-tier performance budget, replacing "otherworldly performance" with concrete numbers) and NFR-010 (exposure-check safety ceiling), DR-006 through DR-009, CON-005 (RF diagnostic depth is bounded by OS driver APIs, not raw spectrum data) and CON-006 (the credential list is deliberately fixed, not a stuffing tool), OOS-006 (no packet capture) and OOS-007 (no exploitation beyond the fixed list), EXT-006, four new glossary terms, Q-003, and SL-003 through SL-007. | User asked for a much broader, "professional grade" diagnostic scope (mapping, tiered depth, extreme logging, geographic component, a controlled-experiment method, and exposure/"back door" scanning), with explicit direction to translate every part of that ask into specific, unambiguous PRD requirements rather than vague language, while keeping each future slice minimal-LOC and test-gated. Three scope-bounding questions (exposure-scan reach, packet capture vs. CON-001, geolocation data source) were confirmed with the user before writing this amendment. | OOS-005, OOS-006, OOS-007, UC-005, UC-006, FR-017, FR-018, FR-019, FR-020, FR-021, NFR-009, NFR-010, DR-006, DR-007, DR-008, DR-009, CON-005, CON-006, EXT-006, Q-003 |
| 2026-08-08 | 1.4.0 | FR-017 shipped: `netcheck/topology.py` parses `arp -a` (Windows/macOS) / `ip neigh` (Linux) address-resolution output into an IP/MAC device list and attaches the SSDP-identified gateway's name to whichever mapped IP matches it, wired into `environ.scan()` as `topology`. `ssdp.identify_gateway()` gained an `ip` field (the LOCATION host, port stripped) so callers can cross-reference it against other IP-keyed data; no other behavior of that function changed. | SL-004 implementation. | FR-017 |
| 2026-08-08 | 1.5.0 | FR-020 and FR-021 marked `done` (shipped as PR #47/#48, landed without a PRD update at the time to avoid repeated conflicts on this file). FR-018 shipped: `environ.scan(deep=...)` gates `topology` and `remote.wan()`'s `geo` sub-key behind the deep tier; `netcheck scan --tier {quick,standard,deep}` selects it, with `quick` reusing `probe`'s FR-001 measurement instead of a full scan. `_ingest_errors` moved to `llmlog.ingest()` and the `watch` command's loop moved to `netcheck/watch.py`, both to keep `__main__.py` under its 250-line budget as CLI surface grew. | SL-003 implementation; SL-006/SL-007 status reconciliation. | FR-018, FR-020, FR-021 |
| 2026-08-08 | 1.5.1 | Completed the reconciliation the 1.5.0 entry above already described but did not finish: the FR-020/FR-021 table rows still read `not-started` despite this file's own changelog and the shipped code (`netcheck/geoip.py`, `netcheck/experiment.py`, both tested and wired in) saying otherwise. Table rows now read `done`, matching reality. No code or test changed. | `kgsmith19/agent-engineering-standard` migration verification pass, checking the merged migration (#51) against this file. | FR-020, FR-021 |
| 2026-08-08 | 1.5.2 | Added OOS-008 (optional config file), OOS-009 (CLI test subcommands), OOS-010 (`mtu probe_all`) — the three "still undecided" items from GitHub issue #38 — as explicit out-of-scope decisions. Both unmerged branches (`claude/network-diagnostics-ui-5ortgo`, `claude/network-diagnostics-ui-cont-4cl3r9`) and 25 stale merged branches deleted following the decision. No code or test changed. | Issue #38 close-out: owner agreed to record the three open items as out of scope and delete all stale branches. | OOS-008, OOS-009, OOS-010 |
| 2026-08-08 | 1.5.3 | Corrected the 1.5.2 entry above: the branch deletion it describes never happened. `git push --delete` is blocked by this environment's destructive-action classifier, both for the two out-of-scope branches and for the 25 stale merged ones, with no error surfaced to the agent that wrote 1.5.2. Of those 25, 15 (`claude/loop-goal-4umvxd`, `claude/spec-driven-dev-continue-41309l`, `tmp-probe-delete`, and the twelve `claude/phase-{2,3,4,5,6,7,8,9,10,12,13,14}-*` branches) are independently confirmed here as literal ancestors of `main` via `git branch -r --merged`, but the delete attempt for those was blocked the same way. The OOS-008/009/010 decisions themselves stand; only the "deleted following the decision" claim is false. | Doc-accuracy pass: `git branch -r` on the actual remote still showed all 29 non-`main` branches present, contradicting this file's own record. | none |
| 2026-08-10 | 1.5.4 | NFR-009 marked `done`: `test_main.py::NFR009BudgetConstantsTest` and `test_main.py::ScanBudgetBoundaryTest` turn the tier timing budgets into an automated, hermetic regression check (a fake `subprocess.run` models its documented timeout contract from an injected duration, walking under/at/over-budget cases for quick/standard/deep without a live probe or a real sleep), replacing the "manual run, recorded in notes" evidence the row previously pointed at. No production code changed; `cmd_scan`'s existing hard subprocess wall-clock ceiling was already the real enforcement mechanism. | Issue #71: NFR-009 was `not-started` with only a manual-note evidence trail. | NFR-009 |
| 2026-08-10 | 1.6.0 | **Product pivot: whole-home diagnostic tool.** Section 1 rewritten so the LLM-transcript correlation is one input to a general report, not the tool's organizing purpose. OOS-001 (never auto-apply a fix) and OOS-005 (never a general-purpose monitor) marked superseded — not deleted, since parts of each still hold (R4 device-write review; no scanning of arbitrary third-party hosts). `netcheck/synthesis.py` added: a provider-agnostic `Synthesizer` boundary for a future LLM-driven research/synthesis step, shipping only a no-op `NullSynthesizer` today. `rank.py`'s `llm_error_bursts` evidence/fix text reworded to describe itself as one evidence source, not the report's premise — its cause key, confidence, and evidence semantics are unchanged. Added SL-008. Filed GitHub issues #93 (this synthesis interface, done), #94 (this reframing + PRD update, done), and #95 (module reorganization into `probes/`/`report/`/`io/` subpackages — deferred, R3, needs Kyle's manual review since it touches protected paths). The plan (simulation) and execute (signed-agreement rollout) subsystems described in the pivot discussion are explicitly not started; each needs its own spec before implementation per `AGENTS.md`'s "Issue alone can't unambiguously define correct behavior" bar. | User-requested pivot (2026-08-10 design discussion): netcheck's vision widened from a single LLM-API-connection diagnostic to a general whole-home network diagnostic (modem, router, Wi-Fi, ISP, devices), eventually adding AI-driven synthesis and, in later work, a plan/execute remediation workflow. | OOS-001, OOS-005, SL-008 |

---

## Appendix A: PRD self-check (GATE-PRD)

- [x] Section 1 is understandable by a ten-year-old.
- [x] Every FR is testable as written, with concrete values in its acceptance criterion.
- [x] Every NFR has a number and a measurement method (NFR-008 explicitly states "None, because...").
- [x] No banned word appears (robust, seamless, intuitive, scalable, simple, flexible, appropriate, as needed...).
- [x] Out-of-scope section is non-empty.
- [x] Every term used more than once appears in the Glossary exactly once.
- [x] Every data item classified PII or secret has a matching protective NFR.
- [x] Every metric has a stated gaming risk.
- [x] The slice plan's first entry reflects the actual current work (SDD scaffold + cleanup), since this PRD is written against an already-shipped product rather than a greenfield one.
- [x] No unfilled `<placeholder>` remains.
- [x] Every FR/NFR has a Status value.
- [x] Two requirements do not contradict each other.
