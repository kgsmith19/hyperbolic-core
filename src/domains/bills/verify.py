"""Deterministic reconciliation: candidate bills/EOBs -> verification receipts,
and promotion to ``verified`` only on a full pass (ADR 017, roadmap C3).

C2's extractor proposes; this disposes. **There is no model anywhere in this
path** — no Anthropic client, no prompt, no network call of any kind. Every
verdict is arithmetic over kernel state this process read directly, which is
why a `verification_receipt` may honestly carry `confidence: 1.0` while the
candidates it judges may not (ADR 010).

Money is compared as ``Decimal``, never as a float, within an explicit one-cent
tolerance. Dates are compared as dates. Each check is reported independently,
so a receipt says *which* arithmetic failed and by how much rather than
"verification failed".

**Promotion is the delicate part.** A candidate becomes ``verified`` only when
every check that names it passed; anything else — a failure, or an input the
extractor never captured — leaves it a ``candidate`` with a receipt saying why.
The promotion is protected three ways (ADR 017): the type schema refuses
``"verified"`` unless the record cites the receipt that granted it,
``guard_capture`` turns away a direct ``POST /capture`` that tries to set it,
and every run re-judges the records it already promoted, so a record that stops
passing is demoted rather than left standing.

Receipts carry entity ids, check enums, line indices, bounded field names and
signed deltas — never a value copied out of a document. A delta is arithmetic
over `x-pii` amounts, so `checks` is `x-pii` too and every run rewrites it in
full: re-verifying after an erasure scrubs the numbers instead of leaving them
behind (ADR 012 "Durable erasure", ADR 015/016).

Runs as ``python -m domains.bills.verify [document_id ...]`` under a code-built
AccessContext of exactly `bills:read`/`write` + `ops:read`/`write` — narrower
than extraction's, because this job never reads a document. Every run leaves an
execution receipt and only ``ok`` exits 0 (ADR 014).
"""

import json
import logging
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from jsonschema import ValidationError

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
    DOMAIN,
    KEY_FIELDS,
    MAX_CHECKS,
    MAX_FLAGGED_FIELDS,
    MAX_IDS,
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
from domains.ops.receipts import STATUS_FAILED, STATUS_OK, JobResult, run_job
from kernel import services
from kernel.access import AccessContext, require
from kernel.events import DEFAULT_ACTOR
from kernel.services import ForgetResult

log = logging.getLogger("lifeos.bills")

METHOD = "deterministic_verification"
JOB = "domains.bills.verify"

CENT = Decimal("0.01")

# One cent, per comparison. Every amount in this domain is already quantized to
# two decimal places before it is stored (`extract._amount` rounds), so an exact
# match is the expectation and this only absorbs a statement that rounds its own
# subtotal. Anything larger would start absorbing real discrepancies, which is
# the one thing a reconciliation check must not do.
TOLERANCE = Decimal("0.01")

# The sane window for a date on a bill. Outside it, the value is a parse
# artifact rather than a date: nothing in this system predates the project, and
# a due date more than two years out is not a due date.
WINDOW_START = date(2000, 1, 1)
WINDOW_FORWARD = timedelta(days=730)

EOB_AMOUNTS = ("billed", "allowed", "plan_paid", "patient_resp")
_MONEY_FIELDS = ("amount", *EOB_AMOUNTS)
_FIELD_NAME = re.compile(r"^[a-z_]{1,32}$")


def _money(raw: Any) -> Decimal | None:
    """A stored amount as an exact Decimal, or None when it is not a number.

    Currency is never compared as a float: `0.1 + 0.2 != 0.3` in binary, and a
    reconciliation check that is wrong by a machine epsilon is a check that
    reports noise. `str()` first, so the shortest round-tripping literal is what
    becomes the Decimal rather than the float's full binary expansion.
    """
    if isinstance(raw, bool) or not isinstance(raw, int | float | str):
        return None
    try:
        value = Decimal(str(raw))
        if not value.is_finite():
            return None
        return value.quantize(CENT)
    except (InvalidOperation, ValueError):
        return None


