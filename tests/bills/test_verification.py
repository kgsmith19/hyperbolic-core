"""Integration + unit: the deterministic reconciliation verifier (ADR 017, C3).

No model is involved anywhere in this file, and none is needed: the whole point
of the slice is that verification is arithmetic. Candidates are captured through
C2's own attribute builders, so the shapes under test are the shapes extraction
actually writes.

Tests share the session database, so every test uses its own document id and
every candidate carries a test-unique marker. Every bill here is invented; no
real medical document and no real PHI exists in this repo.
"""

import json
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import jsonschema
import pytest

from domains.bills import extract, verify
from domains.bills.types import (
    CHECK_BILL_EOB_PATIENT_RESP,
    CHECK_CURRENCY_CONSISTENT,
    CHECK_DATES_COHERENT,
    CHECK_EOB_ALLOWED_WITHIN_BILLED,
    CHECK_EOB_AMOUNTS_NON_NEGATIVE,
    CHECK_EOB_LINE_SPLIT,
    CHECK_LINE_ITEMS_SUM,
    CHECK_NO_DUPLICATE_LINES,
    CHECK_NO_LOW_CONFIDENCE_FIELDS,
    RESULT_FAIL,
    RESULT_PASS,
    RESULT_UNCHECKED,
    STATUS_CANDIDATE,
    STATUS_VERIFIED,
    TYPE_BILL,
    TYPE_EOB,
    TYPE_EXTRACTION,
    TYPE_VERIFICATION,
    define_bills_types,
)
from domains.bills.verify import (
    PromotionRefused,
    Subject,
    VerificationReport,
    forget_bill,
    guard_capture,
    run_verification,
    verify_document,
)
from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.services import capture, define_type, find, forget, get_entity


@pytest.fixture(scope="module")
def verify_ctx() -> AccessContext:
    """What verification actually needs: its own domain and nothing else. No
    `documents:read` — this job never opens the document (ADR 017)."""
    return AccessContext.of("bills:read", "bills:write")


@pytest.fixture(scope="module", autouse=True)
def _types(verify_ctx: AccessContext) -> None:
    define_bills_types(verify_ctx)


# --- building candidates the way extraction does ----------------------------


def bill_record(**overrides: Any) -> dict[str, Any]:
    """A clean, internally consistent medical bill: one line, and a total that
    matches it."""
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
    """A clean EOB: the split is complete and the allowed amount sits under the
    billed one."""
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


def receipt_of(ctx: AccessContext, receipt_id: UUID | None) -> dict[str, Any]:
    assert receipt_id is not None
    return get_entity(ctx, receipt_id).entity.attributes


def checks_for(receipt: dict[str, Any], subject_id: UUID) -> list[dict[str, Any]]:
    return [c for c in receipt["checks"] if c["subject_id"] == str(subject_id)]


def result_of(receipt: dict[str, Any], subject_id: UUID, check: str) -> dict[str, Any]:
    matches = [c for c in checks_for(receipt, subject_id) if c["check"] == check]
    assert len(matches) == 1, matches
    return matches[0]


def results_of(receipt: dict[str, Any], subject_id: UUID, check: str) -> list[dict[str, Any]]:
    return [c for c in checks_for(receipt, subject_id) if c["check"] == check]


def only(entities: list[Any]) -> Any:
    assert len(entities) == 1, entities
    return entities[0]


def status_of(ctx: AccessContext, entity_id: UUID) -> str:
    value = get_entity(ctx, entity_id).entity.attributes["status"]
    assert isinstance(value, str)
    return value


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


# --- promotion --------------------------------------------------------------


def test_a_candidate_that_passes_every_check_is_promoted_and_cites_its_receipt(
    verify_ctx: AccessContext,
) -> None:
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record())

    verdict = verify_document(verify_ctx, document_id)

    assert (verdict.subjects, verdict.verified, verdict.promoted) == (1, 1, 1)
    stored = get_entity(verify_ctx, bill_id).entity.attributes
    assert stored["status"] == STATUS_VERIFIED
    assert stored["verification_receipt_id"] == str(verdict.receipt_id)

    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    assert receipt["passed"] is True
    assert receipt["subject_ids"] == [str(bill_id)]
    assert receipt["verified_ids"] == [str(bill_id)]
    assert {c["result"] for c in receipt["checks"]} == {RESULT_PASS}
    assert receipt["provenance"]["method"] == "deterministic_verification"
    # Deterministic arithmetic over kernel state may claim what an LLM guess
    # never can (ADR 010/017).
    assert receipt["provenance"]["confidence"] == 1.0


