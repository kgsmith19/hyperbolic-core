# netcheck — front door

Local-first network diagnostic. Names *which layer* breaks LLM API connections
by correlating multi-layer probes against errors already recorded in Claude
Code transcripts.

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
| `netcheck/probes.py` | Per-tick measurement; pure parsers over command output |
| `netcheck/environ.py` | Wi-Fi, driver, event log, MTU, Tailscale, modem, router |
| `netcheck/llmlog.py` | Transcript scraping, error classification, offsets |
| `netcheck/store.py` | SQLite schema and writes; Supabase mirror |
| `netcheck/diagnose.py` | Culprit rules, correlation, ranked causes |
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

**Tests are hermetic.** No network, no sleeps beyond a probe's own timing, no
shared state. Add the test before the code and watch it fail first.
