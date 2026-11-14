"""Capture an Operations Registry snapshot into LifeOS (#630). Read-only toward the sheet.

The caller exports the two tabs as JSON (raw cell values, title rows included), for example
from the Sheets API or an agent's Sheets connector, and runs:

    python scripts/import_registry.py snapshot.json

where snapshot.json is {"manual_blockers": [[...], ...], "task_registry": [[...], ...]}.
Either key may be absent. A tab whose header is missing a column, or that repeats a row ID, is
refused whole (exit 2) and nothing from it is captured. Re-running an unchanged snapshot writes
nothing. Prints counts only, never row text.
"""

import json
import sys
from pathlib import Path

from domains.ops import registry
from domains.ops.types import define_ops_types
from kernel.access import AccessContext

ACTOR = "scripts.import_registry"
CONTEXT = AccessContext.of("ops:read", "ops:write")


def run(snapshot: dict[str, list[list[object]]]) -> dict[str, int]:
    define_ops_types(CONTEXT)
    records: list[registry.RegistryRecord] = []
    if "manual_blockers" in snapshot:
        rows = registry.from_tab(snapshot["manual_blockers"], "Blocker ID")
        records += registry.manual_blockers(rows)
    if "task_registry" in snapshot:
        rows = registry.from_tab(snapshot["task_registry"], "Task ID")
        records += registry.task_registry(rows)
    report = registry.capture(CONTEXT, records, actor=ACTOR)
    return {"records": len(records), "captured": report.captured, "unchanged": report.unchanged}


if __name__ == "__main__":
    try:
        result = run(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
    except registry.RegistryShapeError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        sys.exit(2)
    print(" ".join(f"{k}={v}" for k, v in result.items()))