def test_promotion_needs_every_check_and_is_decided_per_candidate(
    verify_ctx: AccessContext,
) -> None:
    """One broken candidate does not hold back a clean one, and one broken check
    is enough to hold back the candidate it names."""
    document_id = uuid4()
    clean = candidate(verify_ctx, document_id, TYPE_BILL, bill_record(account_ref="ACCT-CLEAN"))
    broken = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(
            account_ref="ACCT-BROKEN",
            total="140.00",
            line_items=[{"code": "80053", "quantity": "1", "amount": "100.00"}],
        ),
    )

    verdict = verify_document(verify_ctx, document_id)

    assert (verdict.subjects, verdict.verified, verdict.promoted) == (2, 1, 1)
    assert status_of(verify_ctx, clean) == STATUS_VERIFIED
    assert status_of(verify_ctx, broken) == STATUS_CANDIDATE
    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    assert receipt["passed"] is False
    assert receipt["verified_ids"] == [str(clean)]
    # a failing candidate still gets a receipt pointer, naming what ruled on it
    assert get_entity(verify_ctx, broken).entity.attributes["verification_receipt_id"] == str(
        verdict.receipt_id
    )


def test_an_input_the_extractor_never_captured_is_unchecked_not_verified(
    verify_ctx: AccessContext,
) -> None:
    """ "We could not check this" must never read as "this is true"."""
    document_id = uuid4()
    record = bill_record()
    del record["total"]
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, {**record, "total": ""})

    verdict = verify_document(verify_ctx, document_id)

    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    assert result_of(receipt, bill_id, CHECK_LINE_ITEMS_SUM)["result"] == RESULT_UNCHECKED
    assert verdict.promoted == 0
    assert status_of(verify_ctx, bill_id) == STATUS_CANDIDATE


# --- each check, failing on its own -----------------------------------------


def test_line_items_that_do_not_sum_to_the_total_fail_that_check_alone(
    verify_ctx: AccessContext,
) -> None:
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record(total="140.00"))

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    failed = result_of(receipt, bill_id, CHECK_LINE_ITEMS_SUM)
    assert failed["result"] == RESULT_FAIL
    assert failed["delta"] == -11.60  # 128.40 of lines against a stated 140.00
    assert {
        c["result"] for c in checks_for(receipt, bill_id) if c["check"] != CHECK_LINE_ITEMS_SUM
    } == {RESULT_PASS}


def test_an_eob_line_whose_split_is_incomplete_fails_that_line_alone(
    verify_ctx: AccessContext,
) -> None:
    """plan_paid + patient_resp == allowed, per line. The second line is 5.00
    short of its own allowed amount; the first is fine."""
    document_id = uuid4()
    lines = [
        eob_record()["line_items"][0],
        {
            "code": "80053",
            "quantity": "1",
            "billed": "100.00",
            "allowed": "80.00",
            "plan_paid": "60.00",
            "patient_resp": "15.00",
        },
    ]
    eob_id = candidate(verify_ctx, document_id, TYPE_EOB, eob_record(line_items=lines))

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    splits = {c["line_index"]: c for c in results_of(receipt, eob_id, CHECK_EOB_LINE_SPLIT)}
    assert splits[0]["result"] == RESULT_PASS
    assert (splits[1]["result"], splits[1]["delta"]) == (RESULT_FAIL, -5.00)
    assert {c["result"] for c in results_of(receipt, eob_id, CHECK_EOB_ALLOWED_WITHIN_BILLED)} == {
        RESULT_PASS
    }


