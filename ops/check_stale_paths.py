"""Stale-path guard for the monorepo layout (#450, AC4).

`apps/toolbelt` was dissolved and its nested apps were lifted to
`apps/<name>/`. Any tracked file that still names `apps/toolbelt` or
`toolbelt/apps` is a stale reference, unless it is history: archived docs,
applied (immutable) SQL migrations, or the frozen pre-#450 planning record.
Every allowed location is listed below and in docs/planning/monorepo-audit.md.

Usage: python3 ops/check_stale_paths.py   (exit 1 lists every stale hit)
"""

import fnmatch
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STALE = re.compile(r"apps/toolbelt|toolbelt/apps")

# History that legitimately names the old layout. Keep in step with
# docs/planning/monorepo-audit.md, section "Allowed stale-path hits".
ALLOWED = (
    "docs/archived/*",
    "supabase/migrations/*",
    "apps/*/backend/supabase/migrations/*",
    "docs/planning/0*.md",
    "docs/planning/1*.md",
    "docs/planning/issues/*",
    "docs/planning/monorepo-audit.md",
    "ops/check_stale_paths.py",
    "ops/test_check_stale_paths.py",
)


def tracked_files(root):
    out = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], check=True,
                         capture_output=True).stdout
    return [name for name in out.decode().split("\0") if name]


def allowed(path):
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in ALLOWED)


def stale_hits(root, files):
    hits = []
    for name in files:
        if allowed(name):
            continue
        path = Path(root) / name
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if STALE.search(line):
                hits.append(f"{name}:{number}: {line.strip()[:120]}")
    return hits


def main(root=ROOT):
    hits = stale_hits(root, tracked_files(root))
    for hit in hits:
        print(hit)
    if hits:
        print(f"{len(hits)} stale reference(s) to the dissolved apps/toolbelt layout", file=sys.stderr)
        return 1
    print("no stale apps/toolbelt references outside the allowed history")
    return 0


if __name__ == "__main__":
    sys.exit(main())
