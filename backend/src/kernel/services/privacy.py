"""The erasure path (invariant 9). PII flagged in a type's ``x-pii`` can be
removed from live state *and* from event payloads, without deleting a single
event row: the log keeps its shape, only flagged values disappear.

Append-only (invariant 2) is preserved by the trigger in migration 0002 — it
permits an UPDATE only while ``lifeos.redacting`` is set and only when every
column except ``payload`` is unchanged. Nothing outside this module sets it.
"""

from copy import deepcopy
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb
from pydantic import BaseModel

from kernel import db
from kernel.access import AccessContext, require
from kernel.events import DEFAULT_ACTOR, append_event, tx_now
from kernel.services.common import entity_domains, entity_type_names, load_entity, load_type
from kernel.services.queries import history


class ForgetResult(BaseModel):
    entity_id: UUID
    fields: list[str]
    events_redacted: int


def _strip(value: Any, fields: set[str]) -> Any:
    """Drop flagged keys from every ``attributes`` object in a payload.

    Only ``attributes`` maps hold domain data; the envelope around them (ids,
    timestamps, relation names) is kernel structure and must survive so replay
    still works.
    """
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, inner in value.items():
            if key == "attributes" and isinstance(inner, dict):
                out[key] = {k: v for k, v in inner.items() if k not in fields}
            else:
                out[key] = _strip(inner, fields)
        return out
    if isinstance(value, list):
        return [_strip(item, fields) for item in value]
    return value


def _redact_payload(payload: dict[str, Any], fields: set[str]) -> dict[str, Any]:
    out: dict[str, Any] = _strip(deepcopy(payload), fields)
    entity = out.get("entity")
    if isinstance(entity, dict) and "name" in fields:
        entity["name"] = None
    return out


def redacted_fields(ctx: AccessContext, entity_id: UUID) -> set[str]:
    """Fields already erased from this entity, per its own ``pii.redacted``
    events (the payload ``forget`` appends: ``{"fields": [...]}``).

    The read half of durable erasure (invariant 9, ADR 012): ``capture`` merges
    new attributes over old, so a writer that re-materializes data from a source
    erasure never touched — a feed, a stored document — must strip these fields
    first, or its next run would silently write the erasure back.
    """
    fields: set[str] = set()
    for event in history(ctx, entity_id):
        if event.event_type == "pii.redacted":
            fields |= {f for f in event.payload.get("fields", []) if isinstance(f, str)}
    return fields


def writable_attributes(
    ctx: AccessContext, entity_id: UUID, attributes: dict[str, Any]
) -> dict[str, Any]:
    """``attributes`` minus everything this entity has had erased.

    A writer that re-materializes data from a source erasure never touched --
    a feed, a stored document, an API pull -- must strip these fields first,
    or its next run would silently write the erasure back (invariant 9,
    ADR 012 "Durable erasure"). Shared by every domain ingest path that
    upserts onto an existing entity (calendar, cpap, money).
    """
    redacted = redacted_fields(ctx, entity_id)
    return {k: v for k, v in attributes.items() if k not in redacted}


def forget(
    ctx: AccessContext,
    entity_id: UUID,
    fields: list[str] | None = None,
    actor: str = DEFAULT_ACTOR,
) -> ForgetResult:
    """Redact PII-flagged fields for one entity, everywhere it was recorded.

    ``fields=None`` redacts every field flagged by the entity's types. Passing
    fields that are not PII-flagged is an error: erasure follows the schema's
    own declaration, it does not become a general-purpose delete.
    """
    with db.connect() as conn:
        entity = load_entity(conn, entity_id)
        for domain in sorted(entity_domains(conn, entity_id)):
            require(ctx, f"{domain}:write")

        flagged: set[str] = set()
        for type_name in entity_type_names(conn, entity_id):
            flagged |= set(load_type(conn, type_name).pii_fields)
        if fields is None:
            targets = flagged
        else:
            unknown = sorted(set(fields) - flagged)
            if unknown:
                raise ValueError(f"not PII-flagged on this entity: {unknown}")
            targets = set(fields)
        if not targets:
            raise ValueError(f"entity {entity_id} has no PII-flagged fields")

        # Events that mention this entity anywhere — including edge events,
        # which are recorded against the edge's from_entity.
        rows = conn.execute(
            """
            select id, payload from event
            where entity_id = %s or payload::text like %s
            order by recorded_at, id
            """,
            (entity_id, f"%{entity_id}%"),
        ).fetchall()

        conn.execute("select set_config('lifeos.redacting', 'on', true)")
        redacted = 0
        for row in rows:
            scrubbed = _redact_payload(row["payload"], targets)
            if scrubbed != row["payload"]:
                conn.execute(
                    "update event set payload = %s where id = %s", (Jsonb(scrubbed), row["id"])
                )
                redacted += 1
        conn.execute("select set_config('lifeos.redacting', 'off', true)")

        # Projections must match what replaying the redacted log would produce.
        conn.execute(
            "update entity set attributes = attributes - %s::text[], name = %s where id = %s",
            (sorted(targets), None if "name" in targets else entity.name, entity_id),
        )
        conn.execute(
            """
            update edge set attributes = attributes - %s::text[]
            where from_entity = %s or to_entity = %s
            """,
            (sorted(targets), entity_id, entity_id),
        )

        now = tx_now(conn)
        append_event(
            conn,
            entity_id=entity_id,
            event_type="pii.redacted",
            payload={"fields": sorted(targets), "events_redacted": redacted},
            valid_time=now,
            recorded_at=now,
            actor=actor,
        )
        return ForgetResult(entity_id=entity_id, fields=sorted(targets), events_redacted=redacted)