def test_an_allowed_amount_above_the_billed_one_is_caught(verify_ctx: AccessContext) -> None:
    """The plan cannot allow more than the provider charged; the difference is
    the write-off, and it cannot be negative."""
    document_id = uuid4()
    line = {
        "code": "99213",
        "quantity": "1",
        "billed": "50.00",
        "allowed": "80.00",
        "plan_paid": "60.00",
        "patient_resp": "20.00",
    }
    eob_id = candidate(verify_ctx, document_id, TYPE_EOB, eob_record(line_items=[line]))

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    over = result_of(receipt, eob_id, CHECK_EOB_ALLOWED_WITHIN_BILLED)
    assert (over["result"], over["delta"]) == (RESULT_FAIL, 30.00)
    assert result_of(receipt, eob_id, CHECK_EOB_LINE_SPLIT)["result"] == RESULT_PASS


def test_a_negative_amount_is_caught_without_quoting_it(verify_ctx: AccessContext) -> None:
    document_id = uuid4()
    line = {
        "code": "99213",
        "quantity": "1",
        "billed": "200.00",
        "allowed": "150.00",
        "plan_paid": "170.00",
        "patient_resp": "-20.00",
    }
    eob_id = candidate(verify_ctx, document_id, TYPE_EOB, eob_record(line_items=[line]))

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    negative = result_of(receipt, eob_id, CHECK_EOB_AMOUNTS_NON_NEGATIVE)
    assert (negative["result"], negative["line_index"]) == (RESULT_FAIL, 0)
    # the offending amount is an amount, not a difference, so it is named by
    # position only — the value stays on the candidate, where forget() reaches it
    assert "delta" not in negative


def test_a_service_date_after_the_due_date_is_incoherent(verify_ctx: AccessContext) -> None:
    document_id = uuid4()
    bill_id = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(service_date="2026-05-01", due_date="2026-04-01"),
    )

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    assert result_of(receipt, bill_id, CHECK_DATES_COHERENT)["result"] == RESULT_FAIL


def test_a_date_outside_the_sane_window_is_incoherent(verify_ctx: AccessContext) -> None:
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record(due_date="2099-04-01"))

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    assert result_of(receipt, bill_id, CHECK_DATES_COHERENT)["result"] == RESULT_FAIL


def test_the_same_line_item_captured_twice_in_one_document_is_a_duplicate(
    verify_ctx: AccessContext,
) -> None:
    document_id = uuid4()
    line = {"code": "99213", "quantity": "1", "amount": "128.40"}
    bill_id = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(line_items=[line, dict(line)], total="256.80"),
    )

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    duplicate = result_of(receipt, bill_id, CHECK_NO_DUPLICATE_LINES)
    assert (duplicate["result"], duplicate["line_index"]) == (RESULT_FAIL, 0)
    # the arithmetic still adds up, which is exactly why this check exists
    assert result_of(receipt, bill_id, CHECK_LINE_ITEMS_SUM)["result"] == RESULT_PASS


def test_a_duplicate_is_found_across_two_candidates_from_the_same_document(
    verify_ctx: AccessContext,
) -> None:
    document_id = uuid4()
    line = {"code": "99213", "quantity": "1", "amount": "128.40"}
    first = candidate(
        verify_ctx, document_id, TYPE_BILL, bill_record(account_ref="ACCT-A", line_items=[line])
    )
    second = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(account_ref="ACCT-B", line_items=[dict(line)]),
    )

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    assert result_of(receipt, first, CHECK_NO_DUPLICATE_LINES)["result"] == RESULT_FAIL
    assert result_of(receipt, second, CHECK_NO_DUPLICATE_LINES)["result"] == RESULT_FAIL


def test_two_currencies_in_one_document_fail_both_candidates(
    verify_ctx: AccessContext,
) -> None:
    document_id = uuid4()
    # different service dates, so the bill/EOB cross-check does not fire and
    # currency is provably the only thing failing
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record(currency="USD"))
    eob_id = candidate(
        verify_ctx,
        document_id,
        TYPE_EOB,
        eob_record(currency="EUR", service_date="2026-03-05"),
    )

    receipt = receipt_of(verify_ctx, verify_document(verify_ctx, document_id).receipt_id)

    assert result_of(receipt, bill_id, CHECK_CURRENCY_CONSISTENT)["result"] == RESULT_FAIL
    assert result_of(receipt, eob_id, CHECK_CURRENCY_CONSISTENT)["result"] == RESULT_FAIL
    assert result_of(receipt, bill_id, CHECK_LINE_ITEMS_SUM)["result"] == RESULT_PASS
    # the pair never met, and that is recorded rather than passed over
    assert result_of(receipt, bill_id, CHECK_BILL_EOB_PATIENT_RESP)["result"] == RESULT_UNCHECKED


