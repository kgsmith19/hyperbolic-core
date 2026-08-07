#!/usr/bin/env bash
# Local stand-in for the CI workflows (tests.yml, code-quality.yml),
# which now trigger on workflow_dispatch only --
# see .github/workflows/README.md. Run this before merging a PR, since
# nothing on GitHub is going to run these checks for you automatically
# anymore.
#
# Usage: bash tools/check.sh
# Exit code: 0 if every check passed, 1 if any failed.
set -u
cd "$(dirname "$0")/.."

failed=0
run() {
    local name="$1"; shift
    echo "=== $name ==="
    if "$@"; then
        echo "PASS: $name"
    else
        echo "FAIL: $name"
        failed=1
    fi
    echo
}

run "tests" python3 -m unittest discover -s tests -v

# -i medium is exactly rules/01-BUDGETS.md's declared ceilings: 40 lines,
# 4 params, cyclomatic 8, nesting 3. This used to run at -i low (100 lines,
# cyclomatic 15), which no function in the repo could breach -- a gate that
# cannot fail is not a gate. All three trees pass at the real budget.
run "code simplification (netcheck)" python3 tools/code_simplification.py netcheck -i medium
run "code simplification (tools)" python3 tools/code_simplification.py tools -i medium
run "code simplification (tests)" python3 tools/code_simplification.py tests -i medium
run "security review (high)" python3 tools/security_review.py . -i high
run "documentation check (medium)" python3 tools/documentation_check.py . -i medium

for script in tools/fix_*.sh tools/run_fixes.sh; do
    [ -f "$script" ] && run "shell syntax: $script" bash -n "$script"
done

echo "============================"
if [ "$failed" -eq 0 ]; then
    echo "All checks passed."
else
    echo "One or more checks FAILED -- see above."
fi
exit "$failed"
