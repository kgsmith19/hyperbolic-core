"""Acceptance 1: life domains land with ZERO new migrations (invariant 1)."""

from pathlib import Path
from uuid import UUID

from kernel.access import AccessContext
from kernel.services import find

MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase" / "migrations"

# Every migration is kernel-owned and listed here by hand. A life domain must
# never need an entry (invariant 1); a new kernel migration must be reviewed
# against invariant 1 before this list grows.
KERNEL_MIGRATIONS = [
    "20260724000000_kernel.sql",
    "20260725000000_pii_redaction.sql",
    "20260726004147_security_lockdown.sql",
]


def test_no_migration_exists_outside_the_kernel_set(seeded: dict[str, UUID]) -> None:
    names = sorted(f.name for f in MIGRATIONS.glob("*.sql"))
    assert names == KERNEL_MIGRATIONS


def test_seeded_domains_exist_as_data(seeded: dict[str, UUID], ctx: AccessContext) -> None:
    people = find(ctx, type_name="person")
    workouts = find(ctx, type_name="workout")
    assert seeded["person"] in {e.id for e in people}
    assert {seeded["run"], seeded["lift"]} <= {e.id for e in workouts}
