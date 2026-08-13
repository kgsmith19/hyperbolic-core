"""Release helper: version-parity checks and changelog drafts.

Stdlib only, like everything else in this repo. Three subcommands:

    python tools/release.py bump {major,minor,patch}
        Fails closed until forward/down registry-migration generation exists.
        Applied migration files are immutable and are never rewritten.

    python tools/release.py check
        Verifies runtime, manifest, registry payload, and hash parity.

    python tools/release.py changelog [--since TAG]
        Prints commit subjects since the last tag (or --since), one per
        line, formatted for pasting into CHANGELOG.md. Does not write
        anything -- the changelog entry itself is worth a human's editorial
        pass, not full automation.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
INIT_PY = APP_ROOT / "netcheck" / "__init__.py"
MANIFEST = APP_ROOT / "tool.json"
REGISTRY = (APP_ROOT.parents[1] / "supabase" / "migrations"
            / json.loads(MANIFEST.read_text())["lifecycle"]["register"])
VERSION_RE = re.compile(r'^__version__ = "(\d+)\.(\d+)\.(\d+)"$', re.MULTILINE)
REGISTRY_VERSION_RE = re.compile(
    r"(?m)(^\s*null,\s*$\n)(\s*)'(\d+\.\d+\.\d+)',\s*$"
)
REGISTRY_MANIFEST_RE = re.compile(r"(?m)^(\s*)'(\{.*\})'::jsonb,\s*$")
REGISTRY_HASH_RE = re.compile(r"(?m)^(\s*)'([0-9a-f]{64})',\s*$")


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


def canonical_json(value):
    """Match the toolbelt validator's stable, recursively sorted JSON."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def manifest_hash(manifest):
    """Return the registry hash used by validate-manifests.mjs."""
    return hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest()


def _single_match(pattern, text, label):
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise ValueError(f"expected exactly one registry {label}, found {len(matches)}")
    return matches[0]


def _registry_entry(text):
    """Extract the generated version, manifest, and hash from registration SQL."""
    version = _single_match(REGISTRY_VERSION_RE, text, "version").group(3)
    manifest_literal = _single_match(REGISTRY_MANIFEST_RE, text, "manifest").group(2)
    digest = _single_match(REGISTRY_HASH_RE, text, "manifest hash").group(2)
    try:
        manifest = json.loads(manifest_literal.replace("''", "'"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"registered manifest is invalid JSON: {exc}") from exc
    return version, manifest, digest


def _check_version_texts(init_text, manifest, registry_text):
    runtime_version = current_version(init_text)
    manifest_version = manifest.get("version")
    registry_version, registered_manifest, registered_hash = _registry_entry(registry_text)
    versions = {
        "runtime": runtime_version,
        "manifest": manifest_version,
        "registry": registry_version,
    }
    if len(set(versions.values())) != 1:
        raise ValueError(f"version mismatch: {versions}")
    if registered_manifest != manifest:
        raise ValueError("registered manifest does not match tool.json")
    expected_hash = manifest_hash(manifest)
    if registered_hash != expected_hash:
        raise ValueError(
            f"registered manifest hash {registered_hash} does not match {expected_hash}"
        )
    return runtime_version


def check_version_files(init_path=INIT_PY, manifest_path=MANIFEST, registry_path=REGISTRY):
    """Verify that every generated release-version representation agrees."""
    manifest = json.loads(manifest_path.read_text())
    registered_by = manifest.get("lifecycle", {}).get("register")
    if registered_by != registry_path.name:
        raise ValueError(
            f"manifest points to registry migration {registered_by!r}, "
            f"not {registry_path.name!r}"
        )
    return _check_version_texts(
        init_path.read_text(), manifest, registry_path.read_text()
    )


def _last_tag():
    result = subprocess.run(["git", "describe", "--tags", "--abbrev=0",
                             "--match", "network-checker-v[0-9]*"],
                            capture_output=True, text=True, timeout=10,
                            cwd=APP_ROOT)
    return result.stdout.strip() if result.returncode == 0 else None


def changelog_entries(since=None):
    """Commit subjects since `since` (or the last tag, or the whole history
    if there's no tag yet), oldest first."""
    ref = since or _last_tag()
    range_arg = f"{ref}..HEAD" if ref else "HEAD"
    result = subprocess.run(
        ["git", "log", "--reverse", "--format=%s", range_arg, "--", "."],
        capture_output=True,
        text=True,
        timeout=10,
        cwd=APP_ROOT,
    )
    return [line for line in result.stdout.splitlines() if line.strip()]


def cmd_bump(args):
    old = check_version_files()
    new = bump_version(old, args.part)
    print(
        f"refusing {old} -> {new}: the current registry file is an "
        "already-applied registration migration and must remain immutable.\n"
        "A version bump requires a new globally unique forward/down registry "
        "migration generator; see the release runbook. No files were changed.",
        file=sys.stderr,
    )
    return 2


def cmd_check(_args):
    print(check_version_files())
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

    b = sub.add_parser("bump", help="explain the fail-closed future-bump guard")
    b.add_argument("part", choices=["major", "minor", "patch"])
    b.set_defaults(fn=cmd_bump)

    c = sub.add_parser("changelog", help="list commits since the last tag")
    c.add_argument("--since", default=None, help="ref to diff from (default: last tag)")
    c.set_defaults(fn=cmd_changelog)

    check = sub.add_parser("check", help="verify runtime/manifest/registry parity")
    check.set_defaults(fn=cmd_check)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
