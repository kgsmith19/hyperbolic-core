"""Durable idempotent agent action receipts acceptance tests (#592).

Integration-tested against real kernel writes, because the claims are about what the
event log holds: a retry writes nothing, and a receipt reads back by key. Each test
uses its own idempotency key, since the session database is shared.
"""

from uuid import uuid4

import pytest

from domains.agents.receipts import (
    TYPE_RECEIPT,
    get_by_key,
    guard_capture,
    receipt_key,
    record,
)
from domains.agents.roles import Role, build_registry, default_registry
from kernel import services
from kernel.access import AccessContext, ScopeError

WRITE_AND_READ = AccessContext.of("agents:write", "agents:read")


def _key() -> str:
    return f"idem-{uuid4().hex}"


def _events(ctx: AccessContext, entity_id) -> int:
    return len(services.history(ctx, entity_id))


def test_allowed_and_denied_requests_are_both_recorded_with_reason_and_class() -> None:
    registry = default_registry()

    allowed = record(WRITE_AND_READ, registry, Role.COMMUNICATIONS, "create_drafts", _key())
    denied = record(WRITE_AND_READ, registry, Role.COMMUNICATIONS, "update_bills_sheet", _key())

    assert allowed.allowed is True
    assert allowed.action_class == "draft"
    assert allowed.duplicate is False
    assert denied.allowed is False
    assert denied.action_class == "reversible_mutation"
    assert "does not hold" in denied.reason


def test_a_retry_returns_the_original_receipt_and_writes_nothing() -> None:
    registry = default_registry()
    key = _key()
    first = record(WRITE_AND_READ, registry, Role.COMMUNICATIONS, "read_emails", key)
    before = _events(WRITE_AND_READ, first.entity_id)

    second = record(WRITE_AND_READ, registry, Role.COMMUNICATIONS, "read_emails", key)

    assert second.duplicate is True
    assert second.entity_id == first.entity_id
    assert second.recorded_at == first.recorded_at
    assert _events(WRITE_AND_READ, first.entity_id) == before


def test_a_retry_cannot_turn_a_denial_into_an_approval() -> None:
    key = _key()
    denied = record(
        WRITE_AND_READ, default_registry(), Role.COMMUNICATIONS, "update_bills_sheet", key
    )
    # The registry now grants the permission; the original denial must still stand.
    widened = build_registry(
        {
            **{role.value: sorted(perms) for role, perms in default_registry().grants.items()},
            Role.COMMUNICATIONS.value: ["read_emails", "update_bills_sheet"],
        }
    )

    retry = record(WRITE_AND_READ, widened, Role.COMMUNICATIONS, "update_bills_sheet", key)

    assert denied.allowed is False
    assert retry.duplicate is True
    assert retry.allowed is False


def test_a_receipt_reads_back_from_the_kernel_by_its_request_identity() -> None:
    key = _key()
    recorded = record(
        WRITE_AND_READ, default_registry(), Role.RELIABILITY_ENGINEER, "query_telemetry", key
    )

    found = get_by_key(WRITE_AND_READ, Role.RELIABILITY_ENGINEER, "query_telemetry", key)

    assert found is not None
    assert found.receipt_key == receipt_key("reliability_engineer", "query_telemetry", key)
    assert found.entity_id == recorded.entity_id
    assert found.allowed is True


def test_an_unrecorded_request_reads_back_as_none() -> None:
    assert get_by_key(WRITE_AND_READ, Role.RELIABILITY_ENGINEER, "query_telemetry", _key()) is None


def test_a_blank_idempotency_key_is_refused_on_record_and_read() -> None:
    with pytest.raises(ValueError, match="idempotency key"):
        record(
            WRITE_AND_READ, default_registry(), Role.RELIABILITY_ENGINEER, "query_telemetry", "   "
        )
    with pytest.raises(ValueError, match="idempotency key"):
        get_by_key(WRITE_AND_READ, Role.RELIABILITY_ENGINEER, "query_telemetry", "")


def test_recording_needs_agents_write() -> None:
    with pytest.raises(ScopeError):
        record(
            AccessContext.of("agents:read"),
            default_registry(),
            Role.SECURITY,
            "query_telemetry",
            _key(),
        )


def test_reading_needs_agents_read() -> None:
    with pytest.raises(ScopeError):
        get_by_key(
            AccessContext.of("agents:write"), Role.RELIABILITY_ENGINEER, "query_telemetry", _key()
        )


def test_the_receipt_stores_a_hash_not_the_key_and_no_free_text() -> None:
    key = _key()
    recorded = record(
        WRITE_AND_READ, default_registry(), Role.RELIABILITY_ENGINEER, "query_telemetry", key
    )

    entity = services.get_entity(WRITE_AND_READ, recorded.entity_id).entity
    assert set(entity.attributes) == {
        "receipt_key",
        "role",
        "permission",
        "action_class",
        "allowed",
        "reason",
        "recorded_at",
    }
    assert key not in str(entity.attributes)


def test_the_generic_capture_path_refuses_receipt_records() -> None:
    with pytest.raises(ValueError, match="written only by the gate"):
        guard_capture(TYPE_RECEIPT)
    guard_capture("intention")  # any other type passes through
