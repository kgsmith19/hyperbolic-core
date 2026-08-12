"""Invariant 9: every PII field must have a working deletion path.

Erasure is redaction, not deletion: event rows survive, flagged values do not.
"""

import json
from datetime import UTC, datetime
from uuid import UUID

import pytest

from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.projections import rebuild
from kernel.services import capture, forget, get_entity, history, relate

SECRET_EMAIL = "forget-me@example.com"
SECRET_NAME = "Forget Me"


def _make_person(ctx: AccessContext) -> UUID:
    result = capture(ctx, "person", {"full_name": SECRET_NAME, "emails": [SECRET_EMAIL]})
    return result.entity_id


def _event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def _history_text(ctx: AccessContext, entity_id: UUID) -> str:
    return json.dumps([event.payload for event in history(ctx, entity_id)])


def test_forget_erases_pii_from_state_and_history(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    entity_id = _make_person(ctx)
    assert SECRET_EMAIL in _history_text(ctx, entity_id)
    before = _event_count()

    result = forget(ctx, entity_id)

    assert set(result.fields) == {"full_name", "emails", "birthday"}
    assert result.events_redacted >= 1
    # No event row was destroyed; one audit event was appended.
    assert _event_count() == before + 1

    view = get_entity(ctx, entity_id)
    assert "emails" not in view.entity.attributes
    assert "full_name" not in view.entity.attributes
    trail = _history_text(ctx, entity_id)
    assert SECRET_EMAIL not in trail
    assert SECRET_NAME not in trail
    assert "pii.redacted" in [event.event_type for event in history(ctx, entity_id)]


def test_forget_holds_through_projection_rebuild(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    entity_id = _make_person(ctx)
    relate(ctx, seeded["run"], "witnessed_by", entity_id, valid_from=datetime.now(UTC))
    forget(ctx, entity_id)

    with db.connect() as conn:
        rebuild(conn)

    view = get_entity(ctx, entity_id)
    assert "emails" not in view.entity.attributes
    assert SECRET_EMAIL not in _history_text(ctx, entity_id)


def test_forget_requires_write_scope(seeded: dict[str, UUID], ctx: AccessContext) -> None:
    entity_id = _make_person(ctx)
    with pytest.raises(ScopeError):
        forget(AccessContext.of("relationships:read"), entity_id)


def test_forget_refuses_fields_that_are_not_pii(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    entity_id = _make_person(ctx)
    with pytest.raises(ValueError, match="not PII-flagged"):
        forget(ctx, entity_id, fields=["full_name", "shoe_size"])


def test_forget_on_entity_without_pii_flags_is_rejected(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    with pytest.raises(ValueError, match="no PII-flagged fields"):
        forget(ctx, seeded["run"])
