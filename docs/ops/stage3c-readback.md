# Stage 3c (#387) live read-back — evidence, reproduction, exact-head tie

## What this proves

`hyperbolic-core` `main` matches the owner-approved policy: squash-only PR
merges, zero required native approvals, exact-head (strict/up-to-date) single
required check named `PR Gate`, no force-push/delete exposure, and the owner
actor (`64936641`) retaining always-bypass. Proven by reading the live ruleset
back through the API — never by trusting a write response or a committed
template.

## Committed artifacts

- `stage3c-live-ruleset-20904976.json` — verbatim `GET /repos/kgsmith19/hyperbolic-core/rulesets/20904976`
  response recorded 2026-09-22 (read-only; no writes).
- `stage3c-settings-readback-lib.mjs` — the drift predicate and the
  GitHub-ruleset → snapshot adapter (single-sourced).
- `stage3c-settings-readback.test.mjs` — asserts the recorded response maps to
  the literal approved snapshot, and that the predicate fires on each drift
  mode (including adapter fail-closed cases).
- `stage3c-canary-evidence.md` — timestamped evidence for the required-check
  name and the owner-bypass path.

## Reproduce the live read-back (read-only)

```bash
gh auth login                                   # token with repo read + Administration:read
node docs/ops/stage3c-settings-readback-live.mjs
# expected: Read-back clean: zero drift.   (exit 1 on any drift)
```

Offline CI proof (no network):

```bash
node --test docs/ops/stage3c-settings-readback.test.mjs
```

## Exact-head tie

The ruleset is repository-level and therefore head-independent; the read-back
is taken while a specific PR head is current. The recorded artifact above was
captured with the PR head at `24b1e9588cef3337149a2db094cc0f2305c3c53e`
(`review-meta.json` records the same `headSha` for the run). Any post-read-back
drift is caught by re-running the live script; the committed fixture freezes
the exact values that were observed.

## Why the live read-back is not executed in PR CI

Reading repository rulesets requires the `Administration: read` permission,
which the default `GITHUB_TOKEN` does not grant; a CI live-read step would need
a PAT or App token with that scope. The offline adapter test proves the
mapping in CI, and the live script reproduces the read-back on demand from any
authenticated environment. No CI step is added that could not actually run.
