# Leanness record: creative-studio (#551)

Measured on the imported tree (`apps/creative-studio`), 2026-11-05.

## Size

27 tracked files, 42 source lines, no application code. The only executable is
`scripts/validate.py` (registry validator, 14 lines). The bulk is standards, research notes and
demo HTML (`demos/`, `experiments/`), which is content, not code, and is kept.

## What was removed

- **Nested `.github/` directory** (`.github/workflows/validate.yml`). GitHub reads only the root
  `.github/`, so this file never ran. Its job (validate the registry) is now the lane
  `verify-tests-creative-studio` in the root PR Gate, so the check actually runs.

## Dependencies and duplicate config

None. No package manifest, no lockfile.

## Deferred, with reasons

None. There is no code to lint or type-check; the registry validator is the check. A future
application would get its own lint and type lane when it has code.

## Lane

`verify-tests-creative-studio`: runs `python3 scripts/validate.py`. Local result before this PR:
`Registry validation passed`.
