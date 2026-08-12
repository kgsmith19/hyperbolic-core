"""Acceptance: life domains land with ZERO new migrations (invariant 1) and
nothing outside the kernel touches the database directly (invariant 7)."""

from pathlib import Path
from uuid import UUID

from kernel.access import AccessContext
from kernel.services import find

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase" / "migrations"
SRC = ROOT / "src"

# Every migration is kernel-owned and listed here by hand. A life domain must
# never need an entry (invariant 1); a new kernel migration must be reviewed
# against invariant 1 before this list grows.
KERNEL_MIGRATIONS = [
    "20260724000000_kernel.sql",
    "20260725000000_pii_redaction.sql",
    "20260726004147_security_lockdown.sql",
    "20260726200000_fk_indexes.sql",
]


def test_no_migration_exists_outside_the_kernel_set(seeded: dict[str, UUID]) -> None:
    names = sorted(f.name for f in MIGRATIONS.glob("*.sql"))
    assert names == KERNEL_MIGRATIONS


def test_only_the_kernel_opens_a_connection(seeded: dict[str, UUID]) -> None:
    """Invariant 7: application code reaches data through kernel services only.
    A module outside `src/kernel/` that opens a connection or runs SQL has gone
    around every scope check — add a kernel service instead."""
    offenders = [
        str(path.relative_to(SRC))
        for path in SRC.rglob("*.py")
        if not path.is_relative_to(SRC / "kernel")
        and ("db.connect(" in path.read_text() or "conn.execute(" in path.read_text())
    ]
    assert offenders == []


def test_seeded_domains_exist_as_data(seeded: dict[str, UUID], ctx: AccessContext) -> None:
    people = find(ctx, type_name="person")
    workouts = find(ctx, type_name="workout")
    assert seeded["person"] in {e.id for e in people}
    assert {seeded["run"], seeded["lift"]} <= {e.id for e in workouts}
