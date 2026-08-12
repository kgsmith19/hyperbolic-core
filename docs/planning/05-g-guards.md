# 05-g. Guards V1 Plan

Component: Guards at `apps/toolbelt/guards/`. Names per `00-canonical-names.md` (canonical definition row for Guards). Evidence base: `01-inventory.md`, `02-health-audit.md` (SEC-05), `03-v1-definition.md` (GU-1..GU-3), direct source reads cited inline. Planning only.

## 1. Definition: what Guards is, enforces, and deliberately does not do

Guards is a standalone runtime policy module: a Claude Code `PreToolUse` hook (`guard.mjs`) plus a config CLI (`cli.mjs`), extracted from the Agentic Command Center on 2026-08-12 with a strict no-import boundary; ACC shells the CLI as a subprocess [VERIFIED: 00-canonical-names.md Guards row; git show 5f67ec1 "Extract Guards to apps/toolbelt/guards, decoupled from ACC"].

What it enforces today, three checks in order inside the exported pure function `decide(payload, config)`:

1. Secret-glob block: basename globs from `config.secrets` block both reads and writes so key material never enters the conversation [VERIFIED: guard.mjs:68-73; globs at config.json:4-11].
2. Protected-path write block: prefix match against `config.protected` refuses direct writes by the write tools (`Edit`, `Write`, `NotebookEdit`, `MultiEdit` [VERIFIED: guard.mjs:53]); runbox directories are exempt drop zones [VERIFIED: guard.mjs:79-95].
3. Cell ownership: a write inside a configured repo requires that repo's `.agents/task.json` to declare the owning cell; `alwaysAllowed` entries bypass; unowned paths are allowed [VERIFIED: guard.mjs:97-125].

Wrapper semantics: unreadable config denies with exit 2 [VERIFIED: guard.mjs:135-140]; `enabled:false` allows everything by explicit operator choice [VERIFIED: guard.mjs:141]; stdin is read asynchronously with a 4 s cap and an unparsable payload denies with exit 2 [VERIFIED: guard.mjs:149-169]. Exit 2 with the reason on stderr is the deny convention Claude Code feeds back to the model [VERIFIED: kernel/guardhook.mjs:5-6 documents the same convention].

The CLI owns exactly the fields `decide()` consults for its first two checks: `status`, `toggle on|off`, `secret-add/rm <glob>`, `protected-add/rm <path>`; the `repos` cell data has no CLI surface and is edited by hand [VERIFIED: cli.mjs:5-10,48-85].

What Guards deliberately does NOT do:

- Bash-mediated writes (redirects, `sed -i`, `tee`) are not intercepted: "convention enforcer, not a security boundary" is in the file header [VERIFIED: guard.mjs:17-18; SEC-05 in 02-health-audit.md]. V1 does not oversell this and does not try to fix it in the hook (section 3d).
- Network egress: the hook sees tool-call payloads, never sockets (section 3d).
- CI gating: Guards runs at agent tool-call time only; it is not a CI check (section 2c decides what is).

## 2. Where enforcement runs

### Today: two distinct systems, kept distinct

1. Guards on the operator machine: registered manually in `~/.claude/settings.json` as a `PreToolUse` hook with matcher `Edit|Write|NotebookEdit|Read` [VERIFIED: guards/README.md:33-36]. Whether that registration is live on the operator's machine is machine-local [UNKNOWN; carried as 01-inventory gate question 2].
2. The ACC kernel guardhook: `kernel/guardhook.mjs` is a separate module registered only in a run's generated settings file, deny-by-default on every unreadable input, with a per-run contract, decision ledger, settings-hash pin, and tool-call ceilings [VERIFIED: kernel/guardhook.mjs:1-10,59-116; kernel/settings.mjs:1-33]. It imports the kernel's own `decide()` from `kernel/guard.mjs`, not Guards' [VERIFIED: guardhook.mjs:15]. These are different systems with different jobs; conflating them in planning would be an error (section 4 draws the boundary).

### V1 target