def test_a_low_confidence_field_is_surfaced_rather_than_trusted(
    verify_ctx: AccessContext,
) -> None:
    document_id = uuid4()
    bill_id = candidate(
        verify_ctx, document_id, TYPE_BILL, bill_record(low_confidence_fields=["total"])
    )

    verdict = verify_document(verify_ctx, document_id)

    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    flagged = result_of(receipt, bill_id, CHECK_NO_LOW_CONFIDENCE_FIELDS)
    assert (flagged["result"], flagged["fields"]) == (RESULT_FAIL, ["total"])
    assert verdict.promoted == 0  # arithmetic that adds up is not enough


def test_a_bill_and_its_eob_must_agree_on_what_the_patient_owes(
    verify_ctx: AccessContext,
) -> None:
    """The plan's own arithmetic decides what is owed; the provider's bill must
    not ask for more. A disagreement blocks BOTH records."""
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record())  # total 128.40
    eob_id = candidate(verify_ctx, document_id, TYPE_EOB, eob_record())  # patient owes 30.00

    verdict = verify_document(verify_ctx, document_id)

    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    bill_side = result_of(receipt, bill_id, CHECK_BILL_EOB_PATIENT_RESP)
    eob_side = result_of(receipt, eob_id, CHECK_BILL_EOB_PATIENT_RESP)
    assert (bill_side["result"], eob_side["result"]) == (RESULT_FAIL, RESULT_FAIL)
    assert bill_side["delta"] == eob_side["delta"] == -98.40
    assert verdict.verified == 0


def test_a_bill_with_no_service_date_beside_an_eob_is_unchecked_not_silent(
    verify_ctx: AccessContext,
) -> None:
    """The cross-check used to emit nothing when it could not pair the records,
    and `verdicts` promotes on "every check naming it passed" — so a bill
    claiming 5000.00 and an EOB saying the patient owes 30.00 both sailed
    through on internal self-consistency. A page printing "March 4, 2026"
    induces this on its own: `extract._date` drops what ISO parsing refuses."""
    document_id = uuid4()
    bill_id = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(
            service_date="March 4, 2026",  # dropped by the extractor's coercion
            total="5000.00",
            line_items=[{"code": "99213", "quantity": "1", "amount": "5000.00"}],
        ),
    )
    eob_id = candidate(verify_ctx, document_id, TYPE_EOB, eob_record())

    verdict = verify_document(verify_ctx, document_id)

    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    assert result_of(receipt, bill_id, CHECK_BILL_EOB_PATIENT_RESP)["result"] == RESULT_UNCHECKED
    assert result_of(receipt, eob_id, CHECK_BILL_EOB_PATIENT_RESP)["result"] == RESULT_UNCHECKED
    assert (verdict.verified, verdict.promoted) == (0, 0)
    assert status_of(verify_ctx, bill_id) == STATUS_CANDIDATE
    assert status_of(verify_ctx, eob_id) == STATUS_CANDIDATE


def test_a_bill_and_eob_one_day_apart_are_both_unchecked(verify_ctx: AccessContext) -> None:
    """The same hole reached by perturbing a date instead of losing one."""
    document_id = uuid4()
    bill_id = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(total="30.00", line_items=[{"code": "99213", "amount": "30.00"}]),
    )
    eob_id = candidate(verify_ctx, document_id, TYPE_EOB, eob_record(service_date="2026-03-05"))

    verdict = verify_document(verify_ctx, document_id)

    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    assert result_of(receipt, bill_id, CHECK_BILL_EOB_PATIENT_RESP)["result"] == RESULT_UNCHECKED
    assert result_of(receipt, eob_id, CHECK_BILL_EOB_PATIENT_RESP)["result"] == RESULT_UNCHECKED
    assert verdict.verified == 0