def _as_date(raw: Any) -> date | None:
    if not isinstance(raw, str):
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def _line_items(attributes: dict[str, Any]) -> list[dict[str, Any]]:
    items = attributes.get("line_items")
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


@dataclass(frozen=True)
class Subject:
    """One candidate under judgement: its id, its type and its current state."""

    entity_id: UUID
    type_name: str
    attributes: dict[str, Any]


@dataclass(frozen=True)
class Check:
    """One check's verdict about one candidate.

    Ids, an enum, an index, bounded field names and a signed delta. No value
    from the document is expressible here — there is no field to put one in.
    """

    check: str
    subject_id: UUID
    result: str
    line_index: int | None = None
    delta: Decimal | None = None
    fields: tuple[str, ...] = ()

    @property
    def passed(self) -> bool:
        return self.result == RESULT_PASS

    def attributes(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "check": self.check,
            "subject_id": str(self.subject_id),
            "result": self.result,
        }
        if self.line_index is not None:
            out["line_index"] = self.line_index
        if self.delta is not None:
            out["delta"] = float(self.delta)
        if self.fields:
            out["fields"] = list(self.fields)
        return out


def _within_tolerance(
    check: str, subject_id: UUID, delta: Decimal, line_index: int | None = None
) -> Check:
    """A two-sided arithmetic verdict: the delta is the amount it missed by."""
    if abs(delta) <= TOLERANCE:
        return Check(check, subject_id, RESULT_PASS, line_index=line_index)
    return Check(check, subject_id, RESULT_FAIL, line_index=line_index, delta=delta)


# --- the checks -------------------------------------------------------------


def _line_items_sum(subject: Subject) -> Check:
    """A bill's line items add up to the total it states."""
    total = _money(subject.attributes.get("total"))
    items = _line_items(subject.attributes)
    amounts = [a for a in (_money(i.get("amount")) for i in items) if a is not None]
    if total is None or not items or len(amounts) != len(items):
        return Check(CHECK_LINE_ITEMS_SUM, subject.entity_id, RESULT_UNCHECKED)
    return _within_tolerance(
        CHECK_LINE_ITEMS_SUM, subject.entity_id, sum(amounts, Decimal(0)) - total
    )


def _eob_line_checks(subject: Subject) -> list[Check]:
    """The EOB identity, per line, exactly as EOB_SCHEMA intends its four amounts.

    `billed` is what the provider charged, `allowed` is what the plan permits
    for that service, and the plan then splits `allowed` between itself and the
    patient. So the identity asserted is:

        plan_paid + patient_resp == allowed        (the split is complete)
        allowed <= billed                          (the difference is the
                                                    provider's write-off)
        every amount >= 0

    `billed - allowed` is deliberately NOT asserted to equal anything: that
    difference is the contractual adjustment, and it is whatever it is.
    """
    subject_id = subject.entity_id
    items = _line_items(subject.attributes)
    if not items:
        return [
            Check(name, subject_id, RESULT_UNCHECKED)
            for name in (
                CHECK_EOB_LINE_SPLIT,
                CHECK_EOB_ALLOWED_WITHIN_BILLED,
                CHECK_EOB_AMOUNTS_NON_NEGATIVE,
            )
        ]

    checks: list[Check] = []
    negative_at: int | None = None
    for index, item in enumerate(items):
        billed = _money(item.get("billed"))
        allowed = _money(item.get("allowed"))
        plan_paid = _money(item.get("plan_paid"))
        patient_resp = _money(item.get("patient_resp"))
        if billed is None or allowed is None or plan_paid is None or patient_resp is None:
            checks.append(Check(CHECK_EOB_LINE_SPLIT, subject_id, RESULT_UNCHECKED, index))
            checks.append(
                Check(CHECK_EOB_ALLOWED_WITHIN_BILLED, subject_id, RESULT_UNCHECKED, index)
            )
            continue
        checks.append(
            _within_tolerance(
                CHECK_EOB_LINE_SPLIT, subject_id, plan_paid + patient_resp - allowed, index
            )
        )
        over = allowed - billed
        checks.append(
            Check(CHECK_EOB_ALLOWED_WITHIN_BILLED, subject_id, RESULT_PASS, line_index=index)
            if over <= TOLERANCE
            else Check(
                CHECK_EOB_ALLOWED_WITHIN_BILLED,
                subject_id,
                RESULT_FAIL,
                line_index=index,
                delta=over,
            )
        )
        if negative_at is None and min(billed, allowed, plan_paid, patient_resp) < 0:
            negative_at = index
    # No delta on this one: the number that would prove it is an amount from the
    # document rather than a difference between two of them.
    checks.append(
        Check(
            CHECK_EOB_AMOUNTS_NON_NEGATIVE,
            subject_id,
            RESULT_FAIL if negative_at is not None else RESULT_PASS,
            line_index=negative_at,
        )
    )
    return checks


