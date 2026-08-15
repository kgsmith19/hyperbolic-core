"""Shared CLI plumbing for the tools/*.py quality scanners.

code_simplification.py, security_review.py, and documentation_check.py each
parse the same three flags (path, -i intensity, -f format), walk the same
`.git`/`__pycache__`-excluded file set, and print results in the same
text/json shape. That was three copies of identical argparse setup and
output formatting; this module is the one copy. Each scanner still owns its
own dataclass and detection logic -- only the boilerplate around it moved.
"""
import argparse
import json
from dataclasses import asdict
from pathlib import Path

DEFAULT_EXCLUDE_DIRS = {".git", "__pycache__"}


def iter_python_files(root, exclude_dirs=DEFAULT_EXCLUDE_DIRS):
    """Yield every *.py file under root, skipping excluded directory names."""
    for filepath in Path(root).rglob("*.py"):
        if not any(part in exclude_dirs for part in filepath.parts):
            yield filepath


def run(description, check_file, scan_directory):
    """Parse the shared path/-i/-f flags, run the scan, print, return exit code.

    check_file(path, intensity) and scan_directory(root, intensity) each
    return a list of dataclass instances with at least `file`, `line`,
    `severity`, and `message` fields, plus one of `rule`/`pattern` naming
    what fired. Prints text (one line per result, plus a `code_snippet`
    line when the dataclass carries one) or JSON, and returns 1 if any
    results were found, 0 otherwise -- so `main()` can `sys.exit(run(...))`.
    """
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("path", nargs="?", default=".", help="File or directory to scan")
    parser.add_argument("-i", "--intensity", choices=["low", "medium", "high"], default="medium")
    parser.add_argument("-f", "--format", choices=["text", "json"], default="text")
    args = parser.parse_args()

    path = Path(args.path)
    results = check_file(str(path), args.intensity) if path.is_file() \
        else scan_directory(str(path), args.intensity)

    if args.format == "json":
        print(json.dumps([asdict(r) for r in results]))
    else:
        for r in sorted(results, key=lambda x: (x.file, x.line)):
            kind = getattr(r, "rule", None) or getattr(r, "pattern", None)
            print(f"{r.file}:{r.line}: [{r.severity}] {kind}: {r.message}")
            snippet = getattr(r, "code_snippet", "")
            if snippet:
                print(f"  > {snippet}")

    return 1 if results else 0
