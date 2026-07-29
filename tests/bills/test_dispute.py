"""Integration + unit: approval-gated dispute drafts (ADR 018, C4).

Nothing in this file sends anything, and nothing it exercises could: there is
no transport in the module under test, so there is no fake client to inject.
The gate is tested by refusing it — without an authority receipt, with one
granted for a different proposal, with an expired one, and with one whose draft
changed underneath it.

Tests share the session database, so every test uses its own document id and
every candidate carries a test-unique marker. Every bill here is invented; no
real medical document and no real PHI exists in this repo.
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import jsonschema
import pytest

from domains.bills import dispute, extract
from domains.bills.dispute import (
    UNAVAILABLE,
    ApprovalRefused,
    AuthorityRefused,
    DraftChanged,
    ProposalReport,
    ProposalStateError,
    ProposalView,
    approve_proposal,
    digest_of,
    emit_draft,
    generate_proposals,
    list_proposals,
    proposal_key,
    proposal_view,
    reject_proposal,
    render_draft,
)
from domains.bills.types import (
    ACT_DISPLAY_DRAFT,
    AUTHORITY_RECEIPT_SCHEMA,
    BILL_SCHEMA,
    CHANNEL_ON_SCREEN,
    CHECK_LINE_ITEMS_SUM,
    GRANT_VIA_OWNER_SESSION,
    KIND_DISPUTE_DRAFT,
    STATE_APPROVED,
    STATE_PROPOSED,
    STATE_REJECTED,
    STATE_WITHDRAWN,
    STATUS_CANDIDATE,
    TYPE_AUTHORITY,
    TYPE_BILL,
    TYPE_EOB,
    TYPE_PROPOSAL,
    TYPE_VERIFICATION,
    define_bills_types,
)
from domains.bills.verify import PromotionRefused, forget_bill, guard_capture, verify_document
from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.services import capture, find, get_entity

APPROVER = "test-owner-0001"


@pytest.fixture(scope="module")
def dispute_ctx() -> AccessContext:
    """What proposing actually needs: this domain and nothing else. No
    `documents:read`, no person spine, no calendar (ADR 018, invariant 8)."""
    return AccessContext.of("bills:read", "bills:write")


@pytest.fixture(scope="module")
def owner_ctx() -> AccessContext:
    """The owner's own unrestricted session — the only thing that may APPROVE.

    Deliberately separate from `dispute_ctx`: everything except the approval
    runs under the narrow set, which is the point of the split. A context that
    enumerates its own scopes is the shape a token takes, and a token may not
    mint the artifact that claims a human said yes (ADR 018).
    """
    return AccessContext.all()


def approve(ctx: AccessContext, view: ProposalView, digest: str | None = None) -> Any:
    assert view.draft_digest is not None
    return approve_proposal(
        ctx, view.proposal_id, digest or view.draft_digest, APPROVER, GRANT_VIA_OWNER_SESSION
    )


@pytest.fixture(scope="module", autouse=True)
def _types(dispute_ctx: AccessContext) -> None:
    define_bills_types(dispute_ctx)


# --- building the C3 state a proposal rests on ------------------------------


def bill_record(**overrides: Any) -> dict[str, Any]:
    """A medical bill whose one line item comes to 128.40."""
    record: dict[str, Any] = {
        "category": "medical",
        "issuer": "Mercy Clinic",
        "account_ref": "ACCT-1",
        "service_date": "2026-03-04",
        "due_date": "2026-04-01",
        "currency": "USD",
        "total": "128.40",
        "line_items": [{"code": "99213", "quantity": "1", "amount": "128.40"}],
        "confidence": 0.8,
        "low_confidence_fields": [],
    }
    return {**record, **overrides}


def eob_record(**overrides: Any) -> dict[str, Any]:
    """A clean EOB: the split is complete and the patient owes 30.00."""
    record: dict[str, Any] = {
        "payer": "Blue Shield",
        "claim_no": "CLM-1",
        "service_date": "2026-03-04",
        "currency": "USD",
        "line_items": [
            {
                "code": "99213",
                "quantity": "1",
                "billed": "200.00",
                "allowed": "150.00",
                "plan_paid": "120.00",
                "patient_resp": "30.00",
            }
        ],
        "confidence": 0.8,
        "low_confidence_fields": [],
    }
    return {**record, **overrides}


def candidate(
    ctx: AccessContext, document_id: UUID, type_name: str, record: dict[str, Any]
) -> UUID:
    """Capture one candidate exactly as C2 would, citing `document_id`."""
    provenance = {
        "source_entity_ids": [str(document_id)],
        "source_event_ids": [],
        "method": "llm_extraction",
        "confidence": 0.8,
    }
    now = datetime.now(UTC).isoformat()
    sha = f"{document_id.int:064x}"
    build = extract._bill_attributes if type_name == TYPE_BILL else extract._eob_attributes  # noqa: SLF001
    return capture(ctx, type_name, build(record, sha, provenance, now)).entity_id


def failing_document(ctx: AccessContext, marker: str, **overrides: Any) -> tuple[UUID, UUID]:
    """One document whose single bill does not add up. Returns (document, bill)."""
    document_id = uuid4()
    bill_id = candidate(
        ctx,
        document_id,
        TYPE_BILL,
        bill_record(issuer=f"Mercy {marker}", account_ref=f"ACCT-{marker}", **overrides),
    )
    verify_document(ctx, document_id)
    return document_id, bill_id


def only(rows: list[Any]) -> Any:
    assert len(rows) == 1, rows
    return rows[0]


def sole_proposal(ctx: AccessContext, document_id: UUID) -> ProposalView:
    receipt = only(
        find(ctx, type_name=TYPE_VERIFICATION, filters={"verification_key": str(document_id)})
    )
    key = proposal_key(receipt.id, KIND_DISPUTE_DRAFT)
    return proposal_view(
        ctx, only(find(ctx, type_name=TYPE_PROPOSAL, filters={"proposal_key": key}))
    )


def proposal_attributes(ctx: AccessContext, proposal_id: UUID) -> dict[str, Any]:
    return get_entity(ctx, proposal_id).entity.attributes


def authorities_for(ctx: AccessContext, proposal_id: UUID) -> list[Any]:
    return find(ctx, type_name=TYPE_AUTHORITY, filters={"proposal_id": str(proposal_id)})


def a_grant(**overrides: Any) -> dict[str, Any]:
    """The only shape an authority receipt has."""
    grant: dict[str, Any] = {
        "proposal_id": str(uuid4()),
        "verification_receipt_id": str(uuid4()),
        "subject_ids": [],
        "granted_by": APPROVER,
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
    }
    return {**grant, **overrides}


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def events_mentioning(needle: str) -> int:
    with db.connect() as conn:
        row = conn.execute(
            "select count(*) as n from event where payload::text like %s", (f"%{needle}%",)
        ).fetchone()
        assert row is not None
        return int(row["n"])


# --- proposing --------------------------------------------------------------


def test_a_failed_verification_proposes_a_draft_that_says_it_was_not_sent(
    dispute_ctx: AccessContext,
) -> None:
    document_id, bill_id = failing_document(dispute_ctx, "c4basic", total="140.00")

    report = generate_proposals(dispute_ctx, document_ids=[document_id])

    assert report.proposed == 1
    view = sole_proposal(dispute_ctx, document_id)
    assert view.state == STATE_PROPOSED
    assert view.subject_ids == [bill_id]
    assert [p["check"] for p in view.points] == [CHECK_LINE_ITEMS_SUM]
    assert "DRAFT - NOT SENT" in view.body
    assert "cannot send it" in view.body
    # The numbers are rendered from the candidate, which is the whole point of
    # not storing the letter: the draft is useful and none of it is stored.
    assert "add up to 128.40" in view.body
    assert "asked for is 140.00" in view.body
    assert "Mercy c4basic" in view.body
    # and the route's own listing is the same view
    assert view.proposal_id in {v.proposal_id for v in list_proposals(dispute_ctx, STATE_PROPOSED)}


def test_a_verification_that_passed_proposes_nothing(dispute_ctx: AccessContext) -> None:
    document_id = uuid4()
    candidate(dispute_ctx, document_id, TYPE_BILL, bill_record(account_ref="ACCT-c4clean"))
    verify_document(dispute_ctx, document_id)

    report = generate_proposals(dispute_ctx, document_ids=[document_id])

    assert (report.receipts, report.proposed) == (1, 0)
    assert (
        find(dispute_ctx, type_name=TYPE_PROPOSAL, filters={"document_id": str(document_id)}) == []
    )


def test_a_check_that_could_not_run_is_never_quoted_at_a_third_party(
    dispute_ctx: AccessContext,
) -> None:
    """The C3 finding pointed outward. A bill with no total fails verification
    as `unchecked`, which means "my records could not read this" — presenting
    that to a provider as an error would be an accusation nobody can back. No
    proposal is made, and the run SAYS so rather than falling silent."""
    document_id = uuid4()
    record = bill_record(account_ref="ACCT-c4unchecked")
    record["total"] = ""  # dropped by the extractor's coercion: absent, not zero
    candidate(dispute_ctx, document_id, TYPE_BILL, record)
    verify_document(dispute_ctx, document_id)

    report = generate_proposals(dispute_ctx, document_ids=[document_id])

    assert (report.proposed, report.undisputable) == (0, 1)
    assert "undisputable=1" in report.line()


def test_the_draft_names_how_many_checks_it_is_not_stating(dispute_ctx: AccessContext) -> None:
    """A disputable failure beside a check that is about our own uncertainty:
    the letter states the first and admits to the second rather than presenting
    both as proven."""
    document_id = uuid4()
    candidate(
        dispute_ctx,
        document_id,
        TYPE_BILL,
        bill_record(
            account_ref="ACCT-c4mixed",
            total="140.00",
            low_confidence_fields=["total"],  # fails, but it is OUR uncertainty
        ),
    )
    verify_document(dispute_ctx, document_id)

    generate_proposals(dispute_ctx, document_ids=[document_id])

    view = sole_proposal(dispute_ctx, document_id)
    assert view.unresolved_count == 1
    assert [p["check"] for p in view.points] == [CHECK_LINE_ITEMS_SUM]
    assert "A further 1 check(s)" in view.body
    assert "than an error on your part" in view.body


def test_the_proposal_stores_no_word_of_the_draft(dispute_ctx: AccessContext) -> None:
    """The storage decision, asserted. `entity.search` is a tsvector over
    `attributes::text` and `forget()` is per-entity, so a letter naming the
    provider and the amounts in an attribute would be full-text searchable and
    erasable only by erasing the proposal itself (ADR 015/016). It is rendered
    on demand instead: the record holds ids, check names and counts."""
    marker = "c4nostoredtext"
    document_id, _ = failing_document(dispute_ctx, marker, total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    stored = json.dumps(proposal_attributes(dispute_ctx, view.proposal_id))

    assert marker not in stored
    assert "128.40" not in stored and "140.00" not in stored
    assert marker in view.body  # and the draft is not impoverished by that
    assert view.proposal_id not in {e.id for e in find(dispute_ctx, text=marker)}


def test_a_rerun_over_unchanged_records_emits_nothing(dispute_ctx: AccessContext) -> None:
    document_id, _ = failing_document(dispute_ctx, "c4rerun", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])

    before = event_count()
    generate_proposals(dispute_ctx, document_ids=[document_id])

    assert event_count() == before


def test_a_proposal_is_withdrawn_when_its_basis_stops_failing(
    dispute_ctx: AccessContext,
) -> None:
    """The ADR 017 layer-3 analogue: nothing stays proposed on the strength of
    an old ruling."""
    document_id, bill_id = failing_document(dispute_ctx, "c4withdraw", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    stored = get_entity(dispute_ctx, bill_id).entity.attributes
    capture(dispute_ctx, TYPE_BILL, {**stored, "total": 128.40})  # the bill now adds up
    verify_document(dispute_ctx, document_id)
    report = generate_proposals(dispute_ctx, document_ids=[document_id])

    assert report.withdrawn == 1
    assert proposal_attributes(dispute_ctx, view.proposal_id)["state"] == STATE_WITHDRAWN


def test_a_receipt_whose_verdicts_were_erased_is_reported_not_passed_over(
    dispute_ctx: AccessContext,
) -> None:
    """`verification_receipt.checks` is `x-pii`. Once erased, WHY a document
    failed is no longer knowable, so no draft can honestly be built from it —
    and silence would be indistinguishable from "nothing to dispute"."""
    document_id, bill_id = failing_document(dispute_ctx, "c4erasedchecks", total="140.00")
    forget_bill(dispute_ctx, bill_id)  # takes the receipt's checks with it

    report = generate_proposals(dispute_ctx, document_ids=[document_id])

    assert (report.unreadable, report.proposed) == (1, 0)
    assert "unreadable=1" in report.line()


def test_a_bill_and_eob_disagreement_is_stated_once_from_the_bills_side(
    dispute_ctx: AccessContext,
) -> None:
    """The cross-check verdict lands on both records (ADR 017); the letter says
    it once, and does not then claim a further unstated check on top of it."""
    document_id = uuid4()
    candidate(dispute_ctx, document_id, TYPE_BILL, bill_record(account_ref="ACCT-c4cross"))
    candidate(dispute_ctx, document_id, TYPE_EOB, eob_record(claim_no="CLM-c4cross"))
    verify_document(dispute_ctx, document_id)

    generate_proposals(dispute_ctx, document_ids=[document_id])

    view = sole_proposal(dispute_ctx, document_id)
    assert view.body.count("explanation of benefits") == 1
    assert "puts my share at 30.00" in view.body
    assert "asks for 128.40" in view.body
    assert view.unresolved_count == 0


# --- approval: explicit, bound to what was read, and unforgeable ------------


def test_approval_mints_an_authority_receipt_naming_what_was_approved(
    dispute_ctx: AccessContext,
    owner_ctx: AccessContext,
) -> None:
    document_id, bill_id = failing_document(dispute_ctx, "c4approve", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    decision = approve(owner_ctx, view)

    assert decision.state == STATE_APPROVED
    assert decision.authority_receipt_id is not None
    authority = get_entity(dispute_ctx, decision.authority_receipt_id).entity.attributes
    assert authority["proposal_id"] == str(view.proposal_id)
    assert authority["granted_by"] == APPROVER
    assert authority["subject_ids"] == [str(bill_id)]
    assert authority["draft_digest"] == view.draft_digest
    # The whole grant, and it is deliberately tiny.
    assert authority["permits"] == [ACT_DISPLAY_DRAFT]
    assert authority["channel"] == CHANNEL_ON_SCREEN
    assert proposal_attributes(dispute_ctx, view.proposal_id)["authority_receipt_id"] == str(
        decision.authority_receipt_id
    )


def test_approving_text_nobody_read_is_refused_and_mints_nothing(
    dispute_ctx: AccessContext,
    owner_ctx: AccessContext,
) -> None:
    """An approval binds to one exact draft. A digest that is not this draft's
    means the approver read something else — or nothing at all."""
    document_id, _ = failing_document(dispute_ctx, "c4staledigest", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    before = event_count()
    with pytest.raises(DraftChanged):
        approve(owner_ctx, view, digest="0" * 64)

    assert event_count() == before
    assert authorities_for(dispute_ctx, view.proposal_id) == []
    assert proposal_attributes(dispute_ctx, view.proposal_id)["state"] == STATE_PROPOSED


def test_the_draft_moving_under_an_approver_is_refused_rather_than_approved(
    dispute_ctx: AccessContext,
    owner_ctx: AccessContext,
) -> None:
    """Read the draft, then the numbers change, then approve: the digest no
    longer matches and the approval does not happen."""
    document_id, bill_id = failing_document(dispute_ctx, "c4moved", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    stored = get_entity(dispute_ctx, bill_id).entity.attributes
    capture(dispute_ctx, TYPE_BILL, {**stored, "total": 999.99})

    with pytest.raises(DraftChanged):
        approve(owner_ctx, view)
    assert authorities_for(dispute_ctx, view.proposal_id) == []


def test_write_scope_is_checked_before_any_authority_is_minted(
    dispute_ctx: AccessContext,
) -> None:
    """Minting authority is the consequential write in this path, so a
    read-only credential is refused before it, not by a later capture (C1)."""
    document_id, _ = failing_document(dispute_ctx, "c4scope", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)
    read_only = AccessContext.of("bills:read")

    with pytest.raises(ScopeError):
        approve(read_only, view)
    with pytest.raises(ScopeError):
        reject_proposal(read_only, view.proposal_id)
    with pytest.raises(ScopeError):
        generate_proposals(read_only, document_ids=[document_id])

    assert authorities_for(dispute_ctx, view.proposal_id) == []


def test_rejecting_mints_nothing_and_a_decided_proposal_is_not_reopened(
    dispute_ctx: AccessContext,
    owner_ctx: AccessContext,
) -> None:
    document_id, _ = failing_document(dispute_ctx, "c4reject", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    assert reject_proposal(dispute_ctx, view.proposal_id).state == STATE_REJECTED
    assert authorities_for(dispute_ctx, view.proposal_id) == []

    # a re-run holds it: a human said no, and a job does not overrule that
    report = generate_proposals(dispute_ctx, document_ids=[document_id])
    assert report.held == 1
    assert proposal_attributes(dispute_ctx, view.proposal_id)["state"] == STATE_REJECTED
    with pytest.raises(ProposalStateError):
        approve(owner_ctx, view)


def test_a_scope_narrowed_context_may_not_mint_authority(
    dispute_ctx: AccessContext,
) -> None:
    """An authority receipt is the system's only artifact distinguishing a human
    decision from an automated one, so holding `bills:write` is necessary and
    deliberately not sufficient.

    `api.auth._context_from` narrows on a `scopes` claim — by its own docstring
    "the same path future agent tokens take" — so a context that enumerates its
    own scopes is the shape a credential takes, and a credential is not a
    person. The owner's own session is unrestricted, and only that may approve.
    """
    document_id, _ = failing_document(dispute_ctx, "c4scopedtoken", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    # holds every scope this domain has, and is still refused
    with pytest.raises(ApprovalRefused):
        approve(dispute_ctx, view)

    assert authorities_for(dispute_ctx, view.proposal_id) == []
    assert proposal_attributes(dispute_ctx, view.proposal_id)["state"] == STATE_PROPOSED


def test_the_receipt_records_how_the_approving_principal_was_established(
    dispute_ctx: AccessContext, owner_ctx: AccessContext
) -> None:
    """ "The environment said so" is a weaker claim than "a verified session said
    so", and the record must not blur them."""
    document_id, _ = failing_document(dispute_ctx, "c4via", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    decision = approve(owner_ctx, view)

    assert decision.authority_receipt_id is not None
    authority = get_entity(dispute_ctx, decision.authority_receipt_id).entity.attributes
    assert authority["granted_via"] == GRANT_VIA_OWNER_SESSION
    assert authority["granted_by"] == APPROVER


def test_an_unbounded_principal_is_refused(
    dispute_ctx: AccessContext, owner_ctx: AccessContext
) -> None:
    """The domain does not trust the interface to have bounded what it passes."""
    document_id, _ = failing_document(dispute_ctx, "c4principal", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)
    assert view.draft_digest is not None

    with pytest.raises(ValueError):
        approve_proposal(
            owner_ctx,
            view.proposal_id,
            view.draft_digest,
            "not a principal; <script>",
            GRANT_VIA_OWNER_SESSION,
        )
    with pytest.raises(ValueError):
        approve_proposal(owner_ctx, view.proposal_id, view.draft_digest, APPROVER, "invented_via")
    assert authorities_for(dispute_ctx, view.proposal_id) == []


def test_neither_a_proposal_nor_an_authority_is_writable_through_capture(
    dispute_ctx: AccessContext,
) -> None:
    """An approval artifact is evidence, exactly like a verification receipt: a
    caller who could author one could authorise themselves (ADR 017/018)."""
    with pytest.raises(PromotionRefused):
        guard_capture(dispute_ctx, TYPE_PROPOSAL, {"proposal_key": "a" * 64})
    with pytest.raises(PromotionRefused):
        guard_capture(dispute_ctx, TYPE_AUTHORITY, {"proposal_id": str(uuid4())})
    # and the identity-key rule covers the merge route a type-name check misses
    with pytest.raises(PromotionRefused):
        guard_capture(dispute_ctx, TYPE_BILL, {"proposal_key": "a" * 64})


# --- the gate ---------------------------------------------------------------


def test_the_send_step_without_an_authority_receipt_is_refused_and_records_nothing(
    dispute_ctx: AccessContext,
) -> None:
    """The heart of the slice. A proposal is not an action: emitting one nobody
    approved must raise, and must leave no trace of having tried."""
    document_id, _ = failing_document(dispute_ctx, "c4ungated", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    before = event_count()
    with pytest.raises(ProposalStateError):
        emit_draft(dispute_ctx, view.proposal_id)

    assert event_count() == before


def test_the_listing_stops_serving_the_draft_the_moment_it_is_decided(
    dispute_ctx: AccessContext, owner_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The gate must not have an ungated twin.

    `proposal_view` renders the same bytes `emit_draft` does, and rendering a
    draft is exactly the act the grant permits (`display_draft` / `on_screen`).
    A listing that returned `body` in every state would defeat every row of the
    refusal table from the adjacent route: approve, let the grant lapse, and the
    gate 403s while the listing serves the same text at 200.

    So the draft is in the listing only while the proposal is `proposed` — the
    state where reading is a prerequisite to deciding — and nothing ever returns
    a proposal to that state.
    """
    document_id, _ = failing_document(dispute_ctx, "c4twin", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    proposed = sole_proposal(dispute_ctx, document_id)
    assert proposed.body is not None and proposed.draft_digest is not None

    monkeypatch.setattr(dispute, "AUTHORITY_TTL", timedelta(seconds=-1))
    approve(owner_ctx, proposed)

    decided = sole_proposal(dispute_ctx, document_id)
    assert decided.state == STATE_APPROVED
    # the grant has lapsed, so the gate refuses...
    with pytest.raises(AuthorityRefused):
        emit_draft(dispute_ctx, decided.proposal_id)
    # ...and the listing does not serve what the gate just withheld
    assert decided.body is None
    assert decided.draft_digest is None
    listed = only([v for v in list_proposals(dispute_ctx) if v.proposal_id == decided.proposal_id])
    assert listed.body is None
    # the metadata a reviewer needs is still there; only the letter is gated
    assert listed.points and listed.authority_receipt_id is not None


def test_a_rejected_proposal_is_never_returned_to_the_readable_state(
    dispute_ctx: AccessContext,
) -> None:
    """The `proposed`-only rule holds because the state is a one-way door: a job
    holds anything a human decided, so a lapsed grant cannot fall back into
    being readable."""
    document_id, _ = failing_document(dispute_ctx, "c4onewaydoor", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)
    reject_proposal(dispute_ctx, view.proposal_id)

    generate_proposals(dispute_ctx, document_ids=[document_id])  # the sweep, again

    after = sole_proposal(dispute_ctx, document_id)
    assert after.state == STATE_REJECTED
    assert after.body is None


def test_a_truncated_receipt_is_reported_rather_than_partially_disputed(
    dispute_ctx: AccessContext,
) -> None:
    """A receipt flagged `checks_truncated` stored only the first slice of its
    verdicts (ADR 017) and promotes nothing. Building a letter from that slice
    would state some discrepancies to a provider and then claim, with a number,
    to have accounted for the rest — an accusation assembled from a knowingly
    partial record. Same silence-as-pass shape as an erased receipt, same
    answer: counted, printed, no proposal."""
    document_id, _ = failing_document(dispute_ctx, "c4truncated", total="140.00")
    receipt = only(
        find(
            dispute_ctx,
            type_name=TYPE_VERIFICATION,
            filters={"verification_key": str(document_id)},
        )
    )
    capture(dispute_ctx, TYPE_VERIFICATION, {**receipt.attributes, "checks_truncated": True})

    report = generate_proposals(dispute_ctx, document_ids=[document_id])

    assert (report.unreadable, report.proposed) == (1, 0)
    assert "unreadable=1" in report.line()
    assert (
        find(dispute_ctx, type_name=TYPE_PROPOSAL, filters={"document_id": str(document_id)}) == []
    )


def test_an_authority_for_a_different_proposal_does_not_authorize_this_one(
    dispute_ctx: AccessContext,
    owner_ctx: AccessContext,
) -> None:
    """A grant names one proposal. Pointing a second proposal at it — which
    in-process code holding `bills:write` can do, since that is inside the trust
    boundary — does not make the grant cover the second one."""
    first_document, _ = failing_document(dispute_ctx, "c4granted", total="140.00")
    second_document, _ = failing_document(dispute_ctx, "c4borrower", total="150.00")
    generate_proposals(dispute_ctx, document_ids=[first_document, second_document])
    granted = sole_proposal(dispute_ctx, first_document)
    borrower = sole_proposal(dispute_ctx, second_document)

    decision = approve(owner_ctx, granted)
    stolen = proposal_attributes(dispute_ctx, borrower.proposal_id)
    before = event_count()
    capture(
        dispute_ctx,
        TYPE_PROPOSAL,
        {
            **stolen,
            "state": STATE_APPROVED,
            "authority_receipt_id": str(decision.authority_receipt_id),
            "decided_at": datetime.now(UTC).isoformat(),
        },
    )
    after_forgery = event_count()

    with pytest.raises(AuthorityRefused):
        emit_draft(dispute_ctx, borrower.proposal_id)

    assert event_count() == after_forgery > before  # the refusal recorded nothing
    # the real grant still works, so the refusal is about the mismatch
    assert emit_draft(dispute_ctx, granted.proposal_id).proposal_id == granted.proposal_id


def test_an_expired_authority_does_not_authorize(
    dispute_ctx: AccessContext, owner_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    document_id, _ = failing_document(dispute_ctx, "c4expired", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)

    monkeypatch.setattr(dispute, "AUTHORITY_TTL", timedelta(seconds=-1))
    approve(owner_ctx, view)

    with pytest.raises(AuthorityRefused):
        emit_draft(dispute_ctx, view.proposal_id)


def test_an_approved_draft_is_emitted_on_screen_and_nowhere_else(
    dispute_ctx: AccessContext,
    owner_ctx: AccessContext,
) -> None:
    document_id, _ = failing_document(dispute_ctx, "c4emitted", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)
    approve(owner_ctx, view)

    emitted = emit_draft(dispute_ctx, view.proposal_id)

    assert emitted.channel == CHANNEL_ON_SCREEN
    assert emitted.permits == [ACT_DISPLAY_DRAFT]
    assert emitted.body == view.body


def test_the_authority_type_cannot_express_a_transmission() -> None:
    """Invariant 8, made structural rather than promised. The grant's `channel`
    and `permits` are one-member enums — the C2 trick that made `"verified"`
    inexpressible — so an authority receipt saying "email this" does not
    validate. Sending would take a schema change, a migration and an ADR."""
    grant = a_grant()
    jsonschema.validate(instance=grant, schema=AUTHORITY_RECEIPT_SCHEMA)  # the only shape there is

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance={**grant, "channel": "email"}, schema=AUTHORITY_RECEIPT_SCHEMA)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(
            instance={**grant, "permits": ["transmit"]}, schema=AUTHORITY_RECEIPT_SCHEMA
        )


def test_a_grant_that_authorises_nothing_is_not_storable() -> None:
    """`permits: []` is a receipt granting nothing, and it used to validate — so
    a reader that only asked "is there an authority receipt" would have treated
    it as one. `minItems: 1` is the write-time half; `emit_draft` checks the
    contents too."""
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance={**a_grant(), "permits": []}, schema=AUTHORITY_RECEIPT_SCHEMA)


def test_the_gate_refuses_a_grant_that_does_not_permit_this_act(
    dispute_ctx: AccessContext, owner_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The gate checks the grant's constraints rather than echoing them.

    That the enums have one member each is a WRITE-time constraint, so this
    moves the read-time expectation instead — which is exactly what happens the
    day `CHANNELS` or `GRANTED_ACTS` gains a member and an older receipt names
    the other one. A gate that trusted the enum would hand the draft out.
    """
    document_id, _ = failing_document(dispute_ctx, "c4permit", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)
    approve(owner_ctx, view)
    assert emit_draft(dispute_ctx, view.proposal_id).body == view.body  # not vacuous

    monkeypatch.setattr(dispute, "ACT_DISPLAY_DRAFT", "some_other_act")
    with pytest.raises(AuthorityRefused):
        emit_draft(dispute_ctx, view.proposal_id)
    monkeypatch.undo()

    monkeypatch.setattr(dispute, "CHANNEL_ON_SCREEN", "some_other_channel")
    with pytest.raises(AuthorityRefused):
        emit_draft(dispute_ctx, view.proposal_id)


# --- the CLI's own receipt --------------------------------------------------


def test_the_execution_receipt_carries_no_count_of_medical_records(
    dispute_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`ops` stays model-readable so the briefing works, which makes it the
    wrong place for "1 disputed medical bill" (the C2/C3 precedent)."""
    monkeypatch.setattr(
        dispute,
        "generate_proposals",
        lambda ctx, document_ids=None: ProposalReport(receipts=2, proposed=1, produced=[uuid4()]),
    )
    result = dispute._job(dispute_ctx, None)  # noqa: SLF001

    assert result.produced == []
    assert not any(character.isdigit() for character in result.summary)
    assert "action_proposal" in result.summary


def test_proposing_never_asks_for_more_scope_than_it_needs() -> None:
    assert dispute.proposal_context().scopes == frozenset(
        {"bills:read", "bills:write", "ops:read", "ops:write"}
    )


# --- unit: rendering and keys -----------------------------------------------


def test_the_draft_is_deterministic_and_carries_no_clock(dispute_ctx: AccessContext) -> None:
    """A body dated "today" would change its own digest overnight and silently
    revoke every approval at midnight."""
    document_id, _ = failing_document(dispute_ctx, "c4stable", total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)
    attributes = proposal_attributes(dispute_ctx, view.proposal_id)

    first = render_draft(dispute_ctx, attributes)
    second = render_draft(dispute_ctx, attributes)

    assert first == second == view.body
    assert digest_of(first) == view.draft_digest
    assert datetime.now(UTC).date().isoformat() not in first


def test_an_absent_value_renders_as_unavailable_rather_than_a_guess() -> None:
    assert dispute._text(None) == UNAVAILABLE  # noqa: SLF001
    assert dispute._amount("not a number") == UNAVAILABLE  # noqa: SLF001
    assert dispute._amount("128.4") == "128.40"  # noqa: SLF001


def test_a_date_is_bounded_by_charset_in_the_type_and_in_the_coercion() -> None:
    """C4 is what turned a date into prose composed verbatim into a letter for a
    third party, so `service_date`/`due_date` are now held to a character class
    as well as a length — in the schema AND in the extractor, this cell's rule.

    The bound turns nothing away that `date.fromisoformat` can emit, so no
    stored record can become invalid; it closes the direct-`POST /capture` door,
    which was the one that was open.
    """
    valid = {
        "bill_key": "a" * 64,
        "status": STATUS_CANDIDATE,
        "category": "medical",
        "extracted_at": datetime.now(UTC).isoformat(),
        "provenance": {
            "source_entity_ids": [],
            "source_event_ids": [],
            "method": "llm_extraction",
            "confidence": 0.5,
        },
    }
    jsonschema.validate(instance={**valid, "service_date": "2026-03-04"}, schema=BILL_SCHEMA)
    jsonschema.validate(instance={**valid, "service_date": "2026-W10-3"}, schema=BILL_SCHEMA)

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(
            instance={**valid, "service_date": "see attached notice"}, schema=BILL_SCHEMA
        )
    # and the coercion agrees, so neither writer can get there alone
    assert extract._date("2026-03-04") == "2026-03-04"  # noqa: SLF001
    assert extract._date("see attached notice") is None  # noqa: SLF001
    assert extract._date("March 4, 2026") is None  # noqa: SLF001


def test_one_proposal_per_receipt_per_kind() -> None:
    receipt = uuid4()
    assert proposal_key(receipt, KIND_DISPUTE_DRAFT) == proposal_key(receipt, KIND_DISPUTE_DRAFT)
    assert proposal_key(receipt, KIND_DISPUTE_DRAFT) != proposal_key(uuid4(), KIND_DISPUTE_DRAFT)


# --- the erasure regression (last: it destroys what earlier tests read) -----

ERASED = "c4erasedsubject"


def test_erasing_a_subject_reaches_the_approved_draft_and_its_authority(
    dispute_ctx: AccessContext,
    owner_ctx: AccessContext,
) -> None:
    """Erasure must reach the derived records (the binding C1/C2/C3 finding).

    Two things happen here. The `draft_digest` is sha256 over a letter that
    quoted this bill's issuer and amounts — guessable content, so the digest is
    a confirmation oracle and it goes with the values it digests. And because
    the draft is RENDERED rather than stored, the letter itself empties by
    construction, so the approval matches nothing and the gate refuses.
    """
    document_id, bill_id = failing_document(dispute_ctx, ERASED, total="140.00")
    generate_proposals(dispute_ctx, document_ids=[document_id])
    view = sole_proposal(dispute_ctx, document_id)
    decision = approve(owner_ctx, view)
    assert ERASED in emit_draft(dispute_ctx, view.proposal_id).body  # not a vacuous test
    assert events_mentioning(view.draft_digest) > 0

    result = forget_bill(dispute_ctx, bill_id)

    assert result.receipts_redacted == 2  # the verification receipt and the authority
    assert decision.authority_receipt_id is not None
    authority = get_entity(dispute_ctx, decision.authority_receipt_id).entity.attributes
    assert "draft_digest" not in authority  # gone from live state...
    assert events_mentioning(view.draft_digest) == 0  # ...and from every event payload
    assert events_mentioning(ERASED) == 0

    # the letter is empty of the erased values, and the grant no longer covers it
    rebuilt = render_draft(dispute_ctx, proposal_attributes(dispute_ctx, view.proposal_id))
    assert ERASED not in rebuilt and UNAVAILABLE in rebuilt
    with pytest.raises(AuthorityRefused):
        emit_draft(dispute_ctx, view.proposal_id)