def _dates_coherent(subject: Subject) -> Check:
    """Service before due, and both inside the sane window."""
    service = _as_date(subject.attributes.get("service_date"))
    due = _as_date(subject.attributes.get("due_date"))
    present = [d for d in (service, due) if d is not None]
    if not present:
        return Check(CHECK_DATES_COHERENT, subject.entity_id, RESULT_UNCHECKED)
    horizon = datetime.now(UTC).date() + WINDOW_FORWARD
    ordered = service is None or due is None or service <= due
    in_window = all(WINDOW_START <= d <= horizon for d in present)
    return Check(
        CHECK_DATES_COHERENT,
        subject.entity_id,
        RESULT_PASS if ordered and in_window else RESULT_FAIL,
    )


def _line_signature(item: dict[str, Any]) -> str:
    return json.dumps(item, sort_keys=True, default=str)


def _no_duplicate_lines(subject: Subject, counts: Counter[tuple[str, str]]) -> Check:
    """The same line item captured twice among one document's candidates.

    Counted across every candidate of the same type derived from that document,
    so it catches both a line repeated inside one record and the same charge
    landing on two records extracted from the same page. Two genuinely identical
    charges on one day are indistinguishable from a double capture, and that is
    the point: the ambiguity is surfaced for a human instead of promoted.
    """
    items = _line_items(subject.attributes)
    if not items:
        return Check(CHECK_NO_DUPLICATE_LINES, subject.entity_id, RESULT_UNCHECKED)
    for index, item in enumerate(items):
        if counts[(subject.type_name, _line_signature(item))] > 1:
            return Check(CHECK_NO_DUPLICATE_LINES, subject.entity_id, RESULT_FAIL, index)
    return Check(CHECK_NO_DUPLICATE_LINES, subject.entity_id, RESULT_PASS)


def _currency_consistent(subject: Subject, document_currencies: set[str]) -> Check:
    """One document, one currency — and money without a stated unit is unchecked."""
    currency = subject.attributes.get("currency")
    has_money = subject.attributes.get("total") is not None or any(
        item.get(name) is not None
        for item in _line_items(subject.attributes)
        for name in _MONEY_FIELDS
    )
    if not isinstance(currency, str):
        return Check(
            CHECK_CURRENCY_CONSISTENT,
            subject.entity_id,
            RESULT_UNCHECKED if has_money else RESULT_PASS,
        )
    return Check(
        CHECK_CURRENCY_CONSISTENT,
        subject.entity_id,
        RESULT_FAIL if len(document_currencies) > 1 else RESULT_PASS,
    )


def _no_low_confidence_fields(subject: Subject) -> Check:
    """A field the extractor flagged is surfaced, never silently trusted.

    The names are this type's own field names and are re-held to the same
    bounded shape the schema enforces, so the receipt cannot inherit a free-text
    channel. A flagged list that is somehow unnameable still fails.
    """
    raw = subject.attributes.get("low_confidence_fields")
    flagged = [name for name in raw if isinstance(name, str)] if isinstance(raw, list) else []
    if not flagged:
        return Check(CHECK_NO_LOW_CONFIDENCE_FIELDS, subject.entity_id, RESULT_PASS)
    names = sorted({name for name in flagged if _FIELD_NAME.match(name)})[:MAX_FLAGGED_FIELDS]
    return Check(
        CHECK_NO_LOW_CONFIDENCE_FIELDS, subject.entity_id, RESULT_FAIL, fields=tuple(names)
    )


