---
title: NFR-005 source-size advisory sweep (post-demolition)
status: done
scope: repo
created: 2026-08-09
updated: 2026-08-09
owner: Kyle Smith
traces: [NFR-005]
---

# NFR-005 source-size advisory sweep (post-demolition)

## What breaks if this is deleted

NFR-005 would fall back to an unproven claim (`not-started` in the PRD), and the next lean review would have no deterministic baseline for which >250-line source files were intentionally kept versus candidates to split.

## Deterministic measurement method

Run from repo root (`/home/runner/work/agentic-command-center/agentic-command-center`):

```bash
python - <<'PY'
import subprocess, os
files=subprocess.check_output(['git','ls-files'],text=True).splitlines()
exts={'.mjs','.js','.ps1','.cmd','.bat','.html','.css','.json'}
excluded_prefixes=('docs/','specs/','templates/','.agent/','.github/')
excluded_contains=('/fixtures/','/node_modules/','/dist/','/.trash/','/vendor/','/coverage/')
excluded_suffixes=('.test.mjs','.test.js','.test.ps1')
rows=[]
for f in files:
    if any(f.startswith(p) for p in excluded_prefixes): continue
    if any(s in f for s in excluded_contains): continue
    if any(f.endswith(s) for s in excluded_suffixes): continue
    if os.path.basename(f) in {'README.md','AGENTS.md','CLAUDE.md'}: continue
    if os.path.splitext(f)[1] not in exts: continue
    with open(f,'rb') as fh:
        count=sum(1 for _ in fh)
    if count>250:
        rows.append((count,f))
for count,f in sorted(rows,key=lambda t:(-t[0],t[1])):
    print(f"{count:4d}  {f}")
print("TOTAL",len(rows))
PY
```

Exclusions satisfy the issue requirement: generated/vendor/test fixtures and historical docs are out of scope.

## Inventory + verdict ledger

| File | Lines | Verdict | Reason |
|---|---:|---|---|
| `gui/server.mjs` | 542 | KEEP | Single responsibility: Command Center HTTP server + route wiring; execution order and shared request helpers are easier to audit in one file right now. |
| `hooks/budget.mjs` | 501 | KEEP | Single responsibility: budget policy evaluation and gate decisions for hooks/runner; split now would create one-caller helper modules without clearer ownership seams. |
| `hooks/usage.mjs` | 484 | KEEP | Single responsibility: usage aggregation + tier/spend classification; logic is cohesive around one policy model and one CLI surface. |
| `runner/runner.mjs` | 432 | KEEP | Single responsibility: directive loop orchestration with launch lane/pid semantics; control flow is sequence-sensitive and currently tested as one unit. |
| `hooks/lane.mjs` | 410 | KEEP | Single responsibility: launch-slot arbitration + transport retry policy; splitting would fragment closely-coupled concurrency invariants. |
| `hooks/directive.mjs` | 405 | KEEP | Single responsibility: directive store lifecycle and CLI operations; call paths share validation and serialization behavior. |
| `hooks/engine.mjs` | 369 | KEEP | Single responsibility: CLI engine entrypoint for stateful operations; command dispatch and shared IO constraints are cohesive. |
| `gui/guards.html` | 348 | KEEP | Single responsibility: built-in Command Center UI page; high line count is mostly static markup for one surface, not tangled logic. |
| `hooks/covgate.mjs` | 252 | KEEP | Barely over threshold; single responsibility: changed-file coverage gate. Splitting at this size would be number-driven rather than clarity-driven. |

## Cleanup outcome for this thin PR

- Highest-confidence, behavior-preserving action is **inventory + explicit justifications only** (R1).
- No `SPLIT`/`DELETE` action is justified in this slice without introducing one-caller abstractions or speculative file churn.
- Any future split should be taken only with a concrete ownership/testability seam and tracked in a separate issue.
