# Stage 3c (#387) canary evidence — required-check name and owner-bypass path

Recorded 2026-09-22 (UTC) while recovering the repo-wide #393 workflow fault.
Read-only observation; no repository settings were mutated by this evidence.

## Required-check name exercises as `PR Gate`

- Ruleset `main` (id `20904976`) `required_status_checks` context:
  `PR Gate` (integration `15368`), `strict_required_status_checks_policy: true`.
- On PR #399 (`issue/387-stage3c-settings`) the workflow row reported is
  literally `PR Gate`; every lane feeds it and it is the sole required context.

## Owner-bypass path

Command (owner account `kgsmith19`, activation actor id `64936641`):

    git push origin main

Verbatim output (commit `733a90b`):

    remote: Bypassed rule violations for refs/heads/main:
    remote:
    remote: - Changes must be made through a pull request.
    remote:
    remote: - Required status check "PR Gate" is expected.
    To https://github.com/kgsmith19/hyperbolic-core.git
       b5a247f..733a90b  main -> main

This demonstrates that the owner-bypass actor can land a change on a
ruleset-protected branch while the required check is unmet — the escape hatch
the approved policy describes, exercised by the owner only.
