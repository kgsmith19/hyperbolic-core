# netcheck

Local-first network diagnostics that identify which layer failed: Wi-Fi,
router, modem, ISP, target service, or a specific device. The tool correlates
multi-layer probes and can compare them with errors already recorded in Claude
Code transcripts.

Stack: Python 3.12 standard library only. There is no package install or build
step. Tests use `unittest`; the dashboard (`frontend/`) is hand-written
HTML/CSS/JS with zero dependencies, vendored or otherwise — native ES
modules, Server-Sent Events, and a Service Worker cover what a small
framework used to.

This application follows the Toolbelt root delivery workflow. Its implementation
choices and product safeguards remain local to this directory.

## Product invariants

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
  rollback of a change that just failed verification.

## Network egress

`tool.json` enumerates every static destination used by the application:
the public DNS control (`1.1.1.1`), default router/modem addresses
(`192.168.50.1`, `192.168.100.1`), SSDP multicast (`239.255.255.250`),
Anthropic API/status, public-IP lookup, and coarse geolocation endpoints.

Two destinations are necessarily dynamic and cannot be represented by the
manifest's fixed-hostname array: the runtime-discovered or operator-overridden
local router/modem address, and the optional per-deployment Supabase mirror
from `SUPABASE_URL`. This is a documented limitation of the static manifest
shape, not permission for unlisted fixed egress.

## Commands

Run from `apps/toolbelt/apps/network-checker/`.

```bash
python -m unittest discover -s tests -t .
bash tools/check.sh
python -m netcheck watch
python -m netcheck probe
python -m netcheck scan
python -m netcheck diagnose
python -m netcheck serve
python -m netcheck sync
```

`bash tools/check.sh` is the local equivalent of CI. It runs the test suite,
complexity checks, the deterministic security scanner, documentation checks,
and shell syntax checks.

## Layout

| Path | Responsibility |
|---|---|
| `netcheck/probes.py` | Per-tick reachability, latency, TLS, HTTP, and idle-hold measurements |
| `netcheck/resolver.py` | Name resolution, including DNS over UDP |
| `netcheck/dualstack.py` | Separate IPv4 and IPv6 reachability |
| `netcheck/route.py` | Default gateway and first ISP hop |
| `netcheck/wlan_probes.py` | Windows and macOS Wi-Fi output parsers |
| `netcheck/linux_adapter_probes.py` | Read-only Linux adapter power and transmit-power probes |
| `netcheck/docsis.py` | DOCSIS status parsing |
| `netcheck/ssdp.py` | SSDP/UPnP gateway discovery |
| `netcheck/snmp.py` | Scoped SNMPv2c scalar reads |
| `netcheck/topology.py` | LAN device map: the address-resolution table (`arp -a`/`ip neigh`) parsed into IP/MAC pairs, with the SSDP-identified gateway named |
| `netcheck/exposure.py` | Deep-tier, detection-only LAN exposure checks: open management ports and default-credential acceptance, read requests only |
| `netcheck/environ.py` | Local system and network snapshot |
| `netcheck/remote.py` | Modem, router, WAN, and provider status |
| `netcheck/geoip.py` | Coarse WAN geolocation; failures remain `unavailable` |
| `netcheck/llmlog.py` | Transcript error extraction and classification |
| `netcheck/watch.py` | Continuous sampling loop |
| `netcheck/store.py` | SQLite persistence and optional mirror |
| `netcheck/inventory.py` | Device, interface, and configuration-item rows mapped from a collected scan payload, plus their queries |
| `netcheck/change*.py` | Consent-gated change lifecycle, protected approval capabilities, bounded verification, and restricted process execution; no write template is enabled until it has an exact verified inverse |
| `netcheck/diagnose.py`, `netcheck/rank.py` | Evidence correlation and ranked causes |
| `netcheck/experiment.py` | Two labeled probe runs compared: per-layer median latency and state mix |
| `netcheck/bundle.py` | Redacted evidence bundle assembled from stored data for export |
| `netcheck/server.py` | Loopback dashboard server: JSON API, SSE push, static files |
| `frontend/` | Dashboard UI — HTML/CSS/JS, no backend logic, no dependencies |

## Engineering guidance

- Prefer the smallest clear change that fully satisfies the linked Issue.
- Preserve the standard-library-only constraint.
- Add hermetic behavior tests before or with behavior changes.
- Add a diagnostic as data in `rank._SCAN_RULES` when the existing model can
  express it; do not add a module without a concrete need.
- Each new cause needs positive and healthy counterexample tests plus an
  actionable `_FIXES` entry.
- Preserve unrelated work and do not weaken checks to make a change pass.

## Work and delivery

GitHub Issues are the durable source for requested work. Implement one focused
slice on a short-lived branch, run `bash tools/check.sh`, and open a pull
request that links the Issue and states the evidence.

The hyperbolic-core root's `.github/workflows/toolbelt-ci.yml` runs
automatically for pull requests (this project now lives at `apps/toolbelt/`
inside the hyperbolic-core monorepo, so the workflow file is no longer under
this project's own root). Its workflow and required check are both named
`Toolbelt PR Gate`; it executes the same `tools/check.sh` command used
locally.

The hyperbolic-core root's `.github/workflows/toolbelt-network-checker-release.yml`
is a separate manual workflow that validates this application, builds and
smoke-tests the container, and creates a draft release.

AI coding agents may create branches, commits, Issues, and pull requests only
when explicitly assigned that work. They must not submit code reviews, approve
or block a pull request, request reviewers, or post unsolicited comments. They
may answer in an Issue or pull request only when explicitly mentioned and
asked a direct question.

This app does not keep committed requirements/data-flow documents. Known
problems, decisions under investigation, and future work belong in GitHub
Issues.