(a) Automatic registration for every Brain- and ACC-launched harness session, realizing GU-2. The mechanism is the kernel's proven generated-settings pattern [VERIFIED: kernel/settings.mjs generateSettings]: each launcher (ACC kernel, ACC runner directive launches, and the Brain per `07-brain-architecture.md`) writes a per-run settings file whose `PreToolUse` chain includes Guards' `guard.mjs` with `GUARDS_CONFIG` resolved for that machine (section 3a makes that resolvable off the operator's Windows box). Kernel runs carry both hooks: Guards for shared repo/file conventions, the kernel guardhook for per-run contract enforcement; either hook's exit 2 denies the call. Section 5 fixes the block shape.

(b) Operator-machine interactive sessions keep manual registration, documented in `guards/README.md` exactly as today [VERIFIED: README.md:33-36]. Interactive sessions are the operator's own; auto-mutating the operator's live `~/.claude/settings.json` is itself a protected-path write in the current config [VERIFIED: config.json:13] and stays out of scope.

(c) NOT pre-commit and NOT CI for Guards itself in V1. Rationale: the repo gates are already owned by covgate and the `PR Gate` workflows [VERIFIED: 01-inventory.md section 6]; running a tool-call-time hook in CI enforces nothing CI can act on. Secret enforcement in CI is a different tool class (content scanning of commits, not interception of tool calls). DECIDE: add a gitleaks-style secret-scan step to the existing PR Gate workflows as a cheap addition rather than deferring it. Justification: it is roughly 12 workflow lines per gate with no new deployable unit, and it covers Guards' one explicitly documented blind spot (a secret written via Bash lands in a commit unseen by the hook [VERIFIED: guard.mjs:17-18]) at the repository boundary where it matters most. Current sweeps are clean [VERIFIED: 01-inventory.md section 4], so the expected steady-state cost is zero noise. This step belongs to `10-cicd-deployment.md`; it is a CI control, not part of the Guards module.

## 3. V1 enforcement set

The current three checks ship unchanged (GU-1 keeps the suite green). Additions ranked by ROI:

### (a) Rank 1: machine-profile config layer (prerequisite for GU-2)

Problem: `config.json` carries Windows-machine absolute paths as its only reality: `runboxDir: "C:/code/guards/runbox"`, `protected: ["C:/Users/kyleg/.claude/settings.json"]`, and a repo cell map rooted at `C:/code/lifeos-ecosystem/lifeos` [VERIFIED: config.json:3,13,16]. The committed file is deliberately the operator's live config [VERIFIED: guards/README.md:22-24], but it cannot express a second machine, and GU-2 requires Guards to run wherever Brain- and ACC-launched sessions run.

DECIDE between (i) env-expanded paths in one config and (ii) a per-machine overlay. Decision: per-machine overlay. Env expansion (`%USERPROFILE%`, `$HOME`) fixes prefixes but cannot express that different machines have different repo checkouts, different runboxes, and different protected sets; the cell map is inherently per-machine data, not a portable path with a variable prefix.

Design: `config.json` remains the tracked base and keeps the portable fields (`enabled`, `secrets`). Machine-specific fields (`runboxDir`, `protected`, `repos`) live in a tracked overlay file `config.<profile>.json` in the same directory, where `<profile>` comes from `GUARDS_PROFILE` if set, else the lowercased hostname. The loader (shared by `guard.mjs` and `cli.mjs`) shallow-merges overlay keys over base keys; a missing overlay file means base-only, which fails safe because the secret globs (the read-blocking check) are in the base. Tracking overlays is consistent with the existing stance that these paths are deliberate non-secret operator data [VERIFIED: 01-inventory.md secrets table, guards config row]. `GUARDS_CONFIG` keeps its current meaning (absolute pointer to a fully resolved config, bypassing profile resolution) so existing tests and ACC's subprocess calls are untouched [VERIFIED: guard.mjs:48; cli.mjs:25]. The current Windows values migrate into `config.kyleg-machine.json` (exact hostname confirmed at implementation time); `config.example.json` gains the overlay shape.

Config skeleton:

```json
// config.json (tracked base: portable)
{ "enabled": true, "secrets": [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "vault.json"] }

// config.<profile>.json (tracked overlay: per machine)
{ "runboxDir": "<abs path>", "protected": ["<abs path>", "..."], "repos": { "<abs repo root>": { "cells": {}, "alwaysAllowed": [] } } }
```

LOC: ~30 production (loader + profile resolution), ~40 tests. Lock-in: none; the merge is trivial JSON. Migration: one-time split of the current file, no semantic change on the operator machine.

### (b) Rank 3: deny-write-roots alignment with the kernel

The kernel's `alwaysDenyWriteRoots()` returns the ACC repo root, `~/.claude`, and `policy.json`'s `extraDenyWriteRoots` [VERIFIED: kernel/policy.mjs:61-63]; Guards' `protected` list is a separate hand-maintained set [VERIFIED: config.json:12-14]. Two lists guarding overlapping territory will drift.

Design constraint: the no-import boundary between ACC and Guards is absolute in both directions [VERIFIED: 01-inventory.md key edges; AGENTS.md product map]. Sharing code is forbidden; sharing data is not. Decision: the kernel policy loader gains an optional `guardsConfigPath` key in `policy.json`; when set, `alwaysDenyWriteRoots()` unions in the `protected` list read from that JSON file (plus the resolved profile overlay), treating it as data. Read failure of the referenced file adds nothing but logs a warning; the kernel's own built-in roots never shrink, so the failure mode is "no wider", never "no guard". Guards remains the single human-edited source for protected paths; the kernel consumes it. LOC: ~20 production in `kernel/policy.mjs`, ~20 tests. Reversal: if the data coupling proves annoying, delete the key and return to two lists plus a CI consistency assertion.

### (c) Rank 2: decision audit trail (JSONL)

Today a Guards denial exists only as an exit code and a stderr line consumed by the harness; nothing persists. For Brain debugging ("why did the run stall on that edit"), a local append-only record is cheap and high value, and the kernel side already proves the pattern with its per-run ledger [VERIFIED: kernel/guardhook.mjs appendDecision usage].

Design: after `decide()` returns, the wrapper appends one JSON line to the file named by `GUARDS_LOG` (default: `decisions.jsonl` next to the resolved config; the file is added to `.gitignore`). Record shape:

```json
{ "ts": "<ISO8601>", "tool": "Edit", "target": "<normalized path>", "allow": false, "rule": "protected", "reason": "<text>", "profile": "<profile>" }
```

Semantics: logging is best-effort and never changes the decision; an append failure does not fail open or fail closed, it is simply not recorded, mirroring the kernel's "the denial still stands" stance [VERIFIED: kernel/guardhook.mjs:23]. Allowed decisions are logged too (rule `none`), because the observability value for the Brain is the full sequence, and volume is bounded by tool-call rate. Rotation is out of scope for V1 (single operator, local file, delete at will). LOC: ~25 production, ~40 tests.

### (d) Egress guard: OUT of scope, permanently for this module

A `PreToolUse` hook receives a JSON tool-call payload naming files and arguments; it never sees sockets, DNS lookups, or the network activity of a Bash child process. An "egress check" here could only pattern-match command strings, which is trivially bypassed and would manufacture false confidence, the exact failure SEC-05 warns against [VERIFIED: 02-health-audit.md SEC-05]. Egress control belongs at the container/network layer and is already dispositioned by ADR-06 (documented and monitored in V1, structural control deferred with rationale) [VERIFIED: 04-adrs.md ADR-06 egress paragraph].

## 4. Overlap analysis: Guards vs the ACC kernel guard

| Dimension | Guards (`apps/toolbelt/guards/`) | Kernel guard (`kernel/guard.mjs` + `kernel/guardhook.mjs`) |
| --- | --- | --- |
| Scope | Repo/file conventions shared across every harness session: secret globs, protected paths, cell ownership | Per-run task-contract enforcement: tool allowlist, tool-call ceilings, staging-dir confinement, autonomy factors |
| State | One config file (+ profile overlay), no per-run state | Per-run contract, pin, decision ledger, atomic decision lock [VERIFIED: guardhook.mjs:118-142] |
| Registration | Manual (interactive) or generated settings (V1, section 2) | Only ever generated settings [VERIFIED: guardhook.mjs:2-3] |
| Failure posture | Fail closed on unreadable config/stdin [VERIFIED: guard.mjs:135-169] | Fail closed on every unreadable input, including mid-run settings tamper [VERIFIED: guardhook.mjs:73-79] |

Recommendation: they compose; do not merge in V1. A kernel run registers both hooks in its generated `PreToolUse` chain; each rules on its own concern and either exit 2 denies. Merging now is rejected because: (1) the extraction that created this boundary landed a single commit ago on 2026-08-12 [VERIFIED: git show 5f67ec1] and re-merging would churn a freshly stabilized seam for zero V1 capability; (2) the semantics genuinely differ (global convention vs per-run contract with ledger and pin), so a merged module would carry two lifecycles in one file; (3) the no-import boundary is a documented product rule on both sides [VERIFIED: AGENTS.md product map; guards/README.md:8-10].

Reversal condition, stated now: if the rule sets converge, meaning the kernel starts needing secret-glob or cell rules, or Guards grows per-run ledger/pin semantics, then merge into Guards as the single module, with the kernel invoking it via subprocess and data files (the same discipline ACC's GUI already uses for the CLI [VERIFIED: gui/server.mjs:153-163 per 01-inventory.md]). Until both of those pressures exist, two small sharp tools beat one blunt one.

## 5. Registration contract for the Brain (dependency of `07-brain-architecture.md`)

Every Brain- and ACC-launched harness session receives a generated settings file whose `PreToolUse` chain includes Guards. Block shape (JSON skeleton, kernel runs additionally include their own guardhook entry first):

```json
{
  "permissions": { "defaultMode": "<per launcher policy>", "allow": [], "deny": [] },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Read",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<abs repo root>/apps/toolbelt/guards/guard.mjs\"",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Contract terms:

- Environment: the launcher sets `GUARDS_CONFIG` to the resolved config for that machine (or sets `GUARDS_PROFILE` and lets the loader resolve), and optionally `GUARDS_LOG` to a per-run path so the audit trail lands beside the run's other artifacts.
- Matcher: `Edit|Write|NotebookEdit|Read`, identical to the documented interactive registration [VERIFIED: guards/README.md:35], so the rule surface never differs by launch path. `MultiEdit` is covered by `decide()`'s write-tool set should a launcher widen the matcher [VERIFIED: guard.mjs:53].
- Timeout: 15 s at the hook layer, matching the kernel's existing generated value [VERIFIED: kernel/settings.mjs generateSettings timeout: 15]; Guards' internal 4 s stdin cap [VERIFIED: guard.mjs:149] keeps a wedged pipe from ever reaching that ceiling in practice.
- Failure semantics: fail closed end to end. Unreadable config: exit 2. Unparsable or absent stdin payload: exit 2. `enabled:false`: exit 0 by explicit operator choice, and the launcher must surface that state in run metadata so a disabled guard is never silent. The Brain treats a hook timeout or nonzero hook exit as a denied tool call, never as an allow.
- Ownership: the generated-settings writer in each launcher (kernel today [VERIFIED: kernel/settings.mjs writeRunFiles], runner and the Brain in V1) is the single place the block is emitted; no hand-edited copies.

## 6. Acceptance criteria (EARS) realizing GU-1..GU-3

| # | Criterion (EARS) | Verification command |
| --- | --- | --- |
| GU-1 | The existing suite shall stay green throughout V1 work. | `cd apps/toolbelt/guards && node --test "*.test.mjs"` exits 0 (35 tests today [VERIFIED: 01-inventory.md suite table]) |
| GU-2.1 | When the ACC kernel generates run settings, the `PreToolUse` chain shall include the Guards hook entry with a `GUARDS_CONFIG`/`GUARDS_PROFILE` resolution for the machine. | `cd apps/agentic-command-center && npm test` exits 0, including the new `kernel/settings.test.mjs` assertion that generated settings contain a command matching `guards/guard.mjs` |
| GU-2.2 | When any Brain- or ACC-launched harness session attempts a write to a protected fixture path, the call shall be denied with exit 2 and the denial shall be recorded. | launch a kernel run against a fixture repo (kernel suite fixture path); assert exit 2 on the write and `grep -c '"allow":false' "$GUARDS_LOG"` is at least 1 |
| GU-2.3 | While a launcher runs on a machine with a profile overlay, Guards shall enforce that machine's protected and repo rules without any edit to the tracked base config. | `GUARDS_PROFILE=fixture node --test guard.test.mjs` (overlay-merge cases) exits 0 |
| GU-3.1 | If the config file cannot be read, then the hook shall deny with exit 2. | `printf '{}' \| GUARDS_CONFIG=/nonexistent/cfg.json node apps/toolbelt/guards/guard.mjs; test $? -eq 2` |
| GU-3.2 | If no parsable payload arrives on stdin within the cap, then the hook shall deny with exit 2. | `printf '' \| GUARDS_STDIN_TIMEOUT_MS=50 GUARDS_CONFIG=apps/toolbelt/guards/config.json node apps/toolbelt/guards/guard.mjs; test $? -eq 2` (existing wrapper tests cover this in-suite [VERIFIED: guard.test.mjs subprocess cases per scratchpad report]) |
| AUD-1 | When a decision is made and `GUARDS_LOG` is set, the system shall append exactly one JSONL record carrying ts, tool, target, allow, rule. | run one denied fixture payload through the hook with `GUARDS_LOG=$(mktemp)`; `wc -l < "$GUARDS_LOG"` prints 1 and `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$GUARDS_LOG"` exits 0 |
| AUD-2 | If the audit append fails, then the decision outcome shall be unchanged. | unit case in `guard.test.mjs` with an unwritable `GUARDS_LOG` path: allow stays allow, deny stays deny |
| ALN-1 | When `policy.json` names a `guardsConfigPath`, the kernel's deny-write roots shall include every Guards protected path; when the file is unreadable, the built-in roots shall be unchanged. | `cd apps/agentic-command-center && node --test kernel/policy.test.mjs` exits 0 with both cases |
| LAT-1 | The hook shall add at most 50 ms p95 per intercepted tool call on the operator machine. | `for i in $(seq 1 20); do printf '{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}' \| node apps/toolbelt/guards/guard.mjs; done` timed; p95 of wall-clock per invocation below 50 ms |

## 7. LOC accounting, deletion list, latency

LOC deltas (production + tests):

| Slice | Production | Tests | Net |
| --- | --- | --- | --- |
| Profile overlay loader (3a) | ~30 | ~40 | +70 |
| Audit trail (3c) | ~25 | ~40 | +65 |
| Deny-roots alignment (3b, lands in ACC kernel/policy.mjs) | ~20 | ~20 | +40 |
| Generated-settings Guards entry (kernel + runner + Brain writer) | ~30 | ~30 | +60 |
| gitleaks-style PR Gate step (2c, lands in workflows via 10) | ~12 per gate workflow | n/a | +24 |
| Docs (README overlay + registration contract) | ~20 | n/a | +20 |
| Total | | | approximately +279 |

Deletion list: none. Guards has no dead code [VERIFIED: 01-inventory.md vitals row: "none observed"]. `config.example.json` is edited for the overlay shape, not deleted; the current `config.json` machine fields move into the first profile overlay file (a split, not a deletion).

Latency budget: the hook adds per-tool-call overhead on every intercepted tool. Budget: under 50 ms p95 per invocation on the operator machine (Node process start + one or two small JSON reads + one appendFile). Existing ceilings bound the worst case: the 4 s stdin cap inside the hook [VERIFIED: guard.mjs:149] and the 15 s hook timeout in generated settings [VERIFIED: kernel/settings.mjs]. The audit append and overlay merge are O(1) additions and stay inside the 50 ms budget; LAT-1 in section 6 is the enforcement check.

## Gate questions (batched, non-blocking)

1. Whether the Guards hook is currently registered in the operator's live `~/.claude/settings.json` remains [UNKNOWN] (01-inventory gate question 2). GU-2 does not depend on it (generated settings are launcher-owned), but the interactive-session posture in section 2b assumes the README instructions are followed; the operator can confirm in seconds.
2. Section 2c recommends the gitleaks-style CI step as a cheap addition rather than a deferral. If the operator prefers zero new CI steps in V1, striking it removes 24 workflow lines and the repository-boundary backstop for Bash-written secrets; say so before `10-cicd-deployment.md` finalizes the gate definitions.
3. Tracked per-machine overlay files put hostnames in the repo (paths are already deliberately tracked today [VERIFIED: guards/README.md:22-24]). If the operator prefers overlays gitignored instead, the design is unchanged except tracking; decide before the Phase 11 issue is cut.

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS (JSON skeletons, record shapes, and command specs are contracts per the charter)
- Canonical names used exclusively: PASS (Agentic Command Center appears in full at first use; ACC thereafter)
- Maturity/migration/lock-in/ecosystem costs: PASS (overlay migration one-time split; no new dependencies; gitleaks-style step named with cost; no lock-in introduced)
- Machine-verifiable acceptance criteria: PASS (section 6, exact commands)
- LOC delta reported: PASS (section 7, approximately +279 net)
- Deletion list present: PASS (section 7: none, with rationale)
- Latency budgets stated for new paths: PASS (section 7 and LAT-1: under 50 ms p95, ceilings cited)
- Questions batched at the gate: PASS (3, non-blocking)
- Zero em dashes: PASS
- Complexity budget breaches: none (no new deployable units, runtimes, databases, or auth flows)
