"""Acceptance 7: wipe projections, replay events, state restores exactly.

If this fails, the event payloads are wrong — fix them, not the test.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from kernel import db
from kernel.access import AccessContext
from kernel.projections import rebuild
from kernel.services import relate, supersede_edge


def _snapshot(conn: db.Connection) -> tuple[list[dict[str, Any]], ...]:
    entities = conn.execute(
        "select id, name, attributes, created_at, updated_at from entity order by id"
    ).fetchall()
    entity_types = conn.execute(
        "select entity_id, type_id from entity_type order by entity_id, type_id"
    ).fetchall()
    edges = conn.execute(
        "select id, from_entity, relation, to_entity, attributes, valid_from,"
        " valid_to, recorded_at, superseded_at from edge order by id"
    ).fetchall()
    return entities, entity_types, edges


def test_projection_rebuild_restores_state(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    # include a superseded edge so replay covers every projection event type
    extra = relate(
        ctx, seeded["lift"], "performed_by", seeded["person"],
        valid_from=datetime(2026, 7, 22, 18, 0, tzinfo=UTC),
    )
    supersede_edge(ctx, extra.id, valid_to=datetime(2026, 7, 23, tzinfo=UTC))

    with db.connect() as conn:
        before = _snapshot(conn)
    assert before[0], "seed must have produced entities"

    with db.connect() as conn:
        applied = rebuild(conn)
    assert applied > 0

    with db.connect() as conn:
        after = _snapshot(conn)
    assert after == before
