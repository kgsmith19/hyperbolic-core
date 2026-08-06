#!/usr/bin/env bash
# Local stand-in for the CI workflows (tests.yml, code-quality.yml,
# fixer-validation.yml), which now trigger on workflow_dispatch only --
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

run "code simplification (low)" python3 tools/code_simplification.py netcheck -i low
run "security review (high)" python3 tools/security_review.py . -i high
run "documentation check (medium)" python3 tools/documentation_check.py . -i medium

run "fixer import" python3 -c "from tools.fixer import NetworkFixer"
run "fixer dry-run" python3 tools/fixer.py --issue all --dry-run -v
run "fixer JSON output" bash -c "python3 tools/fixer.py --issue dns --format json --dry-run | python3 -c 'import json,sys; json.load(sys.stdin)'"

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
