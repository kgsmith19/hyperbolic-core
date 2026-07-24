"""Edge writes: bi-temporal, superseded never deleted (invariant 3)."""

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from kernel import db
from kernel.access import AccessContext, require
from kernel.db import Connection
from kernel.events import DEFAULT_ACTOR, append_event, iso, tx_now
from kernel.models import Edge
from kernel.projections import apply_event
from kernel.services.common import entity_domains, load_entity


def _require_write_on_endpoints(
    ctx: AccessContext, conn: Connection, from_id: UUID, to_id: UUID
) -> None:
    for domain in sorted(entity_domains(conn, from_id) | entity_domains(conn, to_id)):
        require(ctx, f"{domain}:write")


def relate(
    ctx: AccessContext,
    from_id: UUID,
    relation: str,
    to_id: UUID,
    valid_from: datetime,
    attributes: dict[str, Any] | None = None,
    actor: str = DEFAULT_ACTOR,
) -> Edge:
    with db.connect() as conn:
        load_entity(conn, from_id)
        load_entity(conn, to_id)
        _require_write_on_endpoints(ctx, conn, from_id, to_id)
        conn.execute("set constraints all deferred")
        now = tx_now(conn)
        edge_id = uuid4()
        edge_row = {
            "id": str(edge_id),
            "from_entity": str(from_id),
            "relation": relation,
            "to_entity": str(to_id),
            "attributes": attributes or {},
            "valid_from": iso(valid_from),
            "valid_to": None,
            "recorded_at": iso(now),
            "superseded_at": None,
        }
        append_event(
            conn,
            entity_id=from_id,
            event_type="edge.created",
            payload={"edge": edge_row},
            valid_time=valid_from,
            recorded_at=now,
            actor=actor,
        )
        apply_event(conn, "edge.created", {"edge": edge_row})
        return Edge(
            id=edge_id,
            from_entity=from_id,
            relation=relation,
            to_entity=to_id,
            attributes=attributes or {},
            valid_from=valid_from,
            valid_to=None,
            recorded_at=now,
            superseded_at=None,
        )


def supersede_edge(
    ctx: AccessContext,
    edge_id: UUID,
    valid_to: datetime,
    actor: str = DEFAULT_ACTOR,
) -> Edge:
    with db.connect() as conn:
        row = conn.execute("select * from edge where id = %s", (edge_id,)).fetchone()
        if row is None:
            raise LookupError(f"unknown edge: {edge_id}")
        if row["superseded_at"] is not None:
            raise ValueError(f"edge already superseded: {edge_id}")
        _require_write_on_endpoints(ctx, conn, row["from_entity"], row["to_entity"])
        conn.execute("set constraints all deferred")
        now = tx_now(conn)
        edge_row = {
            "id": str(row["id"]),
            "from_entity": str(row["from_entity"]),
            "relation": row["relation"],
            "to_entity": str(row["to_entity"]),
            "attributes": row["attributes"],
            "valid_from": iso(row["valid_from"]),
            "valid_to": iso(valid_to),
            "recorded_at": iso(row["recorded_at"]),
            "superseded_at": iso(now),
        }
        append_event(
            conn,
            entity_id=row["from_entity"],
            event_type="edge.superseded",
            payload={"edge": edge_row},
            valid_time=valid_to,
            recorded_at=now,
            actor=actor,
        )
        apply_event(conn, "edge.superseded", {"edge": edge_row})
        updated = conn.execute("select * from edge where id = %s", (edge_id,)).fetchone()
        assert updated is not None
        return Edge.model_validate(updated)
