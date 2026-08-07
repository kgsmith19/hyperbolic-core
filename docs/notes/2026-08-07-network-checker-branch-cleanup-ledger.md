---
title: network-checker branch cleanup ledger, post-lean pass
status: active
scope: subsystem:network-checker
created: 2026-08-07
updated: 2026-08-07
owner: Kyle
traces: []
---

# network-checker branch cleanup ledger, post-lean pass

27 remote branches on `kgsmith19/network-checker` after the lean pass (PR #37, 11,194 -> 7,050 lines). Zero were deleted: branch deletion is blocked in this session, not on GitHub. The blocker and the full triage are below so a human can act in one pass without redoing the research.

## The blocker

`git push origin --delete` was denied by the Claude Code auto-mode permission classifier. It is the only deletion mechanism available here:

- `gh` CLI is not installed in this environment, so the `gh repo delete-branch` path in the cleanup prompt cannot run.
- The GitHub MCP server exposes `create_branch` and `list_branches` but **no delete-branch tool**.

This is a local permission decision, not a proxy or GitHub 403. Deletion succeeds from the GitHub UI, or from a session with a `Bash(git push:*)` permission rule. One probe was attempted on the disposable `tmp-probe-delete` branch and not retried.

## What git says vs. what is true

`git branch -r --no-merged main` reports 12 branches as unmerged. **Nine of them are squash-merged** and carry no unique work: squashing rewrites the commit, so the branch tip is never an ancestor of `main` and git cannot see the merge. Deleting only the 15 branches git calls merged would leave 9 safe deletions on the table.

Corrected triage: **24 of 27 are safe to delete. 3 need judgment.**

## Safe to delete (24)

Merged per git history (15, includes the Tier 1 stray):

| Branch | Last commit |
|---|---|
| `tmp-probe-delete` | 2026-08-07 |
| `claude/loop-goal-4umvxd` | 2026-08-07 |
| `claude/spec-driven-dev-continue-41309l` | 2026-08-06 |
| `claude/phase-14-regression-monitoring` | 2026-08-05 |
| `claude/phase-13-verification-testing` | 2026-08-05 |
| `claude/phase-12-fix-application` | 2026-08-05 |
| `claude/phase-10-synthesis` | 2026-08-05 |
| `claude/phase-9-buffer` | 2026-08-05 |
| `claude/phase-8-tls` | 2026-08-05 |
| `claude/phase-7-routing` | 2026-08-05 |
| `claude/phase-6-dns` | 2026-08-05 |
| `claude/phase-5-dual-stack` | 2026-08-05 |
| `claude/phase-4-tcp` | 2026-08-05 |
| `claude/phase-3-mtu` | 2026-08-05 |
| `claude/phase-2-packet-loss` | 2026-08-05 |

Squash-merged, invisible to `git --merged` (9):

| Branch | Merged PR |
|---|---|
| `claude/network-checker-diagnosis-41789b` | #25 |
| `claude/e2e-fault-injection-mtu-tls` | #24 |
| `claude/fix-engine-measured-likelihoods` | #23 |
| `claude/fix-application-real-writes` | #22 |
| `claude/readme-quickstart` | #21 |
| `claude/network-checker-phase-30-remaining-issues` | #20 |
| `claude/network-checker-phase-29-restore-hypotheses` | #19 |
| `claude/network-checker-phase-24-polish-bb91r4` | #17, #18 |
| `claude/lean-network-troubleshooting-ydt29q` | #1, #2, #3, #16 |

## Needs judgment (3)

| Branch | Last commit | Why it is held | Decision needed |
|---|---|---|---|
| `claude/network-diagnostics-ui-5ortgo` | 2026-08-06 | PR #26 closed **without** merging. Draft, `mergeable_state: dirty`, +2,245/-119 across 26 files: dashboard control plane, `netcheck test`/`rootcause` CLI, loopback admin API, `netcheck/config.py`. Real unmerged work. | Reopen and rebase, salvage the parts the lean pass did not supersede, or delete deliberately. |
| `claude/network-diagnostics-ui-cont-4cl3r9` | 2026-08-06 | No PR ever opened. Continuation of the branch above (loopback admin API over `FixApplier`, firmware version reads). | Same call as #26; almost certainly stands or falls with it. |
| `claude/phase-15-wifi-diagnostics` | 2026-08-05 | No PR ever opened. "WiFi radio-layer diagnostics with 20 comprehensive tests" — the only phase branch never routed through a PR. | Confirm whether the lean pass absorbed WiFi diagnostics; if not, this is unshipped work. |

## Method

Ground truth is git history plus PR merge state, not the GitHub API's `merged` field on a branch. Counts verified against the full PR set: 31 PRs total, 30 merged, 1 closed-unmerged (#26), 0 open — single page, no pagination truncation.

## Next

1. Delete the 24 safe branches, via the GitHub UI or a session permitted to run `git push origin --delete`.
2. Decide the 3 held branches. `claude/network-diagnostics-ui-5ortgo` is the only one holding substantial unmerged work.
3. Delete this note once the branch list is clean. It describes a state, and states expire.