def _bill_eob_checks(bills: list[Subject], eobs: list[Subject]) -> list[Check]:
    """A bill and an EOB for the same service must agree on what the patient owes.

    The pairing is the service date, which is the only thing the two types share
    that a document states about both. The assertion is
    `sum(eob.patient_resp) == bill.total`: the plan's own arithmetic decides
    what is owed, and the provider's bill must not ask for more.

    A document holding only bills (or only EOBs) gets no cross-check at all —
    one obligation per document is the normal case, and an absent counterpart is
    not a discrepancy. But once a document holds **both**, a record that finds no
    partner is `unchecked`, never silent: a missing or merely different
    `service_date` used to emit nothing, and `verdicts` promotes on "every check
    naming it passed", so a bill claiming 5000.00 and an EOB saying the patient
    owes 30.00 would both sail through on internal self-consistency. A page that
    prints "March 4, 2026" is enough to induce that — `extract._date` drops
    anything `date.fromisoformat` refuses — so no attacker is needed. "We could
    not check this" must never read as "this is true".

    The verdict is recorded against BOTH records, so a disagreement blocks both.
    """
    checks: list[Check] = []
    paired: set[UUID] = set()
    for bill in bills:
        service_date = bill.attributes.get("service_date")
        if not isinstance(service_date, str):
            continue
        for eob in (e for e in eobs if e.attributes.get("service_date") == service_date):
            paired.update({bill.entity_id, eob.entity_id})
            total = _money(bill.attributes.get("total"))
            items = _line_items(eob.attributes)
            shares = [s for s in (_money(i.get("patient_resp")) for i in items) if s is not None]
            if total is None or not items or len(shares) != len(items):
                checks.extend(
                    Check(CHECK_BILL_EOB_PATIENT_RESP, s.entity_id, RESULT_UNCHECKED)
                    for s in (bill, eob)
                )
                continue
            delta = sum(shares, Decimal(0)) - total
            checks.extend(
                _within_tolerance(CHECK_BILL_EOB_PATIENT_RESP, s.entity_id, delta)
                for s in (bill, eob)
            )
    if bills and eobs:
        checks.extend(
            Check(CHECK_BILL_EOB_PATIENT_RESP, s.entity_id, RESULT_UNCHECKED)
            for s in bills + eobs
            if s.entity_id not in paired
        )
    return checks


def run_checks(subjects: list[Subject]) -> list[Check]:
    """Every check over one document's candidates. Pure: no I/O, no clock but
    today's date for the window bound, and no model."""
    bills = [s for s in subjects if s.type_name == TYPE_BILL]
    eobs = [s for s in subjects if s.type_name == TYPE_EOB]
    counts: Counter[tuple[str, str]] = Counter(
        (s.type_name, _line_signature(item)) for s in subjects for item in _line_items(s.attributes)
    )
    currencies = {
        s.attributes["currency"] for s in subjects if isinstance(s.attributes.get("currency"), str)
    }

    checks: list[Check] = []
    for subject in subjects:
        if subject.type_name == TYPE_BILL:
            checks.append(_line_items_sum(subject))
        else:
            checks.extend(_eob_line_checks(subject))
        checks.append(_dates_coherent(subject))
        checks.append(_no_duplicate_lines(subject, counts))
        checks.append(_currency_consistent(subject, currencies))
        checks.append(_no_low_confidence_fields(subject))
    checks.extend(_bill_eob_checks(bills, eobs))
    return checks


def verdicts(checks: list[Check]) -> set[UUID]:
    """The candidates every check agreed on.

    The promotion rule, in one line: a candidate is verified when it has at
    least one check and every check naming it passed. An `unchecked` result is
    not a pass — "we could not check this" must never read as "this is true" —
    and a candidate nothing checked is never promoted by default.
    """
    by_subject: defaultdict[UUID, list[Check]] = defaultdict(list)
    for check in checks:
        by_subject[check.subject_id].append(check)
    return {
        subject_id
        for subject_id, own in by_subject.items()
        if own and all(check.passed for check in own)
    }


# --- reading, writing, reporting --------------------------------------------


