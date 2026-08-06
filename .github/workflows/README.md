# CI/CD Workflows

Testing and quality gates for network-checker.

**All four workflows below trigger on `workflow_dispatch` only** (manual,
from the Actions tab) as of 2026-08-06 -- they no longer run automatically
on every push or pull request. That was burning through the account's
Actions minutes quota (every push fired 3 workflows x up to 3 Python
versions), and a quota-exhausted run fails instantly with an empty log,
which is indistinguishable from a real failure unless you go check the
job's `runner_id` via the API. Run `bash tools/check.sh` locally instead --
see "Running Locally" below -- before opening or merging a PR. Trigger a
workflow manually from the Actions tab only when you specifically want a
GitHub-hosted run (e.g. to double-check something before an admin merges).

## Workflows

### 1. Tests (`tests.yml`)
Runs comprehensive test suite across Python 3.9, 3.10, 3.11.

**Triggers:** Manual (`workflow_dispatch`), or `workflow_call` from `release.yml`

**Steps:**
- Install dependencies (pytest, pytest-cov)
- Run all tests in `tests/` directory
- Generate coverage reports
- Upload to codecov

---

### 2. Code Quality (`code-quality.yml`)
Runs automation tools to enforce code standards.

**Triggers:** Manual (`workflow_dispatch`)

**Checks:**
1. **Code Simplification** (low intensity)
   - Reports functions over the length threshold
   - Tool: `tools/code_simplification.py`

2. **Security Review** (high intensity)
   - Detects eval(), exec(), pickle.load()
   - Finds hardcoded secrets
   - Blocks on HIGH severity issues
   - Tool: `tools/security_review.py`

3. **Documentation Check** (medium intensity)
   - Validates README and docstrings
   - Checks for template scaffolding
   - Tool: `tools/documentation_check.py`

---

### 3. Fixer Validation (`fixer-validation.yml`)
Validates network fixer system functionality.

**Triggers:** Manual (`workflow_dispatch`)

**Tests:**
- Fixer module imports correctly
- All detection methods work
- Dry-run mode executes
- JSON output is valid
- Shell scripts have valid syntax

---

### 4. Status Checks (`status-checks.yml`)
Aggregates workflow results (triggered by the three above completing, so it
only fires now if one of them is manually run).

---

### 5. Release (`release.yml`)
Builds and smoke-tests the Docker image, then opens a draft GitHub Release.

**Triggers:** Manual (`workflow_dispatch`) -- pick the `vX.Y.Z` tag to run
from in the "Use workflow from" dropdown. Pushing a tag no longer triggers
this by itself. Use `tools/deploy.sh` to build and smoke-test the image
locally without touching Actions at all, and only dispatch this workflow
when you actually want the published GitHub Release + artifact.

---

## Branch protection note

If **Settings -> Branches -> main** has "Require status checks to pass
before merging" configured for `test (3.9)` / `test (3.10)` / `test (3.11)`
/ `quality` / `fixer-tests`, a PR will now sit unmergeable forever --
those checks no longer report anything automatically, and GitHub can't
tell "not required" from "required but never ran." Either remove those as
required checks (rely on `tools/check.sh` run before merge instead), or
manually dispatch the relevant workflow from the Actions tab on a PR's
branch when you want a real merge gate.

---

## Running Locally

Run the same checks the CI workflows used to run automatically:

```bash
bash tools/check.sh
```

This runs, in order: the full test suite (`python -m unittest discover -s
tests -v`), all three quality tools at the same intensities `code-quality.yml`
used, the fixer import/dry-run/JSON-output checks, and shell syntax checks on
`tools/fix_*.sh` -- printing PASS/FAIL per step and exiting non-zero if
anything failed. Individual commands, if you want to run just one:

```bash
# Tests
python -m unittest discover -s tests -v

# Code quality checks
python tools/code_simplification.py netcheck -i low
python tools/security_review.py . -i high
python tools/documentation_check.py . -i medium

# Fixer
python tools/fixer.py --issue all --dry-run -v
```

To cut a release without spending Actions minutes:

```bash
bash tools/deploy.sh          # runs tools/check.sh, then builds + smoke-tests the image
```

---

## Workflow Status

View workflow status and logs:
- https://github.com/kgsmith19/network-checker/actions

Each workflow shows:
- ✓ Passed (green)
- ✗ Failed (red)
- ⊘ Skipped (gray)

Click any workflow to see detailed logs.

---

## Adjusting Intensity

To change check intensity, edit workflow files:

```yaml
# In code-quality.yml, change -i high to:
# -i low   (lenient, only major issues)
# -i medium (balanced)
# -i high  (strict)
```

---

## Troubleshooting

### Anything Failing
```bash
bash tools/check.sh
```

### Tests Failing
```bash
python -m unittest discover -s tests -v
```

### Code Quality Issues
```bash
python tools/code_simplification.py netcheck -i low -v
python tools/security_review.py . -i high -v
python tools/documentation_check.py . -i medium -v
```

### Fixer Issues
```bash
python tools/fixer.py --issue all --dry-run -v
bash -n tools/fix_*.sh
```
