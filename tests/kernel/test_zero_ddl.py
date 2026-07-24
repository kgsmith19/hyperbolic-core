"""Acceptance 1: life domains land with ZERO new migrations (invariant 1)."""

from pathlib import Path
from uuid import UUID

from kernel.access import AccessContext
from kernel.services import find

MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


def test_only_the_kernel_migration_exists(seeded: dict[str, UUID]) -> None:
    names = sorted(f.name for f in MIGRATIONS.glob("*.sql"))
    assert names == ["20260724000000_kernel.sql"]


def test_seeded_domains_exist_as_data(seeded: dict[str, UUID], ctx: AccessContext) -> None:
    people = find(ctx, type_name="person")
    workouts = find(ctx, type_name="workout")
    assert seeded["person"] in {e.id for e in people}
    assert {seeded["run"], seeded["lift"]} <= {e.id for e in workouts}