@dataclass
class DocumentVerdict:
    """One document's outcome. Counts and ids only — this reaches stdout."""

    document_id: UUID
    receipt_id: UUID | None = None
    subjects: int = 0
    verified: int = 0
    promoted: int = 0
    demoted: int = 0
    # Records whose own live state no longer validates against their type, so
    # the verdict could not be written back. Never folded into a generic error
    # count: a record in that state is exactly the one an attacker would want
    # skipped, since a status nothing can rewrite is a status nothing can demote.
    invalid: int = 0


def _subjects(ctx: AccessContext, document_id: UUID) -> list[Subject]:
    """Every candidate whose provenance cites this document (ADR 016 has no
    `derived_from` edge, so the citation inside the envelope is the link)."""
    cites = {"provenance": {"source_entity_ids": [str(document_id)]}}
    return [
        Subject(entity.id, type_name, entity.attributes)
        for type_name in (TYPE_BILL, TYPE_EOB)
        for entity in services.find(ctx, type_name=type_name, filters=cites)
    ]


def _source_event_ids(ctx: AccessContext, subjects: list[Subject]) -> list[str]:
    """The latest event on each subject that this job did not write itself.

    The receipt cites the state it judged (ADR 010). Excluding our own writes
    keeps the citation stable: otherwise the promotion this run performs would
    change what the next run cites, and a re-run over unchanged data would emit
    an event saying nothing new.
    """
    ids: list[str] = []
    for subject in subjects[:MAX_IDS]:
        judged = [e for e in services.history(ctx, subject.entity_id) if e.actor != JOB]
        if judged:
            ids.append(str(judged[-1].id))
    return ids


def _capture_receipt(ctx: AccessContext, attributes: dict[str, Any]) -> UUID:
    """Record the ruling, superseding this document's previous one.

    `checked_at` moves on every run and is excluded from the comparison, so a
    re-run over unchanged candidates emits zero events (the ADR 014 briefing
    precedent).
    """
    existing = services.find(
        ctx,
        type_name=TYPE_VERIFICATION,
        filters={"verification_key": attributes["verification_key"]},
    )
    if existing:
        stored = existing[0].attributes
        if all(stored.get(k) == v for k, v in attributes.items() if k != "checked_at"):
            return existing[0].id
    return services.capture(ctx, TYPE_VERIFICATION, attributes, actor=JOB).entity_id


def _apply_status(ctx: AccessContext, subject: Subject, receipt_id: UUID, verified: bool) -> bool:
    """Write this run's verdict onto the candidate. Returns whether it changed.

    The whole stored attribute set is written back with the status replaced,
    because `capture` validates what it is given against the full schema and
    then merges — a partial write would fail validation, and a key `capture`
    is not given can never be removed. Writing back current state is also what
    keeps erasure durable: an erased candidate's husk is what gets rewritten,
    so a promotion cannot resurrect a value.
    """
    target = STATUS_VERIFIED if verified else STATUS_CANDIDATE
    attributes = {
        **subject.attributes,
        "status": target,
        "verification_receipt_id": str(receipt_id),
    }
    if all(subject.attributes.get(key) == value for key, value in attributes.items()):
        return False
    services.capture(ctx, subject.type_name, attributes, actor=JOB)
    return True


