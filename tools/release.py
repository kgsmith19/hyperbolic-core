"""Release helper: version bumps and a changelog draft from git history.

Stdlib only, like everything else in this repo. Two subcommands:

    python tools/release.py bump {major,minor,patch}
        Bumps netcheck/__init__.py's __version__ and prints the new version.

    python tools/release.py changelog [--since TAG]
        Prints commit subjects since the last tag (or --since), one per
        line, formatted for pasting into CHANGELOG.md. Does not write
        anything -- the changelog entry itself is worth a human's editorial
        pass, not full automation.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

INIT_PY = Path(__file__).resolve().parent.parent / "netcheck" / "__init__.py"
VERSION_RE = re.compile(r'^__version__ = "(\d+)\.(\d+)\.(\d+)"$', re.MULTILINE)


def current_version(text):
    """Read the __version__ string out of netcheck/__init__.py's text."""
    m = VERSION_RE.search(text)
    if not m:
        raise ValueError("no __version__ = \"X.Y.Z\" line found")
    return f"{m.group(1)}.{m.group(2)}.{m.group(3)}"


def bump_version(version, part):
    """major.minor.patch -> the next version, resetting lower parts to 0."""
    major, minor, patch = (int(p) for p in version.split("."))
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    if part == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ValueError(f"unknown part: {part!r}")


def write_version(text, new_version):
    """Return `text` with its __version__ line replaced by `new_version`."""
    return VERSION_RE.sub(f'__version__ = "{new_version}"', text, count=1)


def _last_tag():
    result = subprocess.run(["git", "describe", "--tags", "--abbrev=0"],
                            capture_output=True, text=True, timeout=10)
    return result.stdout.strip() if result.returncode == 0 else None


def changelog_entries(since=None):
    """Commit subjects since `since` (or the last tag, or the whole history
    if there's no tag yet), oldest first."""
    ref = since or _last_tag()
    range_arg = f"{ref}..HEAD" if ref else "HEAD"
    result = subprocess.run(["git", "log", "--reverse", "--format=%s", range_arg],
                            capture_output=True, text=True, timeout=10)
    return [line for line in result.stdout.splitlines() if line.strip()]


def cmd_bump(args):
    text = INIT_PY.read_text()
    old = current_version(text)
    new = bump_version(old, args.part)
    INIT_PY.write_text(write_version(text, new))
    print(f"{old} -> {new}")
    return 0


def cmd_changelog(args):
    entries = changelog_entries(args.since)
    if not entries:
        print("No commits since the last tag.")
        return 0
    for line in entries:
        print(f"- {line}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("bump", help="bump netcheck/__init__.py's __version__")
    b.add_argument("part", choices=["major", "minor", "patch"])
    b.set_defaults(fn=cmd_bump)

    c = sub.add_parser("changelog", help="list commits since the last tag")
    c.add_argument("--since", default=None, help="ref to diff from (default: last tag)")
    c.set_defaults(fn=cmd_changelog)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
