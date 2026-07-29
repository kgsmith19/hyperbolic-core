"""Integration + unit: LLM extraction to candidate bill/EOB events
(ADR 016, roadmap C2).

Tests share the session database, so every document embeds a marker unique to
its test. The model client is always a scripted fake — nothing here calls
Anthropic, and no real medical document or real PHI exists in this repo.
"""

import json
import logging
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import jsonschema
import pytest

from domains.bills import extract
from domains.bills.extract import (
    MAX_CONFIDENCE,
    ExtractionReport,
    ModelCallFailed,
    extract_document,
    record_key,
    run_extraction,
)
from domains.bills.types import (
    EXTRACTION_EMPTY,
    EXTRACTION_FAILED,
    EXTRACTION_OK,
    EXTRACTION_REFUSED,
    EXTRACTION_UNPARSABLE,
    STATUS_CANDIDATE,
    TYPE_BILL,
    TYPE_EOB,
    TYPE_EXTRACTION,
    define_bills_types,
)
from domains.documents.capture import DocumentErased, capture_document, forget_document
from domains.documents.storage import BlobStore
from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.services import capture, find, forget, get_entity, history

DocumentFactory = Callable[[str], UUID]


class FakeClient:
    """Mirrors the `client.beta.messages.create(**kw)` surface extract.py uses.

    Records every call, so a test can assert what was sent and — more to the
    point — that nothing was sent at all.
    """

    def __init__(self, responses: list[Any]) -> None:
        self.calls: list[dict[str, Any]] = []
        self._responses = list(responses)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("the fake model client was called more often than scripted")
        scripted = self._responses.pop(0)
        if isinstance(scripted, Exception):
            raise scripted
        return scripted


def response(text: str, stop_reason: str = "end_turn") -> Any:
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)], stop_reason=stop_reason
    )


def json_response(body: dict[str, Any]) -> Any:
    return response(json.dumps(body))


def refusal() -> Any:
    return SimpleNamespace(content=[], stop_reason="refusal")


def payload(marker: str, confidence: float = 0.8) -> dict[str, Any]:
    """One bill and one EOB, entirely invented, tagged with a test marker."""
    return {
        "bills": [
            {
                "category": "medical",
                "issuer": f"Mercy Clinic {marker}",
                "account_ref": f"ACCT-{marker}",
                "service_date": "2026-03-04",
                "due_date": "2026-04-01",
                "currency": "usd",
                "total": "$1,284.40",
                "line_items": [{"code": "99213", "quantity": "1", "amount": "128.40"}],
                "confidence": confidence,
                "low_confidence_fields": ["due_date"],
            }
        ],
        "eobs": [
            {
                "payer": f"Blue Shield {marker}",
                "claim_no": f"CLM-{marker}",
                "service_date": "2026-03-04",
                "currency": "USD",
                "line_items": [
                    {
                        "code": "99213",
                        "quantity": "1",
                        "billed": "128.40",
                        "allowed": "90.00",
                        "plan_paid": "72.00",
                        "patient_resp": "18.00",
                    }
                ],
                "confidence": confidence,
                "low_confidence_fields": [],
            }
        ],
    }


EMPTY_PAYLOAD: dict[str, Any] = {"bills": [], "eobs": []}


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def events_mentioning(needle: str) -> int:
    """Events whose payload still contains a string anywhere — the erasure bar."""
    with db.connect() as conn:
        row = conn.execute(
            "select count(*) as n from event where payload::text like %s", (f"%{needle}%",)
        ).fetchone()
        assert row is not None
        return int(row["n"])


def only(entities: list[Any]) -> Any:
    assert len(entities) == 1, entities
    return entities[0]


# --- the happy path ---------------------------------------------------------


