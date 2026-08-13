# guards runner

External loop that relaunches `claude -p` headless, one board task per
session — fresh context per task by construction (a live session cannot
/clear itself; a new process needs no clearing). No daemon: run it by hand
or let Windows Task Scheduler own time.

    node runner/runner.mjs slice-runner            # loop now
    node runner/runner.mjs slice-runner --once     # one run (debug)
    node runner/runner.mjs slice-runner --install  # schtasks entry (needs job.schedule)
    node runner/runner.mjs slice-runner --status   # log tail + alerts

Job spec (`jobs/<name>.json`): `name`, `workdir`, `bootstrap` (the -p
prompt), `statusFile` (progress = its hash changes between runs),
`doneMarker` (a whole line in statusFile exactly equal to this ends the loop), optional
`maxStuck` (default 3 — consecutive no-progress runs before alert+stop),
`maxRuns` (100), `runTimeoutMin` (180), `schedule` ({"type":"daily",
"time":"HH:MM"}, only needed for --install).

Directive jobs (SPEC-0001, ADR-0001/0004 — the headless continuity path):

    node runner/runner.mjs directive:<id>           # run a directive to completion
    node runner/runner.mjs directive:<id> --once    # one run (debug)

No job file: the directive store supplies workdir (its `cwd` — required) and
identity; the bootstrap is only the kick constant because the SessionStart
hook injects the full directive context (text, progress log tail, done/blocked
protocol) into any child carrying `ACC_DIRECTIVE`. Done = the directive's own
status leaves `active` (the model ran `directive.mjs done|blocked`). Progress =
the run's closing summary changed from the previous run's (each run's summary
is appended to the directive log — it is both the next fresh context's
continuity and the stuck signal; a model repeating itself verbatim is the
headless stuck mode). A RED week tier holds the loop before any spawn
(exit 5) — same `usage.mjs check` verb the Command Center consults, same fail-open on an
unreadable usage store. Directives can also carry their own hard ceilings
(`budget.wallClockMin`, `turns`, `tokens`, `dollars`): wall-clock shrinks the
next run's timeout to the remaining total budget, turns shrink `--max-turns`,
and token/dollar ceilings halt the loop before another run starts (exit 7,
alert + directive-log entry). `--install` is refused for directive jobs (they are
ad-hoc, not scheduled).

Design constraints (deliberate):
- Sessions run WITHOUT --bare: the guard hook stack is the safety layer
  that makes headless bypassPermissions acceptable. Never add --bare.
- Stop conditions are the job's, not the model's: done-marker, stuck-N
  (alert file in alerts/), maxRuns, per-run timeout, and directive hard
  ceilings. Alerts + exit codes (2 stuck, 3 maxRuns, 4 graceful stop: create
  stop/<job>.stop, honored between runs, 5 red week tier held a directive job,
  6 another loop already runs this job — the pid-file singleton in
  state/<job>.pid, SPEC-0005, 7 directive hard ceiling hit) are the operator
  surface; logs rotate at 1 MiB.
- One loop instance per job at a time (enforced: exclusive-create pid file
  in state/, exit 6 for the loser); nothing here mutates guards state
  (config/vault untouched) — the runner only reads its own folder and the
  job workdir's status file.

Outcome receipts (FR-015, issue #68): every time a directive leaves `active`
— `done`/`blocked`/`dead` via `hooks/directive.mjs`'s `setStatus`, or a
runner budget-ceiling halt (exit 7) — exactly one bounded JSON receipt is
written to `runner/directives/receipts/<id>.receipt.json` (`hooks/receipt.mjs`).
It carries status, started/finished/duration, cycle and fresh-context counts,
profile, spend (`directive-spend.mjs`), the directive's budget, a bounded
why/blocker classification, a few bounded "verification" lines pulled from
the run's own closing summary, and best-effort branch/PR/Issue links found in
that text — never a raw log, prompt, or secret. `writeReceiptOnce` never
overwrites an existing receipt, so a retried terminal transition (or a
budget halt re-evaluated on a later loop restart, since a budget halt does
NOT change the directive's own `active` status) can never duplicate it.

Next job candidates: doc-sync (audit docs vs reality across repos, open
docs-only PRs), weekly doctor pass.