def test_a_document_of_bills_alone_gets_no_cross_check(verify_ctx: AccessContext) -> None:
    """An absent counterpart is only a question when the document has one to
    absent: a bill with no EOB anywhere is the normal case, not a discrepancy."""
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record())

    verdict = verify_document(verify_ctx, document_id)

    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    assert results_of(receipt, bill_id, CHECK_BILL_EOB_PATIENT_RESP) == []
    assert verdict.promoted == 1


def test_a_bill_and_eob_that_agree_are_both_promoted(verify_ctx: AccessContext) -> None:
    document_id = uuid4()
    bill_id = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(total="30.00", line_items=[{"code": "99213", "amount": "30.00"}]),
    )
    eob_id = candidate(verify_ctx, document_id, TYPE_EOB, eob_record())

    verdict = verify_document(verify_ctx, document_id)

    assert verdict.verified == 2
    assert status_of(verify_ctx, bill_id) == STATUS_VERIFIED
    assert status_of(verify_ctx, eob_id) == STATUS_VERIFIED


# --- promotion cannot be taken, only granted --------------------------------


def test_the_type_refuses_a_verified_status_that_cites_no_receipt(
    verify_ctx: AccessContext,
) -> None:
    """The type-system half of the guard: `"verified"` is never a one-word edit,
    because the schema binds it to the receipt that granted it."""
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record())
    stored = get_entity(verify_ctx, bill_id).entity.attributes

    with pytest.raises(jsonschema.ValidationError):
        capture(verify_ctx, TYPE_BILL, {**stored, "status": STATUS_VERIFIED})


def test_a_direct_capture_cannot_promote_a_candidate(verify_ctx: AccessContext) -> None:
    """The route half: `POST /capture` reaches the same types the verifier
    writes, so the domain refuses a hand-written promotion even when it invents
    a receipt id to satisfy the schema."""
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record())
    stored = get_entity(verify_ctx, bill_id).entity.attributes

    with pytest.raises(PromotionRefused):
        guard_capture(
            verify_ctx,
            TYPE_BILL,
            {**stored, "status": STATUS_VERIFIED, "verification_receipt_id": str(uuid4())},
        )


def test_a_direct_capture_cannot_edit_a_verified_record(verify_ctx: AccessContext) -> None:
    """`capture` merges, so an edit that mentions no status would otherwise
    change the numbers under a verified record and leave it verified."""
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record())
    verify_document(verify_ctx, document_id)
    stored = get_entity(verify_ctx, bill_id).entity.attributes
    assert stored["status"] == STATUS_VERIFIED

    with pytest.raises(PromotionRefused):
        guard_capture(verify_ctx, TYPE_BILL, {**stored, "total": 9.99})

    # an ordinary candidate is untouched by the guard
    guard_capture(verify_ctx, TYPE_BILL, bill_record(total=1.0) | {"bill_key": "f" * 64})


ROGUE_TYPE = "rogue_bill_alias"
ROGUE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "bill_key": {"type": "string"},
        "status": {"type": "string"},
        "note": {"type": "string"},
    },
    "required": ["bill_key"],
    "additionalProperties": False,
    # The whole attack: entity resolution matches on the identity field NAME
    # across every type declaring it, so this reaches real bills.
    "x-identity": ["bill_key"],
}


@pytest.fixture(scope="module")
def rogue_type(verify_ctx: AccessContext) -> str:
    define_type(verify_ctx, ROGUE_TYPE, "bills", ROGUE_SCHEMA)
    return ROGUE_TYPE


def test_a_foreign_type_carrying_a_bill_key_is_refused(
    verify_ctx: AccessContext, rogue_type: str
) -> None:
    """The bypass a type-name-keyed guard could not see. `capture` validates the
    INCOMING payload against the INCOMING type and then merges into whatever the
    resolver matched, so a type declaring `x-identity: ["bill_key"]` could write
    `verified` onto a real bill without ever meeting BILL_SCHEMA's
    cites-its-receipt rule. Resolution can only reach a record through an
    identity field that record's own type declares, so carrying the key at all
    is what the guard refuses."""
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record())
    key = get_entity(verify_ctx, bill_id).entity.attributes["bill_key"]

    with pytest.raises(PromotionRefused):
        guard_capture(verify_ctx, rogue_type, {"bill_key": key, "status": STATUS_VERIFIED})
    # and without the status too: the merge is the problem, not the word
    with pytest.raises(PromotionRefused):
        guard_capture(verify_ctx, rogue_type, {"bill_key": key, "note": "hello"})
    assert status_of(verify_ctx, bill_id) == STATUS_CANDIDATE


