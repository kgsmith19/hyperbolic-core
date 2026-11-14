"""Bounded JSON entry point for the LifeOS Drive storage-policy scan."""

from __future__ import annotations

import argparse
import base64
import json
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TextIO

from domains.ops.drive_policy import DriveDocument, DriveManifest, DriveTable, plan_repairs, scan


@contextmanager
def _no_echo(stream: TextIO) -> Iterator[None]:
    """Suppress terminal echo for streamed manifests and restore it before reporting."""
    if not stream.isatty():
        yield
        return

    try:
        import termios
    except ImportError as exc:
        raise ValueError(
            "hidden TTY input is unavailable; pipe the manifest through non-interactive stdin"
        ) from exc

    descriptor = stream.fileno()
    original = termios.tcgetattr(descriptor)
    hidden = original.copy()
    hidden[3] &= ~termios.ECHO
    termios.tcsetattr(descriptor, termios.TCSANOW, hidden)
    try:
        yield
    finally:
        termios.tcsetattr(descriptor, termios.TCSANOW, original)


def load_payload(path: Path, stdin: TextIO, *, base64_lines: bool = False) -> dict[str, Any]:
    """Load a manifest from a file or stdin; callers can avoid persisting document content."""
    if str(path) == "-" and base64_lines:
        chunks: list[str] = []
        with _no_echo(stdin):
            while True:
                line = stdin.readline()
                if not line or not line.strip():
                    break
                chunks.append(line.strip())
        raw = base64.b64decode("".join(chunks), validate=True).decode()
    elif str(path) == "-":
        # The plain stdin form is one JSON line so automation does not wait for EOF.
        with _no_echo(stdin):
            raw = stdin.readline()
    else:
        raw = path.read_text()
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("manifest root must be an object")
    return payload


def _tables(item: dict[str, Any], document_number: int) -> tuple[DriveTable, ...]:
    raw_tables = item.get("tables", [])
    if not isinstance(raw_tables, list):
        raise ValueError(f"document {document_number} tables must be a list")
    parsed: list[DriveTable] = []
    for table_number, table in enumerate(raw_tables, start=1):
        if not isinstance(table, dict) or not isinstance(table.get("rows"), list):
            raise ValueError(
                f"document {document_number} tables[{table_number}] must contain a row list"
            )
        rows: list[tuple[str, ...]] = []
        for row_number, row in enumerate(table["rows"], start=1):
            if not isinstance(row, list):
                raise ValueError(
                    f"document {document_number} tables[{table_number}] row {row_number} "
                    "must be a list"
                )
            rows.append(tuple(str(cell) for cell in row))
        parsed.append(DriveTable(rows=tuple(rows)))
    return tuple(parsed)


def run(payload: dict[str, Any], archive_parent_id: str | None = None) -> dict[str, Any]:
    documents_raw = payload.get("documents")
    archives_raw = payload.get("archive_parent_ids", [])
    if not isinstance(documents_raw, list) or not isinstance(archives_raw, list):
        raise ValueError("manifest must contain document and archive-parent lists")
    documents_list: list[DriveDocument] = []
    for document_number, item in enumerate(documents_raw, start=1):
        if not isinstance(item, dict):
            raise ValueError("every manifest document must be an object")
        parents = item.get("parent_ids", [])
        if not isinstance(parents, list):
            raise ValueError(f"document {document_number} parent_ids must be a list")
        documents_list.append(
            DriveDocument(
                file_id=str(item["file_id"]),
                revision_id=str(item["revision_id"]),
                mime_type=str(item["mime_type"]),
                parent_ids=tuple(str(parent) for parent in parents),
                content=str(item["content"]),
                tables=_tables(item, document_number),
            )
        )
    documents = tuple(documents_list)
    findings = scan(
        DriveManifest(
            documents=documents,
            archive_parent_ids=frozenset(str(parent) for parent in archives_raw),
        )
    )
    plan = plan_repairs(findings, archive_parent_id) if archive_parent_id else None
    return {
        "documents_scanned": len(documents),
        "findings": len(findings),
        "items": [
            {
                "file_id": item.file_id,
                "revision_id": item.revision_id,
                "rule": item.rule,
                "workbook": item.workbook,
                "sheet": item.sheet,
                "line_number": item.line_number,
                "source_locator": item.source_locator,
                "record_key": item.record_key,
                "evidence_fingerprint": item.evidence_fingerprint,
            }
            for item in findings
        ],
        "plan_digest": plan.digest if plan else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--archive-parent-id")
    parser.add_argument(
        "--stdin-base64-lines",
        action="store_true",
        help="read no-echo base64 chunks from stdin until a blank line",
    )
    args = parser.parse_args()
    payload = load_payload(
        args.manifest,
        sys.stdin,
        base64_lines=args.stdin_base64_lines,
    )
    print(json.dumps(run(payload, archive_parent_id=args.archive_parent_id), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
