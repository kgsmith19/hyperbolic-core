# AGENTS.md

## 🎯 Purpose

Local-first network diagnostics that identify which layer failed: Wi-Fi,
router, modem, ISP, target service, or a specific device. The tool correlates
multi-layer probes and can compare them with errors already recorded in
Claude Code transcripts. Python 3.12 standard library only, no build step;
the dashboard (`frontend/`) is hand-written HTML/CSS/JS with zero
dependencies.

This application follows the Toolbelt root delivery workflow. Its
implementation choices and product safeguards remain local to this
directory.

## 📋 Product Boundaries

- Every probe returns `state` as `ok`, `fail`, or `unavailable`.
  `unavailable` means the measurement could not be made and is never fault
  evidence.
- Parsers are pure functions over text. Tests use captured fixtures and do not
  invoke live platform commands.
- Transcript classification uses structured error markers, never raw substring
  matching.
- SQLite is the source of truth. Supabase is an optional mirror, and a failed
  push leaves rows available for retry.
- Device credentials are sent only after every resolved destination address is
  confirmed private.
- Every write requires a recorded dry run and an explicit interactive
  approval, and the only automatic write permitted is the pre-recorded
  rollback of a change that just failed verification. Config-changing scripts
  and templates stay disabled (fail-closed) until they have an exact, verified
  inverse. Approval capabilities are single-use HMAC tokens; SQLite stores
  only their digest, and apply reads one from a real TTY, never argv or the
  environment.
- New diagnoses are added as data in `rank._SCAN_RULES` when the existing
  model can express them (positive and healthy counterexample tests plus an
  actionable `_FIXES` entry); avoid a new module without a concrete need.
- The runtime stays dependency-free (Python standard library only) unless a
  linked Issue establishes a concrete need.
- Add hermetic behavior tests before or with any behavior change. Preserve
  unrelated work and do not weaken checks or diagnostics to make a change
  pass.
- **Network egress**: `tool.json` enumerates every static destination the
  application uses (public DNS control, default router/modem addresses, SSDP
  multicast, Anthropic API/status, public-IP and geolocation lookups). The
  runtime-discovered/overridden local router or modem address and the optional
  per-deployment Supabase mirror (`SUPABASE_URL`) are the only destinations
  not fixed in the manifest — that is a documented limitation of the static
  shape, not permission for other unlisted egress.

## 📂 Layout

```
tool.json          the app manifest, read by the Toolbelt validators
backend/           the Python CLI, dashboard server, tests, tooling, Dockerfile
frontend/          the dashboard the server serves, plus its Playwright spec
docs/              product documentation
```

The table below maps each backend module to what it owns.

| Path | Responsibility |
|---|---|
| `backend/network_checker/probes.py` | Per-tick reachability, latency, TLS, HTTP, and idle-hold measurements |
| `backend/network_checker/resolver.py` | Name resolution, including DNS over UDP |
| `backend/network_checker/dualstack.py` | Separate IPv4 and IPv6 reachability |
| `backend/network_checker/route.py` | Default gateway and first ISP hop |
| `backend/network_checker/wlan_probes.py` | Windows and macOS Wi-Fi output parsers |
| `backend/network_checker/linux_adapter_probes.py` | Read-only Linux adapter power and transmit-power probes |
| `backend/network_checker/docsis.py` | DOCSIS status parsing |
| `backend/network_checker/ssdp.py` | SSDP/UPnP gateway discovery |
| `backend/network_checker/snmp.py` | Scoped SNMPv2c scalar reads |
| `backend/network_checker/topology.py` | LAN device map: the address-resolution table (`arp -a`/`ip neigh`) parsed into IP/MAC pairs, with the SSDP-identified gateway named |
| `backend/network_checker/exposure.py` | Deep-tier, detection-only LAN exposure checks: open management ports and default-credential acceptance, read requests only |
| `backend/network_checker/environ.py` | Local system and network snapshot |
| `backend/network_checker/remote.py` | Modem, router, WAN, and provider status |
| `backend/network_checker/geoip.py` | Coarse WAN geolocation; failures remain `unavailable` |
| `backend/network_checker/llmlog.py` | Transcript error extraction and classification |
| `backend/network_checker/watch.py` | Continuous sampling loop |
| `backend/network_checker/store.py` | SQLite persistence and optional mirror |
| `backend/network_checker/inventory.py` | Device, interface, and configuration-item rows mapped from a collected scan payload, plus their queries |
| `backend/network_checker/change*.py` | Consent-gated change lifecycle, protected approval capabilities, bounded verification, and restricted process execution; no write template is enabled until it has an exact verified inverse |
| `backend/network_checker/diagnose.py`, `network_checker/rank.py` | Evidence correlation and ranked causes |
| `backend/network_checker/experiment.py` | Two labeled probe runs compared: per-layer median latency and state mix |
| `backend/network_checker/bundle.py` | Redacted evidence bundle assembled from stored data for export |
| `backend/network_checker/server.py` | Loopback dashboard server: JSON API, SSE push, static files |
| `frontend/` | Dashboard UI — HTML/CSS/JS, no backend logic, no dependencies |

## ⚙️ Commands

Run from `apps/toolbelt/apps/network-checker/`.

```bash
python -m unittest discover -s tests -t .
bash backend/tools/check.sh
python -m network_checker watch
python -m network_checker probe
python -m network_checker scan
python -m network_checker diagnose
python -m network_checker serve
python -m network_checker sync
```

`bash backend/tools/check.sh` is the local equivalent of CI. It runs the test suite,
complexity checks, the deterministic security scanner, documentation checks,
and shell syntax checks.

## 📚 Documentation

- `README.md` — user-facing quick start and commands
- `backend/pyproject.toml` — build metadata only, so `pip install -e .` gives
  a discoverable `network-checker` console command; version is sourced from
  `network_checker/__init__.py`, never restated. Adds no runtime dependency
  and no required build step; `python -m network_checker` never needs it.
- `docs/notes/` — runbooks and design notes, including deployment and releases
- `docs/archived/2026-08-16/network-checker-CHANGELOG.md` (repo root) — what changed, by version (consumed by the release
  workflow's release-notes extraction)
- `TEST_LEDGER.md` — this app's own test suites
- The hyperbolic-core root's `.github/workflows/toolbelt-ci.yml` runs
  automatically for pull requests, sharing its composite action with the
  `Toolbelt` job of the root's `pr-verify.yml` -- one of seven lanes that
  all run in parallel -- and executes `backend/tools/check.sh`.
- The hyperbolic-core root's `.github/workflows/toolbelt-network-checker-release.yml`
  is a separate manual workflow that validates this application, builds and
  smoke-tests the container, and creates a draft release.

This app does not keep committed requirements/data-flow documents. Known
problems, decisions under investigation, and future work belong in GitHub
Issues.

## ✅ Completion

GitHub Issues are the durable source for requested work. Implement one
focused slice on a short-lived branch, run `bash backend/tools/check.sh`, and
open a pull request that links the Issue and states the evidence. A change is
ready when the hyperbolic-core root's `Toolbelt` reports success.

## 🔒 Collaboration Boundary

AI coding agents may create branches, commits, Issues, and pull requests only
when explicitly assigned that work. They must not submit code reviews,
approve or block a pull request, request reviewers, or post unsolicited
comments. They may answer in an Issue or pull request only when explicitly
mentioned and asked a direct question.
