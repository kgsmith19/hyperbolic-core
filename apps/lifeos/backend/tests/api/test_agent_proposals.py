"""Generic Brain-originated action proposals at the HTTP boundary (M4-20,
LO-4). The domain behaviour is covered in tests/agents/test_proposals.py;
this file is the door a Brain token actually has -- POST /action-proposals
to propose, the SAME approve/reject routes bills' own dispute drafts use
(dispatched by proposal kind in api/main.py, bills' own routes untouched),
and the SAME GET /action-proposals listing the Approvals page already
queries.
"""

from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from api.main import app
from domains.bills.types import STATE_APPROVED, STATE_PROPOSED, STATE_REJECTED
from kernel import db

client = TestClient(app)


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def entity_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from entity").fetchone()
        assert row is not None
        return int(row["n"])


def propose(marker: str) -> dict[str, Any]:
    response = client.post(
        "/action-proposals",
        json={
            "kind": "test.brain-kind",
            "summary": f"do the thing {marker}",
            "payload": {"marker": marker},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def approve(proposal: dict[str, Any]) -> Any:
    return client.post(
        f"/action-proposals/{proposal['proposal_id']}/approve",
        json={"draft_digest": proposal["draft_digest"]},
    )


def test_proposing_creates_a_pending_proposal_and_touches_no_other_entity(seeded: object) -> None:
    marker = f"apiagent{uuid4().hex[:12]}"
    before_entities = entity_count()

    proposal = propose(marker)

    assert proposal["state"] == STATE_PROPOSED
    assert proposal["kind"] == "test.brain-kind"
    assert marker in proposal["body"]
    # Exactly one new entity: the proposal record itself. LO-4b's "no entity
    # shall change until operator approval" made observable, not just argued.
    assert entity_count() == before_entities + 1


def test_the_proposal_appears_in_the_same_listing_the_approvals_page_already_queries(
    seeded: object,
) -> None:
    marker = f"apiagent{uuid4().hex[:12]}"
    proposal = propose(marker)

    listed = client.get("/action-proposals", params={"state": STATE_PROPOSED})
    assert listed.status_code == 200, listed.text
    mine = [p for p in listed.json() if p["proposal_id"] == proposal["proposal_id"]]
    assert len(mine) == 1
    assert mine[0]["kind"] == "test.brain-kind"


def test_approving_via_the_existing_bills_approve_route_applies_for_an_agent_proposal_too(
    seeded: object,
) -> None:
    """LO-4b's verification bullet, verbatim: 'approve via the existing
    endpoint, assert applied.' The route is the SAME one bills dispute
    drafts use -- api/main.py dispatches by proposal kind, not by a
    separate URL."""
    marker = f"apiagent{uuid4().hex[:12]}"
    proposal = propose(marker)

    before = event_count()
    approved = approve(proposal)

    assert approved.status_code == 200, approved.text
    assert approved.json()["state"] == STATE_APPROVED
    # Approving mints no authority record and performs no other write --
    # exactly one event, the proposal's own state transition.
    assert event_count() == before + 1

    listed = client.get("/action-proposals").json()
    mine = [p for p in listed if p["proposal_id"] == proposal["proposal_id"]]
    assert mine[0]["state"] == STATE_APPROVED
    assert mine[0]["body"] is None and mine[0]["draft_digest"] is None


def test_approving_text_the_caller_never_read_is_refused(seeded: object) -> None:
    marker = f"apiagent{uuid4().hex[:12]}"
    proposal = propose(marker)

    wrong = client.post(
        f"/action-proposals/{proposal['proposal_id']}/approve",
        json={"draft_digest": "0" * 64},
    )
    assert wrong.status_code == 403, wrong.text


def test_rejecting_via_the_existing_route_ends_it(seeded: object) -> None:
    marker = f"apiagent{uuid4().hex[:12]}"
    proposal = propose(marker)

    rejected = client.post(f"/action-proposals/{proposal['proposal_id']}/reject", json={})

    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["state"] == STATE_REJECTED
    assert approve(proposal).status_code == 409


def test_capture_refuses_to_author_an_agent_proposal_directly(seeded: object) -> None:
    """A caller who could write a pre-decided agent_action_proposal through
    the generic route could approve itself -- the same reasoning bills'
    own test_capture_refuses_to_author_a_proposal_or_an_authority states."""
    forged = client.post(
        "/capture",
        json={
            "type_name": "agent_action_proposal",
            "attributes": {"agent_proposal_key": "a" * 64, "state": STATE_APPROVED},
        },
    )
    assert forged.status_code == 422, forged.text


def test_a_bills_proposal_still_goes_through_the_unmodified_bills_approve_path(
    seeded: object,
) -> None:
    """Regression guard: dispatching by proposal kind must never change
    behavior for a bills proposal. Full coverage of that path stays in
    tests/api/test_action_proposals.py; this only re-asserts the listing
    still carries a bills-kind proposal alongside any agent ones."""
    from datetime import UTC, datetime

    from domains.bills.dispute import generate_proposals
    from domains.bills.types import TYPE_BILL, define_bills_types
    from domains.bills.verify import verify_document
    from kernel.access import AccessContext
    from kernel.services import capture

    bills_ctx = AccessContext.of("bills:read", "bills:write")
    define_bills_types(bills_ctx)
    marker = f"apibillsmix{uuid4().hex[:8]}"
    document_id = uuid4()
    capture(
        bills_ctx,
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
    verify_document(bills_ctx, document_id)
    generate_proposals(bills_ctx, document_ids=[document_id])

    agent_marker = f"apiagentmix{uuid4().hex[:8]}"
    propose(agent_marker)

    listed = client.get("/action-proposals", params={"state": STATE_PROPOSED}).json()
    kinds = {p["kind"] for p in listed}
    assert "dispute_draft" in kinds
    assert "test.brain-kind" in kinds
