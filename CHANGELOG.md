# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning is [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`, bumped
with `python tools/release.py bump {major,minor,patch}` (see
`docs/DEPLOYMENT.md` for the full release process). Draft entries for a new
release with `python tools/release.py changelog`, which lists commit
subjects since the last tag — the entry itself still gets a human editorial
pass, not full automation.

## [Unreleased]

### Added
- `netcheck --version` (Phase 28).
- Automatic SQLite schema migration: an existing user's database now picks
  up columns added to `schema.sql` after they first installed, instead of
  silently missing them forever (Phase 28).
- `tools/release.py`: version bump + changelog-draft helper (Phase 28).
- `Dockerfile` / `.dockerignore` for container deployment (Phase 28).
- Dashboard: packet-loss/jitter trend chart, click-to-drill-down on ranked
  causes, JSON/CSV export, print-to-PDF (Phase 27).
- macOS backend for `environ.wifi()` via `airport -I` (Phase 26).
- Bounded retry on `probes.resolve()` for transient DNS failures (Phase 26).
- `netcheck/cache.py`: shared TTL cache; `nat_diagnostics`/`cgnat_diagnostics`
  now share one WAN-IP lookup instead of two (Phase 25).
- `all_diagnostics.AllDiagnostics.run_all()` now runs its seven phases
  concurrently (Phase 25).
- `tools/profile_diagnostics.py`: per-phase runtime/memory profiling
  (Phase 25).
- `docs/API.md`, `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md`,
  `docs/CONTRIBUTING.md`, rewritten `docs/ARCHITECTURE.md` (Phase 24).

### Fixed
- `docs/DEVELOPMENT.md` told contributors to `pip install -e .` against a
  stdlib-only project with no `setup.py`/`pyproject.toml` (Phase 24).
- Seven diagnostic-module docstrings cited a hypothesis number that didn't
  match the canonical 15-hypothesis list (Phase 24).
- `OPEN-ISSUES.md` #6 (malformed `?limit=` crashing the server) was already
  fixed in code but never marked retired (Phase 27).

## [1.0.0] — first tagged release

Consolidates Phases 1–23: the core probe/correlation engine, all 15
canonical failure hypotheses, the six Phase 16–21 additional diagnostic
modules (modem, NAT, CGNAT, Anthropic status, interference, router), the
unified `full-check` runner, and end-to-end fault-injection tests. See
`docs/ARCHITECTURE.md` for the full module map and `git log` for the
phase-by-phase history predating this file.
