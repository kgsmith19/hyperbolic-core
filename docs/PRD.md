---
title: netcheck Product Requirements Document
status: living
created: 2026-08-07
updated: 2026-08-08
owner: Kyle Smith
version: 1.2.0
---

# netcheck PRD

> **This document is the source of truth.** Code, specs, and tests derive from it. If reality differs from this document, one of them is wrong and it gets fixed the same day. This is a living document: it is updated as requirements are discovered, and every change is logged in section 16.
>
> **Writing standard:** every line must pass the four-reader test (a child, a business person, a programmer, and an LLM must all read it the same way). No adjective without a number. See `rules/03-WRITING.md`.

---

## 1. What this is

This is a program that runs on your computer and tells you which part of your internet connection broke when an AI coding tool loses connection — your Wi-Fi, your router, your internet provider, or the AI company's own servers. It watches your network in the background and writes down what it sees, so that when something breaks, there is already evidence instead of a guess. It works on one computer at a time. It costs nothing to run and needs nothing installed beyond Python, which most computers already have.

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

### 4.2 Out of scope (non-goals)

| ID | Not doing | Why not | Revisit when |
|---|---|---|---|
| OOS-001 | Automatically applying a fix to a router or modem without being asked | A wrong automated write to networking hardware can take a household offline with no easy recovery; this tool's device-fix code was built once, never wired to a command, and removed as dead code (2026-08-07, see GitHub issue for the removed capability) | A specific, explicitly-invoked command is designed and reviewed for it |
| OOS-002 | Monitoring more than one machine from a single running instance | Each machine's Wi-Fi/router/ISP path is independent; the Supabase mirror already covers "read history from elsewhere" without needing a controller process | A user asks for fleet monitoring |
| OOS-003 | Any dependency requiring `pip install` or a build step | Python standard library only is a deliberate hard constraint (see `AGENTS.md`); it keeps the tool runnable on a machine mid-outage with no working package registry | Never |
| OOS-004 | Diagnosing problems inside the AI provider's own infrastructure beyond "is their status page reporting an incident" | This tool has no visibility past its own network path; anything past the far side's edge is the provider's responsibility | Never |
| OOS-005 | A general-purpose network monitor for arbitrary hosts/services chosen by the user at runtime | The entire design — the LLM-transcript correlation, the fix suggestions — is built around one target: an LLM API endpoint used by a coding CLI. Read-only identification of the user's own LAN gateway (FR-015, FR-016) is in scope because it improves diagnosis of that one fixed target's path — it does not let the tool monitor a host the user names at runtime | A second, clearly distinct target use case, or user-configurable arbitrary-host monitoring, is requested |

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

**Priority values:** `Must` (product does not exist without it), `Should` (product is materially worse without it), `Could` (nice, cut it first), `Won't` (recorded so it is not re-litigated).

**Status values:** `not-started`, `in-slice-NNN`, `done`, `dropped`. As of this document's creation, netcheck is a mature, already-shipped tool — every FR above reflects existing, tested behavior, not a plan.

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

## 8. Data requirements

| ID | Data item | Meaning in plain language | Source | Classification | Retention | Traces to |
|---|---|---|---|---|---|---|
| DR-001 | Sample row | One tick's measurement of every network layer | `probes.sample()` | internal | Unbounded locally; user-controlled deletion of `~/.netcheck/netcheck.db` | FR-001 |
| DR-002 | LLM error | A classified real API error scraped from a CLI transcript | Claude Code's `~/.claude/projects/**/*.jsonl` | internal (may reflect the user's own prompt/response timing, not content) | Unbounded locally | FR-002 |
| DR-003 | Environment scan | A full snapshot of Wi-Fi, driver, modem, and router state, including best-effort gateway manufacturer/model and SNMP scalars | `environ.scan()` | confidential (may include SSID, BSSID, adapter identity, gateway manufacturer/model) | Unbounded locally | FR-006, FR-015, FR-016 |
| DR-004 | Modem/router credentials | Login for optional device queries | User's `.env` file, gitignored | secret | Until the user removes them from `.env`; never written to the database | NFR-004 |
| DR-005 | Supabase mirror rows | A copy of samples/events/errors/scans on a remote Postgres project | `store.mirror()` | internal | Governed by the user's own Supabase project retention | FR-011 |

Rules:

- Anything classified `PII` or `secret` must have a matching NFR describing how it is protected. DR-004 is covered by NFR-004.
- Retention "unbounded" here is a decision, not an oversight: this is a diagnostic history tool where old samples remain useful evidence, and the user directly controls the database file.