def test_a_direct_capture_cannot_forge_the_evidence_a_promotion_rests_on(
    verify_ctx: AccessContext,
) -> None:
    """A receipt is what "verified" points at, and what C4 is documented to
    read. Every one of its required fields is caller-suppliable, so a direct
    capture keyed on the document id could flip `passed` to true with no failing
    checks. The verifier writes it in-process; the route may not write it at
    all. Same for the record of a document's text leaving the box."""
    document_id = uuid4()
    candidate(verify_ctx, document_id, TYPE_BILL, bill_record(total="140.00"))
    verify_document(verify_ctx, document_id)

    with pytest.raises(PromotionRefused):
        guard_capture(
            verify_ctx,
            TYPE_VERIFICATION,
            {"verification_key": str(document_id), "passed": True},
        )
    with pytest.raises(PromotionRefused):
        guard_capture(verify_ctx, TYPE_EXTRACTION, {"extraction_key": str(document_id)})
    # the real ruling is untouched
    assert (
        only(
            find(
                verify_ctx,
                type_name=TYPE_VERIFICATION,
                filters={"verification_key": str(document_id)},
            )
        ).attributes["passed"]
        is False
    )


def test_a_record_that_no_longer_validates_is_surfaced_not_skipped(
    verify_ctx: AccessContext, rogue_type: str
) -> None:
    """Bypassing the guard in-process to make the state it would have created:
    a bill carrying a foreign field. `_apply_status` then cannot re-validate it,
    and a bare `except Exception` would have counted that as a generic error and
    moved on — leaving whatever status the record is wearing standing forever.
    It gets its own counter, its own line in the report, and a non-zero exit."""
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record(total="140.00"))
    key = get_entity(verify_ctx, bill_id).entity.attributes["bill_key"]
    capture(verify_ctx, rogue_type, {"bill_key": key, "note": "merged in"})

    report = run_verification(verify_ctx, document_ids=[document_id])

    assert report.invalid == 1
    assert report.ok is False  # the run does not exit 0 on a record it cannot rule on
    assert "invalid=1" in report.line()


def test_a_record_that_stops_passing_is_demoted(verify_ctx: AccessContext) -> None:
    """The backstop behind both guards: nothing stays verified on the strength
    of an old ruling. In-process code holding `bills:write` can still write to a
    verified record; the next run re-judges it and takes the status away."""
    document_id = uuid4()
    bill_id = candidate(verify_ctx, document_id, TYPE_BILL, bill_record())
    verify_document(verify_ctx, document_id)
    stored = get_entity(verify_ctx, bill_id).entity.attributes
    capture(verify_ctx, TYPE_BILL, {**stored, "total": 999.99})
    assert status_of(verify_ctx, bill_id) == STATUS_VERIFIED  # the merge kept it

    verdict = verify_document(verify_ctx, document_id)

    assert (verdict.verified, verdict.demoted) == (0, 1)
    assert status_of(verify_ctx, bill_id) == STATUS_CANDIDATE


def test_write_scope_is_checked_before_anything_is_judged(verify_ctx: AccessContext) -> None:
    """Promotion is the moment a guess becomes something the system may act on,
    so a read-only credential is refused before the run, not by a later capture
    (the C1 precedent)."""
    document_id = uuid4()
    candidate(verify_ctx, document_id, TYPE_BILL, bill_record())

    with pytest.raises(ScopeError):
        verify_document(AccessContext.of("bills:read"), document_id)

    assert (
        find(
            verify_ctx,
            type_name=TYPE_VERIFICATION,
            filters={"verification_key": str(document_id)},
        )
        == []
    )


# --- receipts say what happened, and nothing about the patient --------------