def verify_document(ctx: AccessContext, document_id: UUID) -> DocumentVerdict:
    """Verify every candidate derived from one document, and rule on each.

    Write scope is required **first**. Promotion is a consequential write — it
    is the moment a guess becomes something the rest of the system may treat as
    true — so a `bills:read` context is turned away before anything is read or
    judged, never by a check that happens to run later inside `capture` (the C1
    precedent).
    """
    require(ctx, f"{DOMAIN}:write")
    define_bills_types(ctx)

    subjects = _subjects(ctx, document_id)
    verdict = DocumentVerdict(document_id=document_id, subjects=len(subjects))
    if not subjects:
        return verdict  # nothing derived from this document: no ruling to make

    checks = run_checks(subjects)
    verified = verdicts(checks)
    # Failures and unchecked results first, so a truncated receipt keeps the
    # part that matters. A run we cannot report in full promotes nothing.
    stored = sorted(checks, key=lambda check: check.passed)
    truncated = len(stored) > MAX_CHECKS
    if truncated:
        stored = stored[:MAX_CHECKS]
        verified = set()

    verdict.verified = len(verified)
    receipt_id = _capture_receipt(
        ctx,
        {
            "verification_key": str(document_id),
            "document_id": str(document_id),
            "subject_ids": sorted(str(s.entity_id) for s in subjects)[:MAX_IDS],
            "verified_ids": sorted(str(i) for i in verified)[:MAX_IDS],
            "passed": len(verified) == len(subjects),
            "checks_truncated": truncated,
            # Always written, even empty: `capture` merges, so a key this run
            # omits would keep the previous run's numbers — including numbers
            # derived from amounts that have since been erased.
            "checks": [check.attributes() for check in stored],
            "checked_at": datetime.now(UTC).isoformat(),
            "provenance": {
                "source_entity_ids": [str(document_id)]
                + sorted(str(s.entity_id) for s in subjects)[: MAX_IDS - 1],
                "source_event_ids": _source_event_ids(ctx, subjects),
                "method": METHOD,
                # Legitimate here and refused on a candidate: this is arithmetic
                # over kernel state, with no model in the path (ADR 010/017).
                "confidence": 1.0,
            },
        },
    )
    verdict.receipt_id = receipt_id

    for subject in subjects:
        promoted = subject.entity_id in verified
        try:
            changed = _apply_status(ctx, subject, receipt_id, promoted)
        except ValidationError:
            # This record's own stored state does not satisfy its own type, so
            # the verdict cannot be written back — most likely because something
            # merged a foreign field onto it. Counted separately, named in the
            # report line and on stderr, and it fails the run: silently skipping
            # it would leave whatever status it is wearing standing forever.
            log.error(
                "verification: entity %s no longer validates against its type", subject.entity_id
            )
            verdict.invalid += 1
            continue
        if not changed:
            continue
        if promoted:
            verdict.promoted += 1
        elif subject.attributes.get("status") == STATUS_VERIFIED:
            verdict.demoted += 1
    return verdict


@dataclass
class VerificationReport:
    documents: int = 0
    subjects: int = 0
    verified: int = 0
    promoted: int = 0
    demoted: int = 0
    invalid: int = 0
    errors: int = 0
    produced: list[UUID] = field(default_factory=list)

    def line(self) -> str:
        return (
            f"bill verification: documents={self.documents} subjects={self.subjects} "
            f"verified={self.verified} promoted={self.promoted} "
            f"demoted={self.demoted} invalid={self.invalid} errors={self.errors}"
        )

    @property
    def ok(self) -> bool:
        """A candidate that fails its checks is a RESULT, not a job failure —
        finding the discrepancy is the job working. A document the run could not
        judge, or a record whose verdict could not be written back, is a real
        failure and must not exit 0."""
        return not (self.errors or self.invalid)


def _documents_with_candidates(ctx: AccessContext) -> list[UUID]:
    """Every document some candidate cites. Stable order; re-runs are cheap
    because an unchanged ruling emits nothing."""
    ids: list[UUID] = []
    seen: set[str] = set()
    for type_name in (TYPE_BILL, TYPE_EOB):
        for entity in services.find(ctx, type_name=type_name):
            provenance = entity.attributes.get("provenance")
            cited = provenance.get("source_entity_ids", []) if isinstance(provenance, dict) else []
            for value in cited:
                if isinstance(value, str) and value not in seen:
                    seen.add(value)
                    ids.append(UUID(value))
    return ids


def run_verification(
    ctx: AccessContext, document_ids: list[UUID] | None = None
) -> VerificationReport:
    """Verify the named documents, or every document with candidates."""
    require(ctx, f"{DOMAIN}:write")
    define_bills_types(ctx)
    targets = document_ids if document_ids is not None else _documents_with_candidates(ctx)
    report = VerificationReport()
    for document_id in targets:
        report.documents += 1
        try:
            verdict = verify_document(ctx, document_id)
        except Exception as exc:
            # Counted and visible, never silent — and by class name only: a
            # message here is built from the values being compared, and those
            # came from a bill (the C1/C2 precedent).
            log.warning("document %s: verification failed: %s", document_id, type(exc).__name__)
            report.errors += 1
            continue
        report.subjects += verdict.subjects
        report.verified += verdict.verified
        report.promoted += verdict.promoted
        report.demoted += verdict.demoted
        report.invalid += verdict.invalid
        if verdict.receipt_id is not None:
            report.produced.append(verdict.receipt_id)
    return report