## 9. Constraints

| ID | Constraint | Type | Source | Consequence |
|---|---|---|---|---|
| CON-001 | No `pip install`, no `npm install`, no build step. | technical | Project decision (`AGENTS.md`) | Every dependency choice is either "already in the stdlib" or "don't." |
| CON-002 | Tests use `unittest`, not a third-party test framework. | technical | Project decision, matches CON-001 | CI runs the same `python -m unittest` command and installs nothing. |
| CON-003 | Windows is the primary, most complete platform; macOS is partial; Linux has only cross-platform probe-level support. | technical | The tool was built against the maintainer's own Windows machine first | Some `environ.py` functions report `unavailable` on non-Windows platforms until ported. |
| CON-004 | ASUS routers and NETGEAR CAX80-style modems have no public write/read API; parsers are built against reverse-engineered or community-documented formats. | technical | Device vendor decision, outside this project's control | Some parsers (e.g. `parse_airport_info`, the ASUS write path) carry an unverified-against-live-hardware caveat until confirmed. SSDP discovery and generic SNMP scalars (FR-015, FR-016) add a best-effort, vendor-agnostic identification fallback for gateways that do not match the ASUS/NETGEAR-specific parsers, but do not replace those parsers for detailed DOCSIS/DPI diagnostics. |

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

Future slices are chosen from open GitHub issues and this PRD's not-yet-`done` requirements. SL-001 and SL-002 are both `done`.

## 14. Glossary

| Term | Definition (plain language) | Not to be confused with |
|---|---|---|
| Tick | One round of measuring every network layer, producing one sample row | An "event," which is something that happens at an arbitrary moment (like an idle-hold result), not on the tick schedule |
| Culprit | The single layer named as the likely cause of a broken sample row | "Verdict," which is the same idea applied to one correlated LLM error |
| Unmonitored | The verdict for an LLM error with no sample recorded near it | "Unavailable," which means a specific measurement could not be taken, not that nothing was watching at all |
| Burst | A group of LLM errors that arrived within 60 seconds of each other, counted as one event | Counting each individual retry as its own error |
| Far side | The AI provider's own infrastructure, past this tool's visibility | "Internet," which refers to the general path between the user and the far side, not the far side itself |
| Hermetic test | A test with no live network call and no sleep beyond a probe's own timing | A test that merely "usually passes" |

## 15. Open questions

| ID | Question | Blocks | Owner | Needed by | Answer |
|---|---|---|---|---|---|
| Q-001 | Should automated fix-application (recommend → apply → verify → monitor) be rebuilt, and if so, wired to what command? | A future slice reintroducing that capability | Kyle Smith | When next requested | Open — the prior unwired implementation was removed 2026-08-07; see the corresponding GitHub issue |
| Q-002 | Is Linux support (beyond the cross-platform pieces of `probes.py`) worth building, given the primary machine is Windows? | Any Linux-specific `environ.py` work | Kyle Smith | When needed | Open |

## 16. Change log

| Date | Version | Change | Reason | Affected IDs |
|---|---|---|---|---|
| 2026-08-07 | 1.0.0 | Initial PRD written against the already-shipped tool, as part of adopting SDD documentation and a lean-code cleanup pass. Retired `OPEN-ISSUES.md`; unresolved items filed as GitHub issues. | User requested SDD scaffolding (PRD + mandatory docs + rules) and a simplification pass. | All |
| 2026-08-08 | 1.1.0 | Narrowed OOS-005 to explicitly permit read-only, vendor-agnostic gateway identification (it still excludes user-configurable arbitrary-host monitoring). Added FR-015 (SSDP gateway identification) and FR-016 (best-effort SNMP MIB-II scalar GET, DOCSIS table OIDs explicitly out of scope). Updated CON-004 and DR-003 to note the new identification data. Added SL-001/SL-002 to the slice plan. | User asked for the tool to identify/diagnose any router or modem more generically, research-backed and scoped to stay stdlib-only and KISS. | OOS-005, FR-015, FR-016, CON-004, DR-003, UC-003 |
| 2026-08-08 | 1.2.0 | FR-016 shipped: `netcheck/snmp.py` (hand-rolled SNMPv2c GET) and `remote.modem_snmp()`, wired into `environ.scan()` as `modem_snmp`. | SL-002 implementation. | FR-016 |
| 2026-08-08 | 1.2.0 | FR-015 shipped: `netcheck/ssdp.py` (SSDP/UPnP discovery) and `remote.identify_gateway()`, wired into `environ.scan()` as `gateway_id`. | SL-001 implementation. | FR-015 |

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
