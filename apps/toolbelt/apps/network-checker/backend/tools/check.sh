#!/usr/bin/env bash
# Local verification entry point used by the Toolbelt root PR Gate.
# Run this before opening or updating a pull request.
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

# The medium profile checks 40-line functions, 4 parameters, cyclomatic
# complexity 8, and nesting depth 3. All three source trees use the same
# explicit profile so local and hosted checks stay aligned.
run "code simplification (netcheck)" python3 tools/code_simplification.py netcheck -i medium
run "code simplification (tools)" python3 tools/code_simplification.py tools -i medium
run "code simplification (tests)" python3 tools/code_simplification.py tests -i medium
run "security review (high)" python3 tools/security_review.py . -i high
# The app root, not backend/: README.md is app-level documentation and
# stays beside AGENTS.md, while every .py this scans lives under backend/.
run "documentation check (medium)" python3 tools/documentation_check.py .. -i medium

for script in tools/fix_*.sh; do
    [ -f "$script" ] && run "shell syntax: $script" bash -n "$script"
done

echo "============================"
if [ "$failed" -eq 0 ]; then
    echo "All checks passed."
else
    echo "One or more checks FAILED -- see above."
fi
exit "$failed"
