# Deployment Guide

## Why there's no `pip install netcheck`

This project is Python standard library only — no pip, no npm, no build
step, a hard constraint (`AGENTS.md`). That means there's also no
`setup.py`/`pyproject.toml` and nothing to publish to PyPI or a Homebrew
formula: both require a build step this project deliberately doesn't have.
Packaging here means: clone it, run it.

```bash
git clone https://github.com/kgsmith19/network-checker
cd network-checker
python -m netcheck full-check --format quick
```

That's the entire "install." See `docs/QUICKSTART.md` for day-to-day usage.

## Local deployment

The intended use: `netcheck watch` running on the same machine whose network
you're diagnosing, writing to `~/.netcheck/netcheck.db` (override with
`NETCHECK_DB`). Most of what makes this tool useful — Wi-Fi driver settings,
the Windows event log, modem/router credentials in a local `.env` — is
inherently host-specific and doesn't cross a network boundary meaningfully.
Run it directly on the machine you care about, not through a wrapper.

For a headless box you want to check on remotely, pair `netcheck watch` with
`netcheck serve` and reach the dashboard over SSH port-forwarding
(`ssh -L 8787:localhost:8787 host`) rather than exposing it — `server.py`
binds to `127.0.0.1` only and has no auth, on purpose (see its module
docstring).

## Container deployment

```bash
docker build -t netcheck .
docker run --rm -v netcheck-data:/data netcheck full-check --format quick
docker run --rm -v netcheck-data:/data -p 8787:8787 netcheck serve --no-open
```

**What actually works in a container, and what doesn't.** `environ.py`'s
Wi-Fi/driver/event-log/MTU/TCP-globals checks shell out to Windows tools
(`netsh`, PowerShell) or, since Phase 26, macOS's `airport` — none of which
exist in the `python:3.12-slim` Linux image the `Dockerfile` uses. Inside a
container those sections report `unavailable`, same as they would on any
Linux host missing those binaries — not a fabricated `ok`, per the
three-state model in `AGENTS.md`. What does work fully in a container:

- `netcheck full-check`'s NAT/CGNAT/Anthropic-status/router checks (pure
  HTTP/socket work)
- `netcheck probe`/`diagnose`'s gateway/ISP-hop/internet/DNS/TLS/HTTP layers
- `netcheck serve` reading an existing `netcheck.db` (mount it read-only to
  view history collected elsewhere)

In short: containerizing this tool makes most sense for the far-side and
raw-connectivity checks, or for viewing/mirroring data collected on a real
host — not as a drop-in replacement for running it directly on the machine
whose Wi-Fi you're debugging.

## Cloud deployment

There's no server-side component to deploy — the whole design point is that
SQLite on the local disk is the only thing that can record an outage while
it's happening (`README.md`). The one cloud-shaped piece is the **optional**
Supabase mirror (`SUPABASE_URL`/`SUPABASE_KEY` in `.env`), which exists
purely to let `netcheck serve` on a second machine see history from the
first. Setting it up:

1. A Supabase (or self-hosted PostgREST) project running the schema in
   `supabase/migrations/0001_init.sql`.
2. `SUPABASE_KEY` is the **service role** key, not the publishable one — RLS
   is on with no policies, so the publishable key deliberately cannot write.
   Keep this key wherever your `.env` already lives; it never belongs in the
   image or a committed file.
3. `netcheck sync` (or `watch`'s automatic per-tick mirror) pushes unsynced
   rows. A push that fails leaves rows unsynced for retry — it never marks
   a row done that didn't actually make it (`store.mirror`).

Running `netcheck watch` itself on a cloud VM only makes sense if that VM's
network path *is* the thing you're diagnosing (e.g. an origin server's
outbound connectivity) — it cannot tell you about a laptop's Wi-Fi from a
data center.

## Releases

**As of 2026-08-06, `.github/workflows/release.yml` triggers on manual
`workflow_dispatch` only** -- pushing a `vX.Y.Z` tag no longer runs
anything by itself (see `.github/workflows/README.md` for why: the CI
workflows were burning through the account's Actions minutes quota on
every push). Building and smoke-testing the release image is now a local
step (`tools/deploy.sh`); only dispatch the GitHub workflow when you
specifically want the published GitHub Release + downloadable artifact.

To cut a release:

```bash
python tools/release.py bump patch   # or minor / major
python tools/release.py changelog    # draft entries; paste into CHANGELOG.md under [Unreleased]
# move the [Unreleased] section to a new ## [X.Y.Z] heading, commit
git tag vX.Y.Z
git push origin vX.Y.Z
bash tools/deploy.sh                 # local checks + build + smoke-test + save the image
```

`tools/deploy.sh` runs `tools/check.sh` first, builds `netcheck:vX.Y.Z`,
smoke-tests it (`--version` and a real `full-check`), and saves it as
`netcheck-image-vX.Y.Z.tar.gz`. It prints the `git tag`/`gh release create`
commands to publish from there if you want a GitHub Release; or dispatch
the "Release" workflow manually from the Actions tab (picking the `vX.Y.Z`
tag in "Use workflow from") to have CI build the image and open the draft
release instead.

## Upgrade path for existing users

**Local SQLite.** `store.open_db()` now migrates automatically: any column
present in `schema.sql` but missing from an already-existing on-disk table
gets added via `ALTER TABLE ... ADD COLUMN` the next time it's opened,
before this project had that mechanism, a schema change would have been
silently absent from every database created before it. Migrated columns are
always nullable regardless of what `schema.sql` declares (SQLite requires a
non-NULL default to add a `NOT NULL` column to a non-empty table, and a
migration that can fail on an existing database defeats the point of having
one) — existing rows simply read back `NULL`/`None` for a column that
didn't exist yet when they were written, which is exactly what should
happen; nothing is backfilled or guessed.

**Supabase mirror.** Schema changes there are tracked as numbered files
under `supabase/migrations/`, applied in order — there is currently only
`0001_init.sql`. A future schema change adds `0002_*.sql` alongside it
rather than editing `0001` in place.

**No breaking config format changes to date.** `.env` keys, the CLI's
subcommands, and `NETCHECK_DB`/`NETCHECK_TARGET` have been additive-only
since the original design (`docs/superpowers/specs/2026-08-04-netcheck-design.md`).
If that ever changes, it belongs in `CHANGELOG.md` under a `### Changed`
heading with an explicit migration note, not silently.
