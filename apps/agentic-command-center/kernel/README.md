# The ACC Reliability Kernel

One task contract in, one ledger record out. It runs a single AI coding
harness at a time under a deny-by-default boundary the harness cannot widen,
verifies the real end-state independently of what the harness claims, records
every run in one structured ledger, and tightens its own ceilings after a
run of failures.

```
node kernel/run.mjs <contract.json>
```

Two distinct failure shapes, never conflated: **refused** (the contract is
incomplete or unsafe — no runId, no ledger entry, nothing ever spawned) and
**failed-to-start** (the contract was fine but the harness would not launch —
that IS a run and it gets the full `run_started`/`run_finalized` pair).
Outcomes are a closed set: `accepted`, `rejected`, `aborted-by-budget`,
`failed-to-start`, `refused`.

## The contract

A JSON file with these required fields (`kernel/contract.mjs`):

```jsonc
{
  "goal": "what the harness is told to do, verbatim",
  "constraints": ["free-text constraints appended to the prompt"],
  "allowedActions": {
    "readRoots": [],      // absolute paths Read/Glob/Grep may see
    "writeRoots": [],     // absolute paths Edit/Write may touch
    "bashPatterns": [],   // command PREFIXES Bash may start with
    "networkHosts": [],   // hostnames WebFetch/WebSearch may reach
    "vaultKeys": [],      // vault key NAMES this run's env may hold
    "subagents": []       // Agent subagent_type values this run may launch
  },
  "budget": { "wallClockMin": 60, "toolCalls": 200, "tokens": 500000 },
  "acceptanceCriteria": [
    { "id": "AC1", "ears": "THE SYSTEM SHALL ...",
      "verify": { "method": "file_exists|file_contains|command|git_clean", "...": "..." } }
  ],
  "rollbackPlan": "free text — how a human undoes this if it goes wrong"
}
```

Every `allowedActions` array is optional (empty/absent grants nothing for
that key), but `acceptanceCriteria` must be non-empty and every criterion
must name a real `verify.method` — a run whose outcome cannot be checked is
refused before a harness process exists. A `writeRoots` entry that overlaps
this repo or the user's `~/.claude` tree is refused before launch,
regardless of contract (`kernel/policy.mjs` `alwaysDenyWriteRoots`).

## Swapping the harness — step by step

1. Write `kernel/adapters/<name>.mjs` exporting exactly five members plus an
   id: `id`, `identity()`, `startTask()`, `sendStep()`, `readState()`,
   `stopTask()` — the shape `kernel/adapter.mjs`'s `ADAPTER_INTERFACE` checks.
2. Set `policy.json`'s `kernel.harness` to `<name>`.
3. Run `node --test kernel/adapter.test.mjs` — the shape check and the
   isolation test are what prove the swap needs no other change.

No file outside `kernel/adapters/` mentions a harness by name. The module
path is derived from the configured name by convention
(`./adapters/<name>.mjs`), so a swap is exactly one config value and one new
file — never a registry table to edit.

## The boundary and its honest ceilings

Two independent layers. `--tools` is a real allowlist over the CLI's built-in
tool set, derived from which `allowedActions` arrays are non-empty — a tool
the contract grants no authority to does not exist for the run at all. The
kernel guardhook (`kernel/guardhook.mjs`, registered on every tool that does
exist) then enforces the *arguments* of those tools on every fire, reading
the contract and policy live — a policy edit or a contract check applies to
the very next tool call, not the next run.

Documented ceilings, honestly, not hidden: an ALLOWED Bash command can still
do something unintended inside its allowance. `WebSearch` has no host to
scope — a contract can only grant or withhold searching as a whole. This is
a deterministic process-level boundary, not an OS sandbox.

The toolCalls ceiling itself tightens live: the guardhook computes it via the
same `effectiveCeilings(contract, policy, autonomy)` the supervisor uses, on
every fire, so an autonomy-tightened factor applies to the very next tool
call — no tick-interval latency gap. Wall-clock and stall detection remain
the supervisor's, checked at each `checkpointMin` tick.

A harness that hangs silently — including one hung because the upstream API
itself is overloaded and the CLI never surfaces that as an error — is bounded
by the same ceilings as any other failure mode. `checkpointVerdict` (called
from `kernel/run.mjs`'s supervisor tick) never reads the harness child's
stdout, stderr, or exit code; it only compares elapsed wall-clock time,
accumulated tokens, and tool-call counts against `effectiveCeilings`. A
silent hang starves the token and tool-call signals too — both stay flat —
so detection falls through to the wall-clock ceiling, which fires
unconditionally on a plain clock read. On breach, `stopTask` calls `killFn`
(`killTree`) directly against the child process; it does not wait for, or
depend on, the harness's own error reporting to say anything at all.
`kernel/run.test.mjs`'s AC-B1 test proves exactly this shape: a fake adapter
whose `done` promise has no resolver except the supervisor's own `stopTask`
call, with every other signal (events, tokens, tool calls) held at zero for
the whole run — structurally identical to a silently-hung CLI — and the run
still stops at its wall-clock ceiling with `dimension: "wallClock"`. `ttlMs`
(passed to `startTask`, derived from the same contract budget) is a second,
independent bound on the harness's lane slot, for the same reason.

## Credentials

The contract lists vault key **names**; `kernel/credentials.mjs` is the only
place values exist, and the only thing it does with them is hand them to the
child process's environment — never argv, never stdout, never the ledger.
Revocation is loss of local access: the process holding the values dies and
its staging directory is removed at task end, or at the policy's
`hardCaps.wallClockMin` (default 240 minutes), whichever comes first. A
third-party key cannot be invalidated server-side from here — that limit is
documented, not papered over.

## Ledger queries

```
node kernel/ledger.mjs query [--status <s>] [--harness <h>] [--since <date>] [--until <date>]
```

`--status` is the finalized outcome, or `interrupted` for a `run_started`
with no matching `run_finalized`. Each row: `{ runId, status, harness,
startedAt, finishedAt, criteria }`. No dashboard — this CLI plus the JSONL
ledger under `runner/ledger/` is the whole "queryable" requirement.

## Out of scope

No multi-agent orchestration or concurrency (the launch lane serializes; one
run at a time). No per-action human approval queue (guards decide in code;
the interactive runbox/approve flow is unrelated and untouched). No ledger
dashboard (query CLI only; the GUI kernel tab edits policy, nothing else).
No long-term memory system, vector store, or knowledge graph. No workflow
engine. **Phase 2** (a Failure Corpus derived from rejected/corrected ledger
entries) is named as future work only — the ledger already records what it
needs; nothing here builds it.
