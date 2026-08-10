# guards - Agentic Command Center

Independent guard rail + control panel for Claude Code sessions on this machine.
`hooks/guard.mjs` is a PreToolUse hook (registered in `~/.claude/settings.json`
for `Edit|Write|NotebookEdit|Read`, all projects); `hooks/engine.mjs` is the CLI
engine that owns every state change; the **web Command Center**
(`npm run gui` → `http://127.0.0.1:43117`) is the user's GUI on top — every
surface lives there: toggle, protections, and requests (SPEC-0002), vault
(SPEC-0003), the spending tab — 7-day spend + tier, policy dials, emergency
STOP/Resume/fan-out (SPEC-0004) — and Start work — folder suggestion, profile,
directive create + headless launch, live list, log tails (SPEC-0005). The
WinForms shell and the ConPTY/keystroke continuity stack were deleted in
SPEC-0005 PR-2 (ADR-0005); `gui/README.md` is the API contract, and ADR-0006
moves the UI's future to its own repo with these built-in pages serving until
parity. The web vault route pipes each `KEY=VALUE` to `engine.mjs
vault-import` over **stdin** — a value never becomes argv, a log line, a
filesystem path, or a response field, and the browser clears the input on
save; key names are env-var-shaped and single-line-value-validated so the
stdin framing can't be forged. The web spending dials do a read-merge-write of
`policy.json` preserving every unowned key, and the process controls are an
allowlisted action map (no browser string becomes argv). The `/approve` skill
(`~/.claude/skills/approve/`) is the user's in-chat Run button.

## Shared engineering standard

This repo is migrated against `kgsmith19/agent-engineering-standard`, pinned
at the sha in `.agent/standard.lock` — bump that file explicitly to upgrade,
never track the standard's moving branch. Machine-readable facts (verified
commands, CI jobs, risk defaults, protected paths) live in
`.agent/project.yaml`. The standard's docs stay in its own repo, not copied
here; this section only maps its vocabulary onto what this repo already has,
since most of it predates the standard and already satisfies its intent:

| Standard concept | This repo's equivalent |
|---|---|
| Product Truth (PRD) | `docs/PRD.md` (rule 1 of `rules/00-CORE.md`'s source-of-truth order) |
| SPEC | `specs/active/*.md` / `specs/done/*.md` (`rules/05-SPECS.md`) |
| ADR | `docs/adr/ADR-NNNN-*.md` |
| Durable work item | a GitHub Issue — already the practice here, not new |
| Evidence / RED → GREEN | "Testing doctrine" below + `rules/06-TESTS.md` + `specs/TEST-LEDGER.md` |
| Risk levels (R0–R4) | not yet labeled on Issues (see `.agent/project.yaml`); `rules/00-CORE.md`'s halt conditions (H1–H10) cover the same ground today — an unset variable, a missing test, a new dependency, a destructive action, all halt and ask rather than proceed |
| Protect the control plane | this file, `rules/`, the guard/vault/kernel evaluators — an implementing agent does not weaken or bypass them mid-slice; see "What the guard enforces" below |
| Least privilege / autonomy | this repo's own halt conditions + the guard's protected-path list (`config.json`) + the runbox handoff for anything touching guard machinery or `~/.claude/settings.json` |

Do not create a second work-tracking system, a second PRD, or a second rules
file to satisfy the standard — extend what is here.

## What the guard enforces (in order)

1. **Secrets** — files whose basename matches a `secrets` glob in `config.json`
   (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `vault.json`) can be neither
   read nor written by agent tools, so keys never enter a conversation.
2. **Self-protection** — currently **OFF**: `C:/code/guards` is not in the
   `protected` list (removed deliberately during the ACC build-out phase). Once
   the ACC directive closes, it should be re-added (`C:/code/guards/` in full, or
   specifically `C:/code/guards/gui/`) to block
   agent edits of the harness itself. When re-protected, only `~/.claude/settings.json`
   will remain guarded. Exception when re-enabled: runboxes (below).
3. **Cell ownership** — repos listed under `repos` in `config.json` have path
   prefixes owned by cells. Matching is by the **target file's path**, never
   the session folder, so a session launched from a parent directory is
   guarded identically. A write to a cell-owned path is blocked unless
   `.agents/task.json` in that repo declares the owning cell.

Failure mode is **closed**: unreadable payload or config blocks with a message
instead of silently allowing. Known ceiling: only tools in the matcher are
seen — Bash writes bypass the hook. Convention enforcer, not a security boundary.

**Runbox scripts and self-protection:** the guard refuses a DIRECT edit to its
own machinery or to `~/.claude/settings.json`, but a runbox script achieving
the same edit runs with Kyle's full authority once he runs it. Since SPEC-0005
PR-2 there is **no unattended auto-run**: the autoApprove daemon lived inside
the deleted watcher, so every runbox script now waits for a human — `/approve`
in chat or the web Run button. (The former OI-032 accepted-risk note described
the unattended path; it died with the watcher. Reviving auto-run would be a
new Node feature with its own spec and review.)

## The vault — how agents receive secrets

The user uploads KEY=VALUE pairs via the web GUI ("Passwords and keys") into
`vault.json` (gitignored, plaintext on disk, read-blocked for agent tools).
Agents consume them **by name, never by value**:

- `node C:/code/guards/hooks/engine.mjs vault-keys` — list available key names.
- `node C:/code/guards/hooks/engine.mjs apply <targetFile> <KEY...>` — upsert
  `KEY=value` lines into an env-format file (UTF-8 BOM safe). Values flow
  vault → file directly; never print them, never read the target file afterward.

If a key is missing, `apply` fails naming it — ask the user to add it in the
GUI, don't ask for the value in chat.

## Runboxes — handing blocked work to the user

Runboxes are the only agent-writable spots under guard protection. There is a
central one (`runbox/` here) plus one per watched project folder
(`<project>/.guards/runbox`, created by `projects-add`; `.guards` is
self-gitignored so it never enters the project's git).

When an agent hits something it can't or shouldn't do (guard block, permission
wall, elevated op, secret value), it writes a **self-contained script** there
(`.ps1`, `.cmd`, `.bat`, `.mjs`, `.js`) and tells the user. The user runs it by
typing **`/approve` in chat** (the skill previews, runs via the engine, and
reports back) or from the web GUI's "Claude's requests" section. Scripts run
with the user's authority.

Rules for scripts:
- Leading comment says what it does and why — that line is the preview summary.
- Prefer the project's own runbox when the project is watched; central otherwise.
- Minimal, idempotent, side-effect-obvious. Never print secret values.
- Standing scripts (re-run buttons like `lifeos-mcp-setup.ps1`) put
  `# guards: keep` in the first 10 lines; everything else is one-shot.
- **Never leave undo/uninstall scripts in the runbox** (guards OI-008). Undo
  scripts live tracked in their own directory and are run deliberately.
- **If the operation needs Windows-level elevation, the script should
  self-elevate, not fail and wait.** Kyle, 2026-08-04 (guards OI-025): the
  user typing `/approve` or `/approve-kgs` IS the authorization for whatever
  the script's leading comment says it does, including elevated work — that
  is the entire point of the runbox handoff, not something to route around
  it for. A script that needs admin rights (e.g. `Register-ScheduledTask`)
  should check `[Security.Principal.WindowsPrincipal]` and, if not already
  elevated, relaunch itself once via `Start-Process -Verb RunAs -Wait
  -PassThru` and propagate the child's exit code — this pops a real UAC
  prompt on Kyle's own desktop, which is his moment-of-use confirmation, not
  a bypass. See `runbox/install-claude-cap-gate.ps1` for the pattern.

Lifecycle (engine-owned):
- `run <name | label:name>` executes a script with the project folder as cwd.
  On success a one-shot script is **auto-archived** into that runbox's
  `.trash/` (hidden, timestamped); keep-marked scripts stay. On failure it
  stays put for retry.
- `trash <ref>` archives without running; `restore <ref>` undoes; `trash-list`
  shows what's archived. Trash is the undo layer — nothing in guards truly
  deletes a script except the user (GUI "Empty trash" button or a manual file
  delete). **Agents must never run `flush`.**
- `list [--json]` shows every pending script across all runboxes.

## Toggle / config

- Web GUI: `npm run gui` → `http://127.0.0.1:43117/guards` → header toggle.
  CLI: `engine.mjs toggle on|off`.
- Takes effect on the next tool call — no session restart.
- `config.json`: `secrets` globs, `protected` paths, `projects` (watched
  folders — each gets a `.guards` drop-box), and per-repo cell maps under
  `repos` (keyed by absolute repo path, forward slashes). Secrets, locked
  paths, and watched folders are all editable from the GUI; cell maps by
  editing `config.json` directly.

## Spending & process controls (web)

The `/guards` page's spending section is the process control plane for token
discipline. It shells `hooks/usage.mjs week|check` for the rolling 7-day spend
and tier light, and edits `policy.json` in place (context soft/hard k, week
amber/red token thresholds, subagent allowlist, finder cap) — hooks re-read
that file on every fire, so edits apply with no restart. It also
writes/removes `runner\stop\slice-runner.stop` (STOP / Resume; Resume shells
`hooks/budget.mjs unstop`, which also flushes the tier cache) and can grant a
30-minute fan-out window (`hooks/budget.mjs fanout 30`).

## Kernel (headless task runner)

`kernel/run.mjs <contract.json>` runs one AI coding harness at a time under a
deny-by-default boundary the harness cannot widen, verifies the real
end-state independently of what the harness claims, records every run in one
structured ledger (`node kernel/ledger.mjs query ...`), and tightens its own
ceilings after a run of failures — all separate from, and untouched by, the
directive loop above. See `kernel/README.md` for the contract shape, the
harness-swap procedure (one config value plus one new file under
`kernel/adapters/`), and the honest guard ceilings.

## The regression, exactly

```
npm run test:windows
    -> FAST TIER, hermetic (the full node list; `npm test` is the same list —
       they are identical since the demolition, kept as two scripts so a
       Windows-only suite can rejoin test:windows without touching CI).
       Run from C:\code\guards; never `node --test hooks/` (the runner grades
       the directory as one bogus failing test). `package.json` is the single
       source of truth for the lists so this block and CI cannot drift apart
       silently again.
node hooks/covgate.mjs
    -> COVERAGE GATE. Runs the fast tier under node's built-in coverage and
       fails any CHANGED lib file under the policy floors (lines/funcs 100,
       branches 90). Changed = git diff vs HEAD + untracked.
node kernel/kernel.e2e.mjs
    -> PROOF TIER. Spawns a REAL claude twice via kernel/run.mjs and spends
       tokens, so run it deliberately. 1 an in-scope edit is allowed, made,
       and independently verified; 2 the same contract with writeRoots
       elsewhere is denied, the file stays untouched, and the run is
       rejected; a third check confirms no ACC directive-loop state leaks from a
       kernel run into the live repo.
node runner/runner.mjs directive:<id>
    -> PROOF TIER (SL-008, re-targeted by ADR-0005). One real, low-stakes
       directive run headless to completion, watched — the proof that FR-011
       holds on real work. Spends real tokens; run deliberately.
powershell -File shim/claude.test.ps1
powershell -File watcher/claude-cap-watch.test.ps1
powershell -File watcher/install-cap-watch-task.test.ps1
    -> FAST TIER, hermetic, PowerShell. Pure functions only: the launch-cap
       breach/fail-open decision, the ACC-ClaudeCapWatch task spec (registers
       nothing), and the shim's own cap-gate decision. Run by the
       windows-integration CI job and listed here for manual runs. To actually
       register the Scheduled Task these pure functions describe, Kyle runs
       `powershell -File watcher/install-cap-watch-task.ps1` by hand (self-
       elevating, idempotent) — nothing in the automated test suite does this.
npm run e2e:gui
    -> GUI e2e. Playwright drives gui/kernel.html AND gui/guards.html against
       gui/server.mjs in a sandbox (fake engine/usage/budget/runner via
       ACC_ENGINE/ACC_USAGE/ACC_BUDGET/ACC_RUNNER — e2e can never mutate real
       config, spend, or spawn a real claude); runs headless in CI (gui-e2e
       job), single worker (specs share one sandbox dir). On a machine whose
       preinstalled browser revision differs from the package pin, point
       ACC_PW_CHROMIUM at a system Chromium.
```

**Never run a hook by hand against live state.** A hand-run hook can touch
live directive state (`bindSession`, `setStatus`, cycle logging) — always
sandbox: `ACC_ROOT=<throwaway> ACC_POLICY=<file> node hooks/budget.mjs`.
`bindSession` refuses to rebind a directive's session on anything that isn't
UUID-shaped (guards OI-006 — a hand-piped payload once hijacked a live
binding), but the sandbox rule stands regardless.

The suites that touch runner state (`budget`, `route`) sandbox themselves via
`ACC_ROOT` + `ACC_POLICY`, so they can never reset the live `runner\state`
running sessions depend on.

## The launch lane — why automated claude spawns never race

`hooks/lane.mjs`. One account, many loops: the slice-runner (`claude -p` per
board task), the proof tier, and the directive loop all open real API streams, and
concurrent bursts died in transport as `econnreset` (2026-07-31, during test
firing). Every AUTOMATED spawn now goes through `withLaunchSlot`: a
machine-wide slot semaphore (`policy.json lane.slots`, default 1 — strict
serial), a paced start (`minGapMs`), and `retryTransport` — exponential
backoff with full jitter on TRANSPORT failures only (econnreset/429/5xx);
a logic failure returns untouched on the first try, because retrying a real
bug only spends tokens hiding it. Slot state lives in `os.tmpdir()/acc-lane`
(never `ACC_ROOT` — a sandboxed lane could not exclude the live runner, which
is the whole point). A slot records owner pid + ttl, so a crashed holder is
reclaimed, never wedged. **Interactive launches (Kyle's own terminals) bypass
the lane on purpose** — a human must never queue behind a 3-hour runner hold;
the web GO button's launch goes through the runner, which holds an automation
slot per run like every other automated spawn. The machine-wide `lane.total`
cap (shim/claude.cmd + `lane.mjs gate`, ADR-0003) is the hard ceiling that
catches every launch path. Never spawn a real claude from automation without
the lane. Tests: `node --test hooks/lane.test.mjs`.

## Testing doctrine — the contract every implementation carries

`hooks/testplan.mjs` (UserPromptSubmit, advisory like route.mjs) injects the
contract once per session when a prompt starts implementation planning. The
contract, which is also simply the house rule: every acceptance criterion maps
1:1 to tests — unit (pure logic) and integration (process/filesystem boundary)
in the fast tier, hermetic, sandboxed via `ACC_ROOT`/`ACC_POLICY`/`ACC_LANE_DIR`;
e2e only for cross-process promises, in the proof tier, always through the
lane. Tests are written RED FIRST and the red run is recorded in the slice
log — a test born green proves nothing. Done means: fast tier green,
`node hooks/covgate.mjs` green, and the relevant proof scenario green when
loop behavior changed. covgate holds every CHANGED lib file to the policy
floors — lines 100 / functions 100 / branches 90 — three floors because line
coverage alone lies (a never-called function still shows covered declaration
lines). Coverage is a floor, not the goal: assert observable behavior, one
behavior per test, no sleeps outside the lane's own pacing.
Building runner.mjs's suite surfaced and fixed two real bugs beyond coverage:
`runClaudeOnce`'s timeout used to orphan the real claude process on a hang
(`child.kill()` under `shell:true` only signals the shell wrapper — `killTree`
now signals the whole process group on POSIX / the PID tree via `taskkill /t`
on Windows), and `retryTransport` had two structurally dead branches which
covgate's own branch floor caught and forced a real fix rather than a
manufactured test.

## Worktrees — isolating large parallel work

Kyle, 2026-08-04: worktrees are approved standing guidance for large,
independent chunks of work — no prior rule here forbade them, this section
just makes the approval explicit and discoverable. Use `git worktree add`
(sibling directory, not nested inside this repo) to isolate a chunk from the
main working tree, do the full implement-test-verify cycle there on its own
branch, then merge back into `main` once its own fast tier + `covgate` are
green. Don't reach for a worktree by default — one isolated tree per small
fix is bloat; it earns its keep when two or more chunks would otherwise
collide on the same files/branch at once, or a chunk is large enough that
keeping the main tree clean for other work matters.

## Directives — how work survives a context limit

A **directive** is a piece of work that outlives the session doing it. The web
Start-work page creates one (`hooks/directive.mjs new --text-file`) and
launches the headless runner for it; from then on the loop runs with no human
in it:

`node runner\runner.mjs directive:<id>` relaunches `claude -p` per fresh
context with `ACC_DIRECTIVE=<id>` (and the directive's stored profile as
`ACC_PROFILE`); each session's SessionStart hook injects the directive text,
the progress-log tail, and the done/blocked protocol; the Stop hook appends
the closing summary as the next cycle's handoff; the runner's stuck brake
(identical consecutive summaries), `maxRuns`, `runTimeoutMin`, red-week-tier
hold, launch lane, and pid-file singleton (one loop per directive,
machine-wide, exit 6) bound the loop. `runner/README.md` has the full
contract.

State: `runner\directives\<id>.json` plus a running `<id>.log.md`, archived to
`runner\directives\done\` on completion. **The loop only ends because the model
ends it** — `directive.mjs done <id>` or `directive.mjs blocked <id> --why
"..."`, both stated in full in the injected block — or because a human closes
it from the web list (Mark finished / Stop restarting). A **stale "active"
directive** nobody is running is curated by hand from that list; nothing reaps
automatically (the console-liveness reaper died with the console binding).

An **interactive** session bound to a directive that hits its context budget
stops at a message naming the exact resume command — the human types `/clear`
and relaunches headless (or clicks Launch on the Start-work page). There is no
auto-clear: the machinery that typed keystrokes into consoles was deleted
(ADR-0005), and the runner relaunch IS the clear on the headless path.

Directive text never becomes keystrokes or argv anywhere in this chain: it
reaches the store via `--text-file` and reaches the model through SessionStart
context injection.

Tests: `node --test hooks/directive.test.mjs`, plus the directive-job and
singleton groups in `runner/runner.test.mjs`.

**Outcome receipts** (FR-015, issue #68): the moment a directive leaves
`active` — `done`/`blocked`/`dead`, or a runner budget-ceiling halt — one
bounded, durable JSON receipt is written to
`runner\directives\receipts\<id>.receipt.json` (`hooks/receipt.mjs`),
derived entirely from the existing directive record, `hooks/directive-spend.mjs`,
and the directive log — no new telemetry store. `writeReceiptOnce` never
overwrites an existing file, so a retried terminal transition never
duplicates it. See `runner/README.md` for the field list. Tests:
`node --test hooks/receipt.test.mjs`, plus the receipt assertions in
`hooks/directive.test.mjs` and `runner/runner.test.mjs`.

`/directive <condition>` (user skill, still at `~\.claude\skills\goal\` on disk as of
2026-08-07 — that path is outside this repo, so renaming it is Kyle's own manual
step on his machine, not something this rename touched) is ACC-native: it
logs `CONDITION: <text>` into the active directive's log via `directive.mjs log`, so the
directive rides the directive store and survives every context reset with the
rest of the handoff; `/directive clear` logs `CONDITION MET`. It never registers
a session Stop hook: a Stop-gate fights the budget gate (OI-011) — the loop
continues BY ending turns — so conditions live in directive state, not hooks.
With no active directive the condition is session-local only.

## Folder routing (Start work)

`hooks/route.mjs` scores task text against the table in `..\ROUTING.md` and
names the narrowest folder the work belongs in. Two callers: the web
Start-work page preselects the launch folder from the task line
(`/api/route/suggest` shells `route.mjs --text "..."`), and a
`UserPromptSubmit` hook scopes each task in-session — it fires on every prompt
but emits only when the verdict *moves*, so a task switch re-scopes and ten
prompts about one thing cost one line.

It biases narrow on purpose: only an exact tie escalates, because widening one
rung mid-task is cheap and starting too wide is invisible. Every verdict carries
`parent`, the next rung up. A prompt with no signals changes nothing. The hook
is **purely advisory** — the deny/auto-cd/queued-prompt channel died with the
keystroke stack (SPEC-0005 PR-2); a verdict that differs from the session cwd
is one injected line the model acts on itself.

Signals live in `ROUTING.md`, not in the code; edit that JSON block when a repo
is added. Tests: `node --test hooks/route.test.mjs`.
