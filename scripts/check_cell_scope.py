"""Enforce LifeOS cell ownership against a pull request diff."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

_OWNS_LINE = re.compile(r"(?m)^Owns:\s*(.+?)\s*$")
_BACKTICK = re.compile(r"`([^`]+)`")
_CELLS_LINE = re.compile(r"(?im)^\s*Cells:\s*(.*?)\s*$")
_CELL_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _parse_constitution(cell: str, text: str) -> tuple[str, ...]:
    owns_lines = _OWNS_LINE.findall(text)
    if len(owns_lines) != 1:
        raise ValueError(f'{cell}: expected exactly one "Owns:" line')

    raw_patterns = _BACKTICK.findall(owns_lines[0])
    if not raw_patterns:
        raise ValueError(f"{cell}: Owns line contains no backticked paths")

    prefixes: list[str] = []
    for pattern in raw_patterns:
        normalized = pattern.replace("\\", "/")
        if (
            not normalized.endswith("/**")
            or normalized.startswith("/")
            or normalized.startswith("./")
            or "*" in normalized[:-2]
            or ".." in normalized.split("/")
        ):
            raise ValueError(f"{cell}: unsupported ownership pattern: {pattern}")
        prefixes.append(normalized[:-2])
    return tuple(sorted(set(prefixes)))


def _validate_ownership(ownership: dict[str, tuple[str, ...]]) -> None:
    entries = [
        (cell, prefix)
        for cell, prefixes in ownership.items()
        for prefix in prefixes
    ]
    for index, (cell, prefix) in enumerate(entries):
        for other_cell, other_prefix in entries[index + 1 :]:
            if cell == other_cell:
                continue
            if prefix.startswith(other_prefix) or other_prefix.startswith(prefix):
                raise ValueError(
                    "cell ownership prefixes overlap: "
                    f"{cell}:{prefix} and {other_cell}:{other_prefix}"
                )


def load_ownership(root: Path) -> dict[str, tuple[str, ...]]:
    domains = root / ".agents" / "domains"
    constitutions = sorted(domains.glob("*/CONSTITUTION.md"))
    if not constitutions:
        raise ValueError("no cell constitutions found")

    ownership = {
        path.parent.name: _parse_constitution(
            path.parent.name, path.read_text(encoding="utf-8")
        )
        for path in constitutions
    }
    _validate_ownership(ownership)
    return dict(sorted(ownership.items()))


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ValueError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def load_ownership_from_git(root: Path, revision: str) -> dict[str, tuple[str, ...]]:
    paths = [
        line
        for line in _git(
            root,
            "ls-tree",
            "-r",
            "--name-only",
            revision,
            "--",
            ".agents/domains",
        ).splitlines()
        if line.endswith("/CONSTITUTION.md")
    ]
    if not paths:
        raise ValueError(f"no cell constitutions found at {revision}")

    ownership: dict[str, tuple[str, ...]] = {}
    for path in paths:
        cell = Path(path).parent.name
        ownership[cell] = _parse_constitution(
            cell, _git(root, "show", f"{revision}:{path}")
        )
    _validate_ownership(ownership)
    return dict(sorted(ownership.items()))


def merge_ownership(
    base: dict[str, tuple[str, ...]], head: dict[str, tuple[str, ...]]
) -> dict[str, tuple[str, ...]]:
    cells = set(base) | set(head)
    merged = {
        cell: tuple(sorted(set(base.get(cell, ())) | set(head.get(cell, ()))))
        for cell in cells
    }
    _validate_ownership(merged)
    return dict(sorted(merged.items()))


def parse_declared_cells(body: str | None) -> set[str]:
    matches = _CELLS_LINE.findall(body or "")
    if len(matches) > 1:
        raise ValueError("multiple Cells: lines make PR scope ambiguous")
    if not matches:
        return set()

    value = matches[0].strip()
    if not value or value.lower() == "none":
        return set()

    cells = {part.strip().lower() for part in value.split(",") if part.strip()}
    invalid = sorted(cell for cell in cells if not _CELL_NAME.fullmatch(cell))
    if invalid:
        raise ValueError(f"invalid cell name(s): {', '.join(invalid)}")
    return cells


def validate_scope(
    changed_files: list[str],
    declared_cells: set[str],
    ownership: dict[str, tuple[str, ...]],
) -> set[str]:
    unknown = declared_cells - set(ownership)
    if unknown:
        raise ValueError(f"unknown cell declaration(s): {', '.join(sorted(unknown))}")

    touched: set[str] = set()
    for file_name in changed_files:
        normalized = file_name.replace("\\", "/")
        if normalized.startswith("./"):
            normalized = normalized[2:]
        matches = {
            cell
            for cell, prefixes in ownership.items()
            if any(normalized.startswith(prefix) for prefix in prefixes)
        }
        if len(matches) > 1:
            raise ValueError(
                f"{normalized} matches overlapping cells: {', '.join(sorted(matches))}"
            )
        touched.update(matches)

    missing = touched - declared_cells
    if missing:
        raise ValueError(f"undeclared cell(s) touched: {', '.join(sorted(missing))}")

    extra = declared_cells - touched
    if extra:
        raise ValueError(
            "Cells declaration does not match the touched cells; extra: "
            + ", ".join(sorted(extra))
        )
    return touched


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--changed-files", required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--base-sha")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    head = load_ownership(root)
    ownership = (
        merge_ownership(load_ownership_from_git(root, args.base_sha), head)
        if args.base_sha
        else head
    )

    changed_files = [
        line.strip()
        for line in Path(args.changed_files).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    event = json.loads(Path(args.event).read_text(encoding="utf-8"))
    body = event.get("pull_request", {}).get("body")
    declared = parse_declared_cells(body)
    touched = validate_scope(changed_files, declared, ownership)
    print(
        "cell-scope: PASS ("
        + (", ".join(sorted(touched)) if touched else "no owned cells touched")
        + ")"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"cell-scope: FAIL: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
