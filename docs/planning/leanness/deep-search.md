# Leanness record: deep-search (#551)

Measured on the imported tree (`apps/deep-search`), 2026-11-05. The root record
`docs/planning/leanness.md` is generated from the same measurements.

## What was removed (dead code, no behavior change)

- **Unused imports** (ruff F401, 35 sites) across backend and tests. Stdlib and
  in-package imports only; no third-party module was dropped by this step.
- **Unused f-string prefixes** (ruff F541, 4 sites).
- **Dead assignments**: `lane = _get(item, "lane", "")` in `backend/synthesis/deep_report.py`
  (never read), and an unused `parser = argparse.ArgumentParser()` in
  `test_bounded_contexts.py` (the test calls `deep_search.build_parser()`; no assertion changed).
- **Unused declared dependency**: none removed. `onnxruntime` has no direct import but is
  the runtime that `fastembed` loads; its minimum is kept explicit. Decision: keep.

## What was fixed (defects found by the lane)

- **Core image could not import.** `backend/retrieval/content_cleaner.py` imports
  `trafilatura` at module load, and `backend/retrieval/__init__.py` imports it, so
  `Dockerfile.core` (which installs only `requirements-core.txt`) failed at start.
  `trafilatura>=2.2.0` added to `requirements-core.txt`. It is an HTML extractor with no
  network access, so the core's air-gap is unchanged. Verified in a clean venv:
  `import deep_search` succeeds on core requirements alone.
- **Facade exports kept deliberately.** `collector.py` re-exports six names that the tests
  and the IPC entrypoint use. The auto-fix removed them; they are restored and declared in
  `__all__` so the lint gate treats them as intentional.

## Dependencies

- `requirements-core.txt` (core process, 7 packages) and `requirements-collector.txt`
  (collector process, 7 packages) are two images on purpose; both are installed in CI because
  the suite patches collector-only modules (`curl_cffi`).

## Deferred, with reasons

| Finding | Measure | Reason |
| --- | ---: | --- |
| `frontend/css/components.css` oversized | 2055 lines | Split by component with the next UI change; a standalone split is churn with no test gain. |
| `backend/research/explorer.py` oversized | 835 lines | Split along its round seams with the next behavior change in this file. |
| Type checking not configured | 99 basic-mode pyright errors in 91 files | Fixing these is a separate body of work (65 `reportArgumentType`, 14 `reportOptionalMemberAccess`, others). Adding a type gate now would either fail CI or weaken the check. Tracked as a follow-up; AC4's type-check clause is not met yet. |
| Tests fetch model files | first run downloads FastEmbed model files from the Hugging Face Hub | The suite is not fully network-free on first run. CI runners have network; the cache is not yet keyed. Follow-up. |
| `Start-DeepSearch.bat` | Windows launcher | Kept: it is the documented Windows entry point in README. |

## Lane

`verify-tests-deep-search` (`.github/actions/verify-tests-deep-search`): installs both
requirement sets, runs `ruff check --select E9,F`, then the nine unittest modules listed in
`project.yaml`. Local result before this PR: 208 tests OK, 3 skipped; the lint is clean.
