"""Shared read helpers for the ops cell's derived rollups.

Promoted here once a third module (briefing, freshness, adherence) needed the
same two helpers — the `domains.money.common` precedent.
"""

from datetime import UTC, datetime

from kernel import services
from kernel.access import AccessContext
from kernel.models import Entity


def optional_find(
    ctx: AccessContext, type_name: str, filters: dict[str, object] | None = None
) -> list[Entity]:
    """Entities of a type that may not be defined yet — a fresh box has no
    data until the owning slice's jobs have run. Absent type means an empty
    section, not a crash; a missing SCOPE on a defined type propagates as
    ScopeError instead of composing an empty section forever (the PR #49
    precedent: a scope-filtered view like `list_types` answers "visible",
    never "defined")."""
    try:
        return services.find(ctx, type_name=type_name, filters=filters)
    except LookupError:
        return []


def parse_when(value: object) -> datetime | None:
    """An entity's ISO timestamp attribute as an aware datetime, or None for
    anything unparseable. Naive values read as UTC (ADR 012 stores UTC)."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)