def test_extraction_captures_flagged_candidates_citing_the_document(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    marker = "billsc2alpha"
    document_id = make_document(marker)
    client = FakeClient([json_response(payload(marker))])

    report = extract_document(bills_ctx, document_id, client=client, store=store)

    assert report.status == EXTRACTION_OK
    assert (report.bill_count, report.eob_count) == (1, 1)

    bill = only(find(bills_ctx, type_name=TYPE_BILL, filters={"account_ref": f"ACCT-{marker}"}))
    attributes = bill.attributes
    assert attributes["status"] == STATUS_CANDIDATE
    assert attributes["category"] == "medical"
    assert attributes["total"] == 1284.40  # "$1,284.40" coerced, never stored verbatim
    assert attributes["currency"] == "USD"
    assert attributes["line_items"] == [{"code": "99213", "quantity": 1.0, "amount": 128.40}]
    assert attributes["low_confidence_fields"] == ["due_date"]

    provenance = attributes["provenance"]
    assert provenance["method"] == "llm_extraction"
    assert provenance["source_entity_ids"] == [str(document_id)]
    assert provenance["source_event_ids"] == [str(history(bills_ctx, document_id)[-1].id)]

    eob = only(find(bills_ctx, type_name=TYPE_EOB, filters={"claim_no": f"CLM-{marker}"}))
    assert eob.attributes["line_items"][0]["patient_resp"] == 18.00
    assert eob.attributes["provenance"]["method"] == "llm_extraction"


def test_a_candidate_can_never_look_like_a_verified_fact(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """C3 owns verification. Until it lands, neither a "verified" status nor a
    confidence of 1.0 is expressible — the type schema refuses both, so an LLM
    guess cannot be mistaken for a checked fact (ADR 010)."""
    marker = "billsc2fact"
    document_id = make_document(marker)
    # A model claiming certainty is capped, not believed.
    client = FakeClient([json_response(payload(marker, confidence=1.0))])
    extract_document(bills_ctx, document_id, client=client, store=store)

    bill = only(find(bills_ctx, type_name=TYPE_BILL, filters={"account_ref": f"ACCT-{marker}"}))
    assert bill.attributes["provenance"]["confidence"] == MAX_CONFIDENCE

    base = dict(bill.attributes)
    with pytest.raises(jsonschema.ValidationError):
        capture(bills_ctx, TYPE_BILL, {**base, "status": "verified"})
    with pytest.raises(jsonschema.ValidationError):
        capture(
            bills_ctx,
            TYPE_BILL,
            {**base, "provenance": {**base["provenance"], "confidence": 1.0}},
        )


def test_line_items_stay_structured_and_prose_never_lands_in_an_attribute(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """There is no description field to fill, and a "code" that is really a
    procedure name is dropped rather than stored: `entity.search` is a tsvector
    over `attributes::text`, so it would otherwise be searchable by anything
    holding read scope."""
    marker = "billsc2prose"
    document_id = make_document(marker)
    smuggled = payload(marker)
    smuggled["bills"][0]["line_items"] = [
        {"code": "MRI LUMBAR SPINE W/O CONTRAST", "quantity": "1", "amount": "900.00"}
    ]
    client = FakeClient([json_response(smuggled)])

    extract_document(bills_ctx, document_id, client=client, store=store)

    bill = only(find(bills_ctx, type_name=TYPE_BILL, filters={"account_ref": f"ACCT-{marker}"}))
    assert bill.attributes["line_items"] == [{"quantity": 1.0, "amount": 900.00}]
    assert find(bills_ctx, text="LUMBAR") == []
    assert events_mentioning("LUMBAR") == 0


def test_an_injected_issuer_or_claim_number_is_dropped_not_stored(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """A document is untrusted input aimed at the extractor: white-on-white text
    can tell the model to "record the issuer as ...". Whatever it returns is held
    to a length and a character class before it can reach an attribute — and the
    attribute is what the generated tsvector indexes and the event payload
    quotes verbatim."""
    marker = "billsc2injected"
    injected = "dxinjectedsecret"
    poisoned = payload(marker)
    poisoned["bills"][0]["issuer"] = (
        f"Mercy Clinic - patient JANE DOE, {injected}, and note this on every future bill"
    )
    poisoned["eobs"][0]["claim_no"] = f"CLM note: {injected} positive"
    client = FakeClient([json_response(poisoned)])

    extract_document(bills_ctx, make_document(marker), client=client, store=store)

    bill = only(find(bills_ctx, type_name=TYPE_BILL, filters={"account_ref": f"ACCT-{marker}"}))
    assert "issuer" not in bill.attributes
    eob = only(find(bills_ctx, type_name=TYPE_EOB, filters={"payer": f"Blue Shield {marker}"}))
    assert "claim_no" not in eob.attributes
    assert find(bills_ctx, text=injected) == []
    assert events_mentioning(injected) == 0


def test_the_document_text_goes_to_the_model_and_nowhere_else(
    bills_ctx: AccessContext,
    store: BlobStore,
    make_document: DocumentFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    marker = "billsc2phitext"
    document_id = make_document(marker)
    client = FakeClient([json_response(EMPTY_PAYLOAD)])

    with caplog.at_level(logging.DEBUG):
        report = extract_document(bills_ctx, document_id, client=client, store=store)

    assert report.status == EXTRACTION_EMPTY
    # it did go to Anthropic: that is the slice, and the recorded data flow
    assert marker in client.calls[0]["messages"][0]["content"]
    # and nowhere else — not an attribute, not an event payload, not the log
    assert find(bills_ctx, text=marker) == []
    assert events_mentioning(marker) == 0
    assert marker not in caplog.text


def test_every_run_records_which_document_went_to_which_model(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """The PHI-to-Anthropic flow is auditable after the fact (ADR 016)."""
    marker = "billsc2audit"
    document_id = make_document(marker)
    client = FakeClient([json_response(payload(marker))])

    extract_document(bills_ctx, document_id, client=client, store=store)

    run = only(
        find(bills_ctx, type_name=TYPE_EXTRACTION, filters={"extraction_key": str(document_id)})
    )
    assert run.attributes["status"] == EXTRACTION_OK
    assert run.attributes["model"] == extract.DEFAULT_MODEL
    assert (run.attributes["bill_count"], run.attributes["eob_count"]) == (1, 1)
    assert run.attributes["text_chars"] > 0
    assert marker not in str(run.attributes)  # the record names no content


def test_the_request_pins_the_json_schema_the_model_must_answer_in(
    bills_ctx: AccessContext,
    store: BlobStore,
    make_document: DocumentFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LIFEOS_EXTRACT_MODEL", "claude-sonnet-5")
    document_id = make_document("billsc2schema")
    client = FakeClient([json_response(EMPTY_PAYLOAD)])

    extract_document(bills_ctx, document_id, client=client, store=store)

    request = client.calls[0]
    assert request["model"] == "claude-sonnet-5"  # operator config, not code
    assert request["output_config"]["format"] == {
        "type": "json_schema",
        "schema": extract.LLM_SCHEMA,
    }
    assert request["fallbacks"] == "default"  # refusal fallback, as /chat has


def test_re_extracting_the_same_document_emits_nothing_new(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """The identity keys doing their job: the same document and the same answer
    resolve onto the same candidates."""
    marker = "billsc2idempotent"
    document_id = make_document(marker)
    client = FakeClient([json_response(payload(marker)), json_response(payload(marker))])
    extract_document(bills_ctx, document_id, client=client, store=store)

    before = event_count()
    extract_document(bills_ctx, document_id, client=client, store=store)
    assert event_count() == before


def test_a_recorded_run_takes_the_document_out_of_the_sweep(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """A document is sent to Anthropic once, not once per scheduled run — and
    the `bill_extraction` record, not the candidates, is what says so, so a
    document that legitimately yielded nothing is not re-sent either."""
    document_id = make_document("billsc2sweep")
    assert document_id in extract._pending_documents(bills_ctx)  # noqa: SLF001

    client = FakeClient([json_response(EMPTY_PAYLOAD)])
    run_extraction(bills_ctx, document_ids=[document_id], client=client, store=store)

    assert document_id not in extract._pending_documents(bills_ctx)  # noqa: SLF001


# --- refusing, failing, and never leaking -----------------------------------


def test_write_scope_is_checked_before_the_document_leaves_the_box(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """Sending a medical bill to a third party cannot be undone, so a read-only
    context is refused before the call rather than after it (the C1 precedent,
    applied to an outbound flow instead of a delete)."""
    document_id = make_document("billsc2scope")
    client = FakeClient([json_response(payload("billsc2scope"))])
    read_only = AccessContext.of("bills:read", "documents:read")

    with pytest.raises(ScopeError):
        extract_document(read_only, document_id, client=client, store=store)

    assert client.calls == []  # nothing was sent


def test_a_refusal_is_recorded_rather_than_crashing_the_run(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    document_id = make_document("billsc2refusal")
    client = FakeClient([refusal()])

    report = run_extraction(bills_ctx, document_ids=[document_id], client=client, store=store)

    assert (report.refused, report.bills, report.eobs) == (1, 0, 0)
    assert report.ok is False  # a refused document fails the job, visibly
    run = only(
        find(bills_ctx, type_name=TYPE_EXTRACTION, filters={"extraction_key": str(document_id)})
    )
    assert run.attributes["status"] == EXTRACTION_REFUSED


def test_an_unusable_response_is_recorded_without_quoting_the_document(
    bills_ctx: AccessContext,
    store: BlobStore,
    make_document: DocumentFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A parser error message is built from the tokens it choked on, and those
    tokens came from a bill. Only the exception class name is ever recorded."""
    marker = "billsc2unparsable"
    document_id = make_document(marker)
    client = FakeClient([response(f"Sorry, I cannot read {marker}. The balance is 128.40")])

    with caplog.at_level(logging.DEBUG):
        report = run_extraction(bills_ctx, document_ids=[document_id], client=client, store=store)

    assert (report.unparsable, report.ok) == (1, False)
    assert marker not in caplog.text
    assert "JSONDecodeError" in caplog.text  # the class name, and only that
    run = only(
        find(bills_ctx, type_name=TYPE_EXTRACTION, filters={"extraction_key": str(document_id)})
    )
    assert run.attributes["status"] == EXTRACTION_UNPARSABLE


def test_a_provider_error_never_carries_its_message_out(
    bills_ctx: AccessContext,
    store: BlobStore,
    make_document: DocumentFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An API error can echo the request body back, and the request body is the
    document — so the message dies at the boundary, traceback included."""
    marker = "billsc2apierror"
    document_id = make_document(marker)
    client = FakeClient([RuntimeError(f"400 invalid_request_error: ...{marker}...")])

    with caplog.at_level(logging.DEBUG), pytest.raises(ModelCallFailed) as raised:
        extract_document(bills_ctx, document_id, client=client, store=store)

    assert marker not in str(raised.value)
    assert "RuntimeError" in str(raised.value)  # the class name is enough to debug
    assert marker not in caplog.text
    assert raised.value.__cause__ is None and raised.value.__suppress_context__


def test_a_failed_model_call_is_still_recorded_before_it_raises(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """The hole the audit trail must not have: the request was transmitted and
    the response failed, so the PHI left the box. If that outcome skipped the
    `bill_extraction` capture, "was this document ever sent to Anthropic?" would
    answer "no" exactly when it should answer "yes" — and the sweep, seeing no
    record, would silently send it again."""
    document_id = make_document("billsc2failrecord")
    client = FakeClient([RuntimeError("connection reset")])

    with pytest.raises(ModelCallFailed):
        extract_document(bills_ctx, document_id, client=client, store=store)

    run = only(
        find(bills_ctx, type_name=TYPE_EXTRACTION, filters={"extraction_key": str(document_id)})
    )
    assert run.attributes["status"] == EXTRACTION_FAILED
    assert run.attributes["text_chars"] > 0  # it says how much was sent
    # and a retry is now an explicit operator act, not an automatic re-send
    assert document_id not in extract._pending_documents(bills_ctx)  # noqa: SLF001


def test_the_execution_receipt_carries_no_count_of_medical_records(
    bills_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The receipt lives in `ops`, which stays readable by chat and the SPA so
    "did the cron run?" keeps working. That makes it the wrong place for
    "3 bills, 1 EOB" and for the ids of those candidates."""
    monkeypatch.setattr(
        extract,
        "run_extraction",
        lambda ctx, document_ids=None: ExtractionReport(
            documents=2, bills=3, eobs=1, produced=[UUID(int=1), UUID(int=2)]
        ),
    )
    result = extract._job(bills_ctx, None)  # noqa: SLF001

    assert result.produced == []
    assert not any(character.isdigit() for character in result.summary)
    assert "bill_extraction" in result.summary  # it points at where the detail is


def test_extraction_refuses_an_erased_document(
    bills_ctx: AccessContext,
    document_ctx: AccessContext,
    store: BlobStore,
    make_pdf: Callable[[str], bytes],
) -> None:
    """Erasure closed the read seam, so no later run can quote a destroyed bill."""
    document_id = capture_document(
        document_ctx, make_pdf("Statement billsc2erasedoc 12.00"), store=store
    )
    forget_document(document_ctx, document_id, store=store)
    client = FakeClient([json_response(EMPTY_PAYLOAD)])

    with pytest.raises(DocumentErased):
        extract_document(bills_ctx, document_id, client=client, store=store)
    assert client.calls == []


# --- unit: coercion, bounds and keys ----------------------------------------


def test_amounts_are_coerced_or_dropped_never_guessed() -> None:
    assert extract._amount("$1,284.40") == 1284.40  # noqa: SLF001
    assert extract._amount("(25.00)") == -25.00  # noqa: SLF001
    assert extract._amount("128") == 128.0  # noqa: SLF001
    # "not stated" stays absent: a zero would be a number nobody wrote, and C3
    # would reconcile against it
    assert extract._amount("") is None  # noqa: SLF001
    assert extract._amount("about forty dollars") is None  # noqa: SLF001
    assert extract._amount(None) is None  # noqa: SLF001


def test_org_and_ref_values_are_dropped_rather_than_truncated() -> None:
    """Truncating an injected instruction leaves injected text in a full-text
    indexed attribute, so a value that breaks the bound is dropped outright."""
    assert extract._org("Mercy Clinic") == "Mercy Clinic"  # noqa: SLF001
    assert extract._org("Blue Cross Blue Shield of MA, Inc.") is not None  # noqa: SLF001
    assert extract._org("x" * 65) is None  # over-long: dropped, not cut to 64  # noqa: SLF001
    assert extract._org("Mercy Clinic — dx HIV") is None  # charset  # noqa: SLF001
    assert extract._ref("ACCT-123/4.5") == "ACCT-123/4.5"  # noqa: SLF001
    assert extract._ref("CLM 123 note: HIV positive") is None  # noqa: SLF001
    # The honest boundary, asserted so nobody reads more into the control than
    # it gives: a short, in-charset string still lands. Bounding is a
    # mitigation; x-pii (erasable) and x-sensitive (never model-readable) are
    # what make that survivable.
    assert extract._org("dx HIV positive") == "dx HIV positive"  # noqa: SLF001


def test_dates_must_be_real_iso_dates() -> None:
    assert extract._date(" 2026-03-04 ") == "2026-03-04"  # noqa: SLF001
    assert extract._date("March 4th") is None  # noqa: SLF001
    assert extract._date("2026-13-40") is None  # noqa: SLF001


def test_confidence_is_clamped_below_certainty() -> None:
    assert extract._confidence(1.0) == MAX_CONFIDENCE  # noqa: SLF001
    assert extract._confidence(4.2) == MAX_CONFIDENCE  # noqa: SLF001
    assert extract._confidence(-1) == 0.0  # noqa: SLF001
    assert extract._confidence("high") == extract.DEFAULT_CONFIDENCE  # noqa: SLF001
    assert extract._confidence(None) == extract.DEFAULT_CONFIDENCE  # noqa: SLF001


def test_flagged_fields_cannot_become_a_free_text_channel() -> None:
    allowed = {"issuer", "total"}
    assert extract._flagged(["issuer", "total"], allowed) == ["issuer", "total"]  # noqa: SLF001
    assert extract._flagged(["the patient is Jane Doe", "issuer"], allowed) == [  # noqa: SLF001
        "issuer"
    ]
    assert extract._flagged("issuer", allowed) == []  # noqa: SLF001


def test_record_key_is_a_hash_not_the_values_it_keys_on() -> None:
    """An identity field is never a PII field: `claim_no` is erasable, so the
    key is a digest over it (ADR 012 "Durable erasure")."""
    key = record_key("a" * 64, "eob", "Blue Shield", "CLM-1")
    assert len(key) == 64 and "CLM-1" not in key
    assert key == record_key("a" * 64, "eob", " blue shield ", "clm-1")
    assert key != record_key("a" * 64, "eob", "Blue Shield", "CLM-2")
    assert key != record_key("b" * 64, "eob", "Blue Shield", "CLM-1")  # per document


def test_the_type_refuses_a_free_text_field_even_if_something_tries(
    bills_ctx: AccessContext,
) -> None:
    """The schema on the request is the model's contract; this one is ours."""
    define_bills_types(bills_ctx)
    base: dict[str, Any] = {
        "bill_key": "b" * 64,
        "status": STATUS_CANDIDATE,
        "category": "medical",
        "extracted_at": "2026-07-29T00:00:00+00:00",
        "provenance": {
            "source_entity_ids": [],
            "source_event_ids": [],
            "method": "llm_extraction",
            "confidence": 0.5,
        },
    }
    with pytest.raises(jsonschema.ValidationError):  # no description on a line item
        capture(bills_ctx, TYPE_BILL, {**base, "line_items": [{"description": "MRI"}]})
    with pytest.raises(jsonschema.ValidationError):  # nor a note beside it
        capture(bills_ctx, TYPE_BILL, {**base, "notes": "the patient is Jane Doe"})


def test_report_line_carries_counts_and_nothing_else() -> None:
    line = ExtractionReport(documents=2, bills=3, eobs=1, refused=1).line()
    assert "documents=2" in line and "bills=3" in line and "refused=1" in line


def test_type_definition_is_idempotent_registry_data(bills_ctx: AccessContext) -> None:
    assert define_bills_types(bills_ctx) == []


# --- the erasure regression (last: it destroys what earlier tests read) -----

ERASABLE = "billsc2erasable"


@pytest.fixture(scope="module")
def erasable(make_document: DocumentFactory) -> UUID:
    """One document built once, so the erasure test and the re-extraction test
    are provably talking about the same bill."""
    return make_document(ERASABLE)


def test_forget_removes_every_flagged_field_from_a_candidate(
    bills_ctx: AccessContext, store: BlobStore, erasable: UUID
) -> None:
    client = FakeClient([json_response(payload(ERASABLE))])
    extract_document(bills_ctx, erasable, client=client, store=store)
    bill = only(find(bills_ctx, type_name=TYPE_BILL, filters={"account_ref": f"ACCT-{ERASABLE}"}))
    eob = only(find(bills_ctx, type_name=TYPE_EOB, filters={"claim_no": f"CLM-{ERASABLE}"}))
    assert find(bills_ctx, text=ERASABLE)  # not a vacuous test

    bill_result = forget(bills_ctx, bill.id)
    eob_result = forget(bills_ctx, eob.id)

    assert bill_result.fields == [
        "account_ref",
        "due_date",
        "issuer",
        "line_items",
        "service_date",
        "total",
    ]
    assert eob_result.fields == ["claim_no", "line_items", "payer", "service_date"]
    # 1. gone from live state — and the husk is still a valid candidate, keyed
    #    on a field erasure cannot touch
    erased = get_entity(bills_ctx, bill.id).entity.attributes
    assert not {"issuer", "account_ref", "total", "line_items"} & set(erased)
    assert erased["status"] == STATUS_CANDIDATE
    assert erased["bill_key"] == bill.attributes["bill_key"]
    # 2. gone from full-text search and from every event payload that held it
    assert find(bills_ctx, text=ERASABLE) == []
    assert events_mentioning(ERASABLE) == 0
    assert all(
        not {"issuer", "account_ref", "total", "line_items"}
        & set(event.payload.get("entity", {}).get("attributes", {}))
        for event in history(bills_ctx, bill.id)
    )


def test_an_erased_candidate_is_not_rewritten_by_a_later_extraction(
    bills_ctx: AccessContext, store: BlobStore, erasable: UUID
) -> None:
    """The ADR 012 "Durable erasure" failure in its extraction form: the source
    document is untouched by the candidate's erasure, so a re-run would
    otherwise re-materialize the issuer and the total on the very same entity."""
    document = get_entity(bills_ctx, erasable).entity
    key = record_key(
        document.attributes["sha256"],
        TYPE_BILL,
        f"Mercy Clinic {ERASABLE}",
        f"ACCT-{ERASABLE}",
        "2026-03-04",
    )
    client = FakeClient([json_response(payload(ERASABLE))])

    extract_document(bills_ctx, erasable, client=client, store=store)

    # the erased candidate is still findable by its non-PII key — that is what
    # keying on a hash buys — and it is still empty
    bill = only(find(bills_ctx, type_name=TYPE_BILL, filters={"bill_key": key}))
    assert not {"issuer", "account_ref", "total", "line_items", "service_date"} & set(
        bill.attributes
    )
    assert find(bills_ctx, text=ERASABLE) == []
    assert events_mentioning(ERASABLE) == 0


DRIFT = "billsc2drift"


def test_erasure_survives_the_model_rewording_itself(
    bills_ctx: AccessContext, store: BlobStore, make_document: DocumentFactory
) -> None:
    """The keys hash model output, so a re-run that says "Blue Shield of CA"
    where it once said "Blue Shield" — a different model, a different day —
    lands on a different key, finds no existing entity, and would consult no
    redaction list. The erased payer, claim number and line items would be
    captured fresh and re-indexed into search. Replaying an identical payload
    cannot see this; drifting one can.
    """
    document_id = make_document(DRIFT)
    client = FakeClient([json_response(payload(DRIFT))])
    extract_document(bills_ctx, document_id, client=client, store=store)
    bill = only(find(bills_ctx, type_name=TYPE_BILL, filters={"account_ref": f"ACCT-{DRIFT}"}))
    eob = only(find(bills_ctx, type_name=TYPE_EOB, filters={"claim_no": f"CLM-{DRIFT}"}))
    forget(bills_ctx, bill.id)
    forget(bills_ctx, eob.id)
    assert find(bills_ctx, text=DRIFT) == []

    drifted = payload(DRIFT)
    drifted["bills"][0]["issuer"] = f"Mercy Clinic {DRIFT} LLC"  # same bill, new words
    drifted["bills"][0]["account_ref"] = f"ACCT-{DRIFT}-02"
    drifted["eobs"][0]["payer"] = f"Blue Shield {DRIFT} of CA"
    extract_document(
        bills_ctx, document_id, client=FakeClient([json_response(drifted)]), store=store
    )

    # a new entity may exist under the new key — but it is a husk, and nothing
    # erased has come back anywhere
    assert find(bills_ctx, text=DRIFT) == []
    assert events_mentioning(DRIFT) == 0
    for entity in find(bills_ctx, type_name=TYPE_BILL) + find(bills_ctx, type_name=TYPE_EOB):
        provenance = entity.attributes.get("provenance") or {}
        if str(document_id) in provenance.get("source_entity_ids", []):
            assert not {
                "issuer",
                "account_ref",
                "payer",
                "claim_no",
                "total",
                "line_items",
                "service_date",
            } & set(entity.attributes)
