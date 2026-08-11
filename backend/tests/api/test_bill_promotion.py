"""The generic capture route may not promote a bill (ADR 017).

`"verified"` has to be a real value of `status` for the verifier to write it,
which means `POST /capture` can express it too — and the owner context holds
every scope. The route dispatches to the domain, which refuses; this is the
happy path and the refusal, at the HTTP boundary where a hostile caller lives.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from api.main import app
from domains.bills.types import (
    STATUS_CANDIDATE,
    STATUS_VERIFIED,
    TYPE_BILL,
    TYPE_VERIFICATION,
    define_bills_types,
)
from kernel.access import AccessContext

client = TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def bills_types(seeded: object) -> None:
    define_bills_types(AccessContext.of("bills:read", "bills:write"))


def candidate_body(**overrides: Any) -> dict[str, Any]:
    attributes: dict[str, Any] = {
        "bill_key": f"{uuid4().int:064x}",
        "status": STATUS_CANDIDATE,
        "category": "medical",
        "total": 42.0,
        "extracted_at": datetime.now(UTC).isoformat(),
        "provenance": {
            "source_entity_ids": [],
            "source_event_ids": [],
            "method": "llm_extraction",
            "confidence": 0.5,
        },
    }
    return {"type_name": TYPE_BILL, "attributes": {**attributes, **overrides}}


def test_capturing_a_candidate_bill_still_works() -> None:
    response = client.post("/capture", json=candidate_body())
    assert response.status_code == 200, response.text


def test_capture_refuses_to_mark_a_bill_verified() -> None:
    body = candidate_body(
        status=STATUS_VERIFIED, verification_receipt_id=str(uuid4())
    )  # a receipt id it invented

    response = client.post("/capture", json=body)

    assert response.status_code == 422, response.text
    assert "verifier" in response.json()["detail"]


def test_capture_refuses_a_verified_status_that_cites_no_receipt_at_all() -> None:
    """Belt and braces: even without the route guard the type would refuse this,
    because a promotion must name the receipt that granted it."""
    response = client.post("/capture", json=candidate_body(status=STATUS_VERIFIED))
    assert response.status_code == 422, response.text


def test_a_type_aliasing_the_bill_identity_field_cannot_merge_into_a_bill() -> None:
    """The bypass, end to end at the door a hostile caller actually has.

    Entity resolution matches on the identity field NAME across every type
    declaring it, and `capture` validates the INCOMING payload against the
    INCOMING type before merging. So defining any type with
    `x-identity: ["bill_key"]` and posting a real bill's key used to write
    `verified` onto that bill, never meeting `bill`'s own schema — both ADR-017
    layers defeated in one call.
    """
    created = client.post("/capture", json=candidate_body())
    assert created.status_code == 200, created.text
    bill_id = created.json()["entity_id"]
    key = client.get(f"/entities/{bill_id}").json()["entity"]["attributes"]["bill_key"]

    defined = client.post(
        "/types",
        json={
            "name": "bill_key_alias",
            "domain": "bills",
            "json_schema": {
                "type": "object",
                "properties": {"bill_key": {"type": "string"}, "status": {"type": "string"}},
                "required": ["bill_key"],
                "additionalProperties": False,
                "x-identity": ["bill_key"],
            },
        },
    )
    assert defined.status_code == 200, defined.text

    attack = client.post(
        "/capture",
        json={
            "type_name": "bill_key_alias",
            "attributes": {"bill_key": key, "status": STATUS_VERIFIED},
        },
    )

    assert attack.status_code == 422, attack.text
    assert "identity field" in attack.json()["detail"]
    after = client.get(f"/entities/{bill_id}").json()["entity"]["attributes"]
    assert after["status"] == STATUS_CANDIDATE
    assert "verification_receipt_id" not in after


def test_capture_refuses_to_write_a_verification_receipt_at_all() -> None:
    """The evidence a promotion rests on is written in-process by the job that
    did the checking. A route caller may not author it."""
    response = client.post(
        "/capture",
        json={
            "type_name": TYPE_VERIFICATION,
            "attributes": {
                "verification_key": str(uuid4()),
                "document_id": str(uuid4()),
                "passed": True,
                "checked_at": datetime.now(UTC).isoformat(),
                "provenance": {
                    "source_entity_ids": [],
                    "source_event_ids": [],
                    "method": "deterministic_verification",
                    "confidence": 1.0,
                },
            },
        },
    )
    assert response.status_code == 422, response.text


def test_forgetting_a_bill_through_the_one_endpoint_also_clears_its_receipts() -> None:
    """`forget()` is per-entity, so the generic route alone would leave the
    numbers a receipt derived from this bill sitting in a second entity
    (ADR 017). The response says how many receipts it reached, so the claim is
    checkable rather than taken on trust."""
    created = client.post("/capture", json=candidate_body())
    bill_id = created.json()["entity_id"]

    response = client.post(f"/entities/{bill_id}/forget", json={})

    assert response.status_code == 200, response.text
    body = response.json()
    assert "receipts_redacted" in body  # the bills path ran, not the generic one
    assert "total" in body["fields"]
