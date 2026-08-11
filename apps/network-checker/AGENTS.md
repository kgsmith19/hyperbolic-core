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

The shared [agent-engineering-standard](https://github.com/kgsmith19/agent-engineering-standard)
is an experimental, informational reference pinned in `.agent/standard.lock`.
This repository owns its implementation choices and CI.

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
- Automated device configuration writes are outside the product's scope.

## Commands

Run from the repository root.

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
| `netcheck/docsis.py` | DOCSIS status parsing |
| `netcheck/ssdp.py` | SSDP/UPnP gateway discovery |
| `netcheck/snmp.py` | Scoped SNMPv2c scalar reads |
| `netcheck/environ.py` | Local system and network snapshot |
| `netcheck/remote.py` | Modem, router, WAN, and provider status |
| `netcheck/llmlog.py` | Transcript error extraction and classification |
| `netcheck/watch.py` | Continuous sampling loop |
| `netcheck/store.py` | SQLite persistence and optional mirror |
| `netcheck/diagnose.py`, `netcheck/rank.py` | Evidence correlation and ranked causes |
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

`.github/workflows/ci.yml` runs automatically for pull requests. Its workflow
and required check are both named `PR Gate`; it executes the same
`tools/check.sh` command used locally. Native GitHub squash auto-merge may
merge the pull request after repository settings require that check.

`.github/workflows/release.yml` is a separate manual workflow that validates
the repository, builds and smoke-tests the container, and creates a draft
release.

AI coding agents may create branches, commits, Issues, and pull requests only
when explicitly assigned that work. They must not submit code reviews, approve
or block a pull request, request reviewers, or post unsolicited comments. They
may answer in an Issue or pull request only when explicitly mentioned and
asked a direct question.

Product requirements and data-flow details live in
`docs/SYSTEM-REQUIREMENTS.md` and `docs/DATA-FLOW-DIAGRAM.md`. Known
problems, decisions under investigation, and future work belong in GitHub
Issues.
