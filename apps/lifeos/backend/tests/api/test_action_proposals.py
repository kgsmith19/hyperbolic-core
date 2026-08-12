"""Approval-gated dispute drafts at the HTTP boundary (ADR 018, C4).

The domain behaviour is covered in `tests/bills/test_dispute.py`; this file is
the door a hostile caller actually has. It asserts the three things that are
properties of the *route* rather than of the domain: approval is an explicit
POST that cannot happen by reading, who approved comes from the verified
request and never from the body, and the draft is not handed out without a
matching authority receipt.

Every bill here is invented; no real medical document and no real PHI exists in
this repo.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from api.auth import LOCAL_DEV_PRINCIPAL
from api.main import app
from domains.bills.dispute import generate_proposals
from domains.bills.types import (
    ACT_DISPLAY_DRAFT,
    CHANNEL_ON_SCREEN,
    GRANT_VIA_LOCAL_DEV,
    GRANT_VIA_OWNER_SESSION,
    STATE_APPROVED,
    STATE_PROPOSED,
    STATE_REJECTED,
    STATE_WITHDRAWN,
    TYPE_AUTHORITY,
    TYPE_BILL,
    TYPE_PROPOSAL,
    define_bills_types,
)
from domains.bills.verify import verify_document
from kernel import db
from kernel.access import AccessContext
from kernel.services import capture

client = TestClient(app)

BILLS_CTX = AccessContext.of("bills:read", "bills:write")


@pytest.fixture(scope="module", autouse=True)
def bills_types(seeded: object) -> None:
    define_bills_types(BILLS_CTX)


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def a_proposal(marker: str) -> dict[str, Any]:
    """One document whose bill does not add up, verified and then proposed."""
    document_id = uuid4()
    capture(
        BILLS_CTX,
        TYPE_BILL,
        {
            "bill_key": f"{uuid4().int:064x}",
            "status": "candidate",
            "category": "medical",
            "issuer": f"Mercy {marker}",
            "account_ref": f"ACCT-{marker}",
            "service_date": "2026-03-04",
            "currency": "USD",
            "total": 140.00,
            "line_items": [{"code": "99213", "quantity": 1, "amount": 128.40}],
            "extracted_at": datetime.now(UTC).isoformat(),
            "provenance": {
                "source_entity_ids": [str(document_id)],
                "source_event_ids": [],
                "method": "llm_extraction",
                "confidence": 0.5,
            },
        },
    )
    verify_document(BILLS_CTX, document_id)
    generate_proposals(BILLS_CTX, document_ids=[document_id])
    listed = client.get("/action-proposals", params={"state": STATE_PROPOSED})
    assert listed.status_code == 200, listed.text
    found = [p for p in listed.json() if p["body"] and marker in p["body"]]
    assert len(found) == 1, found
    return found[0]


def approve(proposal: dict[str, Any]) -> Any:
    return client.post(
        f"/action-proposals/{proposal['proposal_id']}/approve",
        json={"draft_digest": proposal["draft_digest"]},
    )


def test_listing_proposals_shows_the_draft_and_writes_nothing() -> None:
    """Approval is never a side effect of reading. The listing renders the
    letter and hands back the digest an approval must echo — and emits no
    event at all while doing it."""
    proposal = a_proposal("apic4list")

    before = event_count()
    listed = client.get("/action-proposals")

    assert listed.status_code == 200, listed.text
    assert event_count() == before
    mine = [p for p in listed.json() if p["proposal_id"] == proposal["proposal_id"]]
    assert len(mine) == 1
    assert mine[0]["state"] == STATE_PROPOSED
    assert "DRAFT - NOT SENT" in mine[0]["body"]
    assert len(mine[0]["draft_digest"]) == 64


def test_the_draft_is_not_handed_out_before_it_is_approved() -> None:
    """The gate at the door. Nothing leaves without an authority receipt, and
    the refusal records nothing."""
    proposal = a_proposal("apic4ungated")

    before = event_count()
    response = client.get(f"/action-proposals/{proposal['proposal_id']}/draft")

    assert response.status_code == 409, response.text
    assert event_count() == before


def test_approving_mints_an_authority_and_then_the_draft_is_released() -> None:
    proposal = a_proposal("apic4approve")

    approved = approve(proposal)

    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["state"] == STATE_APPROVED
    authority_id = UUID(body["authority_receipt_id"])

    # who approved comes from the verified request, never from the request body —
    # and on a box running with auth off that is recorded as unverified rather
    # than dressed up as the owner
    granted = client.get(f"/entities/{authority_id}").json()["entity"]["attributes"]
    assert granted["granted_by"] == LOCAL_DEV_PRINCIPAL
    assert granted["granted_via"] == GRANT_VIA_LOCAL_DEV
    assert granted["channel"] == CHANNEL_ON_SCREEN
    assert granted["permits"] == [ACT_DISPLAY_DRAFT]

    released = client.get(f"/action-proposals/{proposal['proposal_id']}/draft")
    assert released.status_code == 200, released.text
    assert released.json()["body"] == proposal["body"]
    assert released.json()["channel"] == CHANNEL_ON_SCREEN

    # the listing stops serving the letter now that the gate governs it
    listed = client.get("/action-proposals").json()
    mine = [p for p in listed if p["proposal_id"] == proposal["proposal_id"]]
    assert mine[0]["state"] == STATE_APPROVED
    assert mine[0]["body"] is None and mine[0]["draft_digest"] is None


def test_approving_text_the_caller_never_read_is_refused() -> None:
    """`draft_digest` is required and must be this draft's. An approval that
    cannot name the text it approves is not an approval."""
    proposal = a_proposal("apic4digest")

    wrong = client.post(
        f"/action-proposals/{proposal['proposal_id']}/approve",
        json={"draft_digest": "0" * 64},
    )
    missing = client.post(f"/action-proposals/{proposal['proposal_id']}/approve", json={})

    assert wrong.status_code == 403, wrong.text
    assert missing.status_code == 422, missing.text
    assert client.get(f"/action-proposals/{proposal['proposal_id']}/draft").status_code == 409


def test_rejecting_ends_it_and_a_decided_proposal_cannot_be_approved() -> None:
    proposal = a_proposal("apic4reject")

    rejected = client.post(f"/action-proposals/{proposal['proposal_id']}/reject", json={})

    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["state"] == STATE_REJECTED
    assert rejected.json()["authority_receipt_id"] is None
    assert approve(proposal).status_code == 409
    assert client.get(f"/action-proposals/{proposal['proposal_id']}/draft").status_code == 409


def test_a_withdrawn_proposal_is_not_readable_from_the_listing_either() -> None:
    """The listing serves the letter only for `proposed`, so no decided state —
    approved, rejected or withdrawn — has an ungated read of it."""
    proposal = a_proposal("apic4withdrawn")
    rejected = client.post(f"/action-proposals/{proposal['proposal_id']}/reject", json={})
    assert rejected.status_code == 200, rejected.text

    listed = client.get("/action-proposals").json()
    mine = [p for p in listed if p["proposal_id"] == proposal["proposal_id"]]

    assert mine[0]["state"] in (STATE_REJECTED, STATE_WITHDRAWN)
    assert mine[0]["body"] is None and mine[0]["draft_digest"] is None


def test_the_approving_principal_comes_from_the_request_not_the_body() -> None:
    """A caller may not say who approved, and neither may the request body: the
    subject is read from the claims verified for this request (ADR 018)."""
    proposal = a_proposal("apic4principal")

    approved = client.post(
        f"/action-proposals/{proposal['proposal_id']}/approve",
        json={
            "draft_digest": proposal["draft_digest"],
            "granted_by": "somebody-else",
            "granted_via": GRANT_VIA_OWNER_SESSION,
        },
    )

    assert approved.status_code == 200, approved.text
    authority = client.get(f"/entities/{approved.json()['authority_receipt_id']}").json()
    attributes = authority["entity"]["attributes"]
    assert attributes["granted_by"] == LOCAL_DEV_PRINCIPAL  # not "somebody-else"
    assert attributes["granted_via"] == GRANT_VIA_LOCAL_DEV  # not the claimed one


def test_capture_refuses_to_author_a_proposal_or_an_authority() -> None:
    """An authority receipt is the artifact proving a human said yes, and a
    proposal is what one points at. A caller who could write either through the
    generic route could authorise themselves (ADR 017/018)."""
    forged_authority = client.post(
        "/capture",
        json={
            "type_name": TYPE_AUTHORITY,
            "attributes": {
                "proposal_id": str(uuid4()),
                "verification_receipt_id": str(uuid4()),
                "subject_ids": [],
                "granted_by": "somebody",
                "granted_via": GRANT_VIA_OWNER_SESSION,
                "granted_at": datetime.now(UTC).isoformat(),
                "expires_at": datetime.now(UTC).isoformat(),
                "permits": [ACT_DISPLAY_DRAFT],
                "channel": CHANNEL_ON_SCREEN,
                "provenance": {
                    "source_entity_ids": [],
                    "source_event_ids": [],
                    "method": "human_approval",
                    "confidence": 1.0,
                },
            },
        },
    )
    forged_proposal = client.post(
        "/capture",
        json={"type_name": TYPE_PROPOSAL, "attributes": {"proposal_key": "a" * 64}},
    )

    assert forged_authority.status_code == 422, forged_authority.text
    assert forged_proposal.status_code == 422, forged_proposal.text