def test_a_receipt_carries_ids_and_differences_but_no_value_from_the_document(
    verify_ctx: AccessContext,
) -> None:
    marker = "billsc3receiptphi"
    document_id = uuid4()
    bill_id = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(issuer=f"Mercy {marker}", account_ref=f"ACCT-{marker}", total="140.00"),
    )

    verdict = verify_document(verify_ctx, document_id)

    receipt = receipt_of(verify_ctx, verdict.receipt_id)
    assert marker not in json.dumps(receipt)
    # the only numbers on the record are differences: never the 140.00 it
    # stated, never the 128.40 its lines came to
    assert {c["delta"] for c in receipt["checks"] if "delta" in c} == {-11.60}
    assert result_of(receipt, bill_id, CHECK_LINE_ITEMS_SUM)["delta"] == -11.60
    assert verdict.receipt_id not in {e.id for e in find(verify_ctx, text=marker)}


def test_the_verifier_reruns_without_emitting_anything_new(verify_ctx: AccessContext) -> None:
    """Determinism, asserted the way the other jobs assert it: same inputs, same
    ruling, zero events."""
    document_id = uuid4()
    candidate(verify_ctx, document_id, TYPE_BILL, bill_record())
    verify_document(verify_ctx, document_id)

    before = event_count()
    verify_document(verify_ctx, document_id)
    assert event_count() == before