class BillForgetResult(ForgetResult):
    """A `ForgetResult` that also accounts for the receipts, so a caller can see
    that the numbers derived from the erased record went with it."""

    receipts_redacted: int


def is_bill_record(ctx: AccessContext, entity_id: UUID) -> bool:
    """Whether this entity is one of the candidates a receipt derives numbers
    from — the erasure route's dispatch test."""
    return bool(set(services.get_entity(ctx, entity_id).types) & {TYPE_BILL, TYPE_EOB})


def _citing_receipts(ctx: AccessContext, entity_id: UUID) -> list[UUID]:
    """Every verification receipt that named this candidate."""
    return [
        receipt.id
        for receipt in services.find(ctx, type_name=TYPE_VERIFICATION)
        if str(entity_id) in (receipt.attributes.get("subject_ids") or [])
    ]


def forget_bill(
    ctx: AccessContext,
    entity_id: UUID,
    fields: list[str] | None = None,
    actor: str = DEFAULT_ACTOR,
) -> BillForgetResult:
    """Erase a candidate **and the numbers its receipts derived from it**.

    `forget()` is strictly per-entity and strips only the fields flagged on the
    entity it is given. A `verification_receipt` is a different entity, so
    erasing a bill left its deltas sitting in the receipt's live state *and* in
    every event payload the receipt ever had — permanently, since `verify` is an
    operator-run job and nothing schedules the re-run that would have scrubbed
    them. And a delta is not a safe residue: when one operand is zero it equals
    the other, so a bill with `total: 0` and one line item leaves the line's
    exact amount behind.

    So the cascade is synchronous and runs **first**, before the candidate's own
    redaction: over-erasing a receipt is the safe direction, and a failure
    part-way must not leave the derived numbers as the only survivors. Write
    scope is required before either (the C1 precedent).

    Deliberately not conditional on *which* fields are being erased. `checks` is
    derived from the candidate as a whole, and working out which delta came from
    which attribute is exactly the kind of cleverness an erasure path must not
    have.
    """
    require(ctx, f"{DOMAIN}:write")
    redacted = 0
    for receipt_id in _citing_receipts(ctx, entity_id):
        if "checks" in services.get_entity(ctx, receipt_id).entity.attributes:
            services.forget(ctx, receipt_id, fields=["checks"], actor=actor)
            redacted += 1
    result = services.forget(ctx, entity_id, fields=fields, actor=actor)
    return BillForgetResult(**result.model_dump(), receipts_redacted=redacted)


class PromotionRefused(ValueError):
    """A direct capture tried to write, overwrite, or forge the evidence behind
    a verified record."""


# The records this cell will not accept from the generic capture route at all:
# the evidence a promotion rests on, and the audit record of PHI leaving the box.
# Both are written in-process by the job that performed the thing they attest to,
# so a hand-written one is a forged attestation rather than a correction, and
# neither has a legitimate route caller.
UNWRITABLE_TYPES = (TYPE_VERIFICATION, TYPE_EXTRACTION)

# Identity field name -> the type that owns it. Entity resolution matches on the
# identity field *name* across every type declaring it, so carrying one of these
# values is exactly what makes a capture land on that record, whatever type the
# payload claims to be.
OWNED_KEYS = {
    KEY_FIELDS[TYPE_BILL]: TYPE_BILL,
    KEY_FIELDS[TYPE_EOB]: TYPE_EOB,
    "verification_key": TYPE_VERIFICATION,
    "extraction_key": TYPE_EXTRACTION,
}


