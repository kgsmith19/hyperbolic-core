# CI/CD Workflows

Automated testing and quality gates for network-checker.

## Workflows

### 1. Tests (`tests.yml`)
Runs comprehensive test suite across Python 3.9, 3.10, 3.11.

**Triggers:** Push to main/claude/*, Pull Requests to main

**Steps:**
- Install dependencies (pytest, pytest-cov)
- Run all tests in `tests/` directory
- Generate coverage reports
- Upload to codecov

**Status:** Required to pass before merge

---

### 2. Code Quality (`code-quality.yml`)
Runs automation tools with high intensity to enforce code standards.

**Triggers:** Push to main/claude/*, Pull Requests to main

**Checks:**
1. **Code Simplification** (high intensity)
   - Detects functions > 15 lines
   - Reports complexity violations
   - Tool: `tools/code_simplification.py`

2. **Security Review** (high intensity)
   - Detects eval(), exec(), pickle.load()
   - Finds hardcoded secrets
   - Blocks merge on HIGH severity issues
   - Tool: `tools/security_review.py`

3. **Documentation Check** (high intensity)
   - Validates README and docstrings
   - Checks for template scaffolding
   - Tool: `tools/documentation_check.py`

**Status:** Required to pass before merge

---

### 3. Fixer Validation (`fixer-validation.yml`)
Validates network fixer system functionality.

**Triggers:** Push to main/claude/*, Pull Requests to main

**Tests:**
- Fixer module imports correctly
- All detection methods work
- Dry-run mode executes
- JSON output is valid
- Shell scripts have valid syntax

**Status:** Must pass before merge

---

### 4. Status Checks (`status-checks.yml`)
Aggregates workflow results (triggered by other workflows).

---

## Setting Up Branch Protection

To enforce CI/CD before merge:

1. Go to **Settings → Branches → main**
2. Enable **Require status checks to pass before merging**
3. Require:
   - `test (3.9)` / `test (3.10)` / `test (3.11)` 
   - `quality` (Code Quality)
   - `fixer-tests` (Fixer Validation)
4. Enable **Dismiss stale pull request approvals when new commits are pushed**
5. Enable **Require branches to be up to date before merging**

---

## Running Locally

Before pushing, run the same checks locally:

```bash
# Run tests
pytest tests/ -v

# Run code quality checks
python tools/code_simplification.py netcheck -i high
python tools/security_review.py . -i high
python tools/documentation_check.py . -i high

# Test fixer
python tools/fixer.py --issue all --dry-run -v
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

## Emergency Bypass

Only for critical hotfixes (requires admin):

```bash
git push --force-with-lease
# Then manually verify in GitHub UI before merge
```

---

## Troubleshooting

### Tests Failing
```bash
pytest tests/ -v --tb=short
```

### Code Quality Issues
```bash
python tools/code_simplification.py netcheck -i high -v
python tools/security_review.py . -i high -v
```

### Fixer Issues
```bash
python tools/fixer.py --issue all --dry-run -v
bash -n tools/fix_*.sh
```