def test_the_execution_receipt_carries_no_count_of_medical_records(
    verify_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`ops` stays model-readable so the briefing works, which makes it the
    wrong place for "2 verified medical bills" (the C2 precedent)."""
    monkeypatch.setattr(
        verify,
        "run_verification",
        lambda ctx, document_ids=None: VerificationReport(
            documents=2, subjects=3, verified=2, promoted=2, produced=[uuid4()]
        ),
    )
    result = verify._job(verify_ctx, None)  # noqa: SLF001

    assert result.produced == []
    assert not any(character.isdigit() for character in result.summary)
    assert "verification_receipt" in result.summary


def test_the_sweep_covers_every_document_that_has_candidates(
    verify_ctx: AccessContext,
) -> None:
    document_id = uuid4()
    candidate(verify_ctx, document_id, TYPE_BILL, bill_record())
    assert document_id in verify._documents_with_candidates(verify_ctx)  # noqa: SLF001


def test_verification_never_asks_for_more_scope_than_it_needs() -> None:
    assert verify.verification_context().scopes == frozenset(
        {"bills:read", "bills:write", "ops:read", "ops:write"}
    )


def test_report_line_carries_counts_and_nothing_else() -> None:
    line = VerificationReport(documents=2, subjects=3, verified=1, demoted=1).line()
    assert "documents=2" in line and "verified=1" in line and "demoted=1" in line


# --- unit: money, tolerance, and the promotion rule -------------------------


def test_money_is_compared_as_decimal_not_as_a_float() -> None:
    """0.1 + 0.2 != 0.3 in binary, and a reconciliation check that is wrong by a
    machine epsilon reports noise."""
    tenth = verify._money(0.1)  # noqa: SLF001
    fifth = verify._money(0.2)  # noqa: SLF001
    assert tenth is not None and fifth is not None
    assert tenth + fifth == verify._money(0.3) == Decimal("0.30")  # noqa: SLF001
    assert 0.1 + 0.2 != 0.3  # the comparison this avoids
    assert verify._money("1284.40") == Decimal("1284.40")  # noqa: SLF001
    assert verify._money("about forty dollars") is None  # noqa: SLF001
    assert verify._money(True) is None  # noqa: SLF001
    assert verify._money(None) is None  # noqa: SLF001


def test_the_tolerance_is_exactly_one_cent() -> None:
    subject_id = uuid4()

    def sum_check(total: float) -> str:
        subject = Subject(
            subject_id, TYPE_BILL, {"total": total, "line_items": [{"amount": 10.00}]}
        )
        return verify._line_items_sum(subject).result  # noqa: SLF001

    assert sum_check(10.00) == RESULT_PASS
    assert sum_check(10.01) == RESULT_PASS
    assert sum_check(9.99) == RESULT_PASS
    assert sum_check(10.02) == RESULT_FAIL
    assert sum_check(9.98) == RESULT_FAIL


def test_a_candidate_nothing_checked_is_never_promoted() -> None:
    assert verify.verdicts([]) == set()


# --- the erasure regression (last: it destroys what earlier tests read) -----

ERASABLE = "billsc3erasable"
# A total with a distinctive decimal tail, against a single zero line item, so
# the delta is EXACTLY the erased amount — the case that makes a delta unsafe to
# leave lying around — and so searching event payloads for it cannot collide
# with a hex entity id.
LEAKY_TOTAL = "1284.37"


def test_erasing_a_candidate_takes_the_receipt_numbers_with_it(
    verify_ctx: AccessContext,
) -> None:
    """A receipt must not become a back-door copy of erased PHI, and re-running
    the verifier is not good enough: `verify` is operator-run, nothing schedules
    it, and the receipt's earlier EVENT payloads would keep the deltas forever
    even after a re-run scrubbed live state. So erasing a candidate cascades to
    its receipts synchronously.

    The delta here is deliberately the leaky shape: one operand is zero, so the
    difference equals the other operand exactly. That is the bill's own amount
    sitting in a second entity."""
    document_id = uuid4()
    bill_id = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(
            issuer=f"Mercy {ERASABLE}",
            account_ref=f"ACCT-{ERASABLE}",
            total=LEAKY_TOTAL,
            line_items=[{"code": "99213", "quantity": "1", "amount": "0.00"}],
        ),
    )
    verdict = verify_document(verify_ctx, document_id)
    receipt_id = verdict.receipt_id
    leaked = -float(LEAKY_TOTAL)
    assert (
        result_of(receipt_of(verify_ctx, receipt_id), bill_id, CHECK_LINE_ITEMS_SUM)["delta"]
        == leaked
    )
    assert find(verify_ctx, text=ERASABLE)  # not a vacuous test
    assert events_mentioning(LEAKY_TOTAL) > 0

    result = forget_bill(verify_ctx, bill_id)

    assert result.receipts_redacted == 1
    # gone from the receipt's live state...
    assert "checks" not in receipt_of(verify_ctx, receipt_id)
    # ...and from every event payload that ever carried it, receipt events
    # included. This is the assertion the first version of this test never made.
    assert events_mentioning(LEAKY_TOTAL) == 0
    assert find(verify_ctx, text=ERASABLE) == []
    assert events_mentioning(ERASABLE) == 0

    # and a later run rebuilds an honest, number-free ruling
    verify_document(verify_ctx, document_id)
    receipt = receipt_of(verify_ctx, receipt_id)
    assert all("delta" not in c for c in receipt["checks"])
    assert result_of(receipt, bill_id, CHECK_LINE_ITEMS_SUM)["result"] == RESULT_UNCHECKED
    assert receipt["verified_ids"] == []
    assert events_mentioning(LEAKY_TOTAL) == 0


VERIFIED_THEN_ERASED = "billsc3erasedverified"


def test_erasing_a_verified_candidate_demotes_it_on_the_next_run(
    verify_ctx: AccessContext,
) -> None:
    """A husk cannot be verified: there is nothing left to check, and a
    `verified` status over values nobody can inspect is a claim the system
    cannot back. The receipt history still records that it once passed."""
    document_id = uuid4()
    bill_id = candidate(
        verify_ctx,
        document_id,
        TYPE_BILL,
        bill_record(
            issuer=f"Mercy {VERIFIED_THEN_ERASED}", account_ref=f"ACCT-{VERIFIED_THEN_ERASED}"
        ),
    )
    verify_document(verify_ctx, document_id)
    assert status_of(verify_ctx, bill_id) == STATUS_VERIFIED

    forget_bill(verify_ctx, bill_id)
    verdict = verify_document(verify_ctx, document_id)

    assert (verdict.verified, verdict.demoted) == (0, 1)
    assert status_of(verify_ctx, bill_id) == STATUS_CANDIDATE
    assert events_mentioning(VERIFIED_THEN_ERASED) == 0


def test_a_receipt_can_itself_be_erased_down_to_an_honest_husk(
    verify_ctx: AccessContext,
) -> None:
    document_id = uuid4()
    candidate(verify_ctx, document_id, TYPE_BILL, bill_record(total="140.00"))
    verdict = verify_document(verify_ctx, document_id)

    result = forget(verify_ctx, verdict.receipt_id)  # type: ignore[arg-type]

    assert result.fields == ["checks"]
    husk = receipt_of(verify_ctx, verdict.receipt_id)
    assert "checks" not in husk
    assert husk["passed"] is False and husk["document_id"] == str(document_id)