def guard_capture(ctx: AccessContext, type_name: str, attributes: dict[str, Any]) -> None:
    """Refuse a `POST /capture` that would promote a candidate by hand.

    `"verified"` has to be a real value of `status` for the verifier to write
    it, which means the generic capture route can express it too — and the
    owner context holds every scope. So the door gets a lock.

    **The lock is on the record the capture would land on, not on the type name
    it claims.** The first version of this guard keyed on `type_name` and was
    bypassable in one call: `ExactIdentityResolver` matches on the identity
    field *name* across every type that declares it, and `capture` validates the
    *incoming* payload against the *incoming* type's schema and then merges into
    whatever it matched. So a fresh type declaring `x-identity: ["bill_key"]`
    could carry a real bill's key plus `status: "verified"`, sail past a
    name-based guard, never meet `BILL_SCHEMA`'s `verified`-cites-its-receipt
    rule, and write `verified` onto the real bill with no receipt at all.

    Resolution can only reach a record through an identity field the record's
    own type declares, so the complete rule is: **a payload carrying one of this
    cell's identity keys must be a capture of the type that owns it.** That
    covers every route by which a foreign type could merge into a bill, an EOB,
    a receipt or an extraction record, without needing to re-run the resolver.

    Stated honestly, because this is still a mitigation rather than a guarantee:
    it covers the external door. In-process code holding `bills:write` can call
    `services.capture` directly — that is inside the trust boundary (ADR 003) —
    and what covers that is the demotion pass, which re-judges every promoted
    record on every run.
    """
    for key_field, owner in OWNED_KEYS.items():
        if key_field in attributes and type_name != owner:
            raise PromotionRefused(
                f"'{key_field}' is the identity field of '{owner}'; a capture of "
                f"'{type_name}' carrying it would merge into that record"
            )
    if type_name in UNWRITABLE_TYPES:
        raise PromotionRefused(
            f"'{type_name}' records are written by the job that performed what they "
            "attest to, never by a direct capture"
        )
    if type_name not in KEY_FIELDS:
        return
    if attributes.get("status") == STATUS_VERIFIED:
        raise PromotionRefused(
            "status 'verified' is written by the reconciliation verifier "
            "(python -m domains.bills.verify), never by a direct capture"
        )
    key = attributes.get(KEY_FIELDS[type_name])
    if not isinstance(key, str):
        return
    existing = services.find(ctx, type_name=type_name, filters={KEY_FIELDS[type_name]: key})
    if existing and existing[0].attributes.get("status") == STATUS_VERIFIED:
        raise PromotionRefused(
            "this record is verified; change it by re-running the reconciliation "
            "verifier, not by capture"
        )


def verification_context() -> AccessContext:
    """Exactly the scopes verification needs — and notably NOT `documents:read`:
    this job judges candidates already in the graph and never opens the document
    they came from. `ops` is its execution receipt and nothing else (ADR 014)."""
    return AccessContext.of("bills:read", "bills:write", "ops:read", "ops:write")


# The execution receipt lives in `ops`, which is deliberately NOT sensitive, so
# the briefing and "did the cron run?" keep working. "verified=3" is a fact
# about the owner's medical records, so it does not go here (the C2 precedent):
# the receipt carries its name, its status and a pointer, the detail lives in
# the `verification_receipt` records inside the withheld `bills` domain, and the
# full line still goes to stdout, which is the operator's own terminal.
RECEIPT_SUMMARY = "results are in the verification_receipt records (bills domain)"


def _job(ctx: AccessContext, document_ids: list[UUID] | None) -> JobResult:
    for name in define_bills_types(ctx):
        print(f"defined type {name} (domain: {DOMAIN})")
    report = run_verification(ctx, document_ids=document_ids)
    print(report.line())
    return JobResult(
        status=STATUS_OK if report.ok else STATUS_FAILED,
        summary=RECEIPT_SUMMARY,
        produced=[],
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        document_ids = [UUID(arg) for arg in args] or None
    except ValueError:
        print("usage: python -m domains.bills.verify [document_id ...]", file=sys.stderr)
        return 2
    return run_job(verification_context(), JOB, lambda ctx: _job(ctx, document_ids))


if __name__ == "__main__":
    raise SystemExit(main())
