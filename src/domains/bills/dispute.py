"""Approval-gated dispute drafts: a failed verification -> a PROPOSED draft ->
an explicit human approval -> an on-screen draft (ADR 018, roadmap C4).

This is the first outward-facing action in the system, and the point of the
slice is that it cannot act on its own.

**Nothing is sent, and nothing here could send.** There is no SMTP client, no
HTTP client, no socket, no outbound anything in this module or anywhere below
it. The terminal state is `emit_draft`, which returns text for a screen. The
`authority_receipt` type cannot even express a different destination: its
`channel` and `permits` are one-member enums (`on_screen` / `display_draft`),
the same trick C2 used to make `"verified"` inexpressible until C3 could earn
it. Adding a second channel is a schema change, a migration and an ADR.

**Lethal-trifecta check (invariant 8).** The leg this whole path lacks is (b)
external communication. The draft generator has (c) writes and narrow reads
(`bills` alone — not the person spine, not calendar, not documents); the gate
has neither writes nor external communication; the approval route has the
consequential write but only under the owner's own unrestricted session, naming
one proposal and echoing the exact draft digest it read. A generator that could
also send would combine the legs, so the two are kept in different functions
with different scopes and no transport between them.

**`emit_draft` is the only function that hands a draft out, and that claim is
load-bearing.** `proposal_view` renders the same bytes, so it does so only while
a proposal is `proposed` — the state where reading is a prerequisite to
deciding, and the one state no proposal ever returns to. Everything already
decided goes through the gate, which checks the grant's own constraints rather
than trusting that they can only have one value.

**The draft body is never stored.** A dispute letter names the provider, the
account and the amounts — free text that in `entity.attributes` would be
tsvector-indexed and erasable only per entity (the binding B1/C1/C2 finding,
ADR 015/016). So `action_proposal` holds ids, check names and counts, and
`render_draft` composes the letter on demand from the records it cites. Erasing
a candidate empties the draft by construction, not by a cascade someone has to
remember to run — and the approval binds to a sha256 of the exact text the
human read, so a draft whose facts have changed since is refused rather than
quietly emitted with new numbers in it.

**A check that could not run is never quoted at a third party.** Only failures
from `DISPUTABLE_CHECKS` — where the document disagrees with itself — become
points. Everything else that did not pass is counted in `unresolved_count` and
named in the draft itself, so an approver cannot mistake "my records could not
read this" for "you overcharged me" (the C3 precedent, pointed outward).

Runs as ``python -m domains.bills.dispute [document_id ...]`` under a
code-built AccessContext of exactly `bills:read`/`write` + `ops:read`/`write` —
the same narrow set the verifier uses. Every run leaves an execution receipt
and only ``ok`` exits 0 (ADR 014).
"""

import logging
import re
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any, NoReturn
from uuid import UUID

from pydantic import BaseModel

from domains.bills.types import (
    ACT_DISPLAY_DRAFT,
    CHANNEL_ON_SCREEN,
    CHECK_BILL_EOB_PATIENT_RESP,
    CHECK_EOB_ALLOWED_WITHIN_BILLED,
    CHECK_EOB_AMOUNTS_NON_NEGATIVE,
    CHECK_EOB_LINE_SPLIT,
    CHECK_LINE_ITEMS_SUM,
    CHECK_NO_DUPLICATE_LINES,
    DISPUTABLE_CHECKS,
    DOMAIN,
    GRANT_VIAS,
    KIND_DISPUTE_DRAFT,
    MAX_IDS,
    MAX_POINTS,
    PRINCIPAL_PATTERN,
    RESULT_FAIL,
    RESULT_PASS,
    STATE_APPROVED,
    STATE_PROPOSED,
    STATE_REJECTED,
    STATE_WITHDRAWN,
    TYPE_AUTHORITY,
    TYPE_BILL,
    TYPE_EOB,
    TYPE_PROPOSAL,
    TYPE_VERIFICATION,
    define_bills_types,
)

# `_money` is private to the module but not to the cell: a draft must compare
# and print amounts by exactly the rule the verifier judged them by (Decimal,
# quantized, never float — ADR 017), and a second implementation of that here
# would be a second answer to the same question.
from domains.bills.verify import Subject, _money
from domains.ops.receipts import STATUS_FAILED, STATUS_OK, JobResult, run_job
from kernel import services
from kernel.access import ALL_SCOPES, AccessContext, require
from kernel.events import DEFAULT_ACTOR
from kernel.models import Entity

log = logging.getLogger("lifeos.bills")

METHOD = "dispute_draft_proposal"
JOB = "domains.bills.dispute"

# How long an approval stays good. An approval says "yes, this text, now" —
# after a week the underlying statement should be re-checked before anyone acts
# on it, and re-approving is one request. Not configurable: the length of a
# grant is a decision, not an operator knob.
AUTHORITY_TTL = timedelta(days=7)

# What a rendered draft says where a value is absent — never captured by the
# extractor, or erased since. One marker for both, because the draft cannot
# tell them apart and guessing which is exactly the cleverness this path must
# not have. A draft full of these is a draft that should not be approved.
UNAVAILABLE = "[unavailable]"

# The approving principal, held to the same bound the schema carries. The domain
# does not trust the interface to have bounded what it passes in.
_PRINCIPAL = re.compile(PRINCIPAL_PATTERN)


# --- rendering: the draft exists only while it is being read ----------------


def _text(value: Any) -> str:
    return value if isinstance(value, str) and value else UNAVAILABLE


def _amount(raw: Any) -> str:
    """An amount for human eyes. Decimal, never float (the ADR 017 rule)."""
    value = _money(raw)
    return f"{value:.2f}" if value is not None else UNAVAILABLE


def _line(subject: Subject | None, index: int | None) -> dict[str, Any]:
    """One line item of a subject, or an empty one. Total by construction: a
    draft must render whatever state it finds rather than raise at read time."""
    if subject is None or index is None:
        return {}
    items = subject.attributes.get("line_items")
    if isinstance(items, list) and 0 <= index < len(items) and isinstance(items[index], dict):
        found: dict[str, Any] = items[index]
        return found
    return {}


def _line_label(subject: Subject | None, index: int | None) -> str:
    """ "Line 3 (code 99213)" — 1-based, because a letter is read by a person.

    An index the receipt did not record renders as `[unavailable]` rather than
    as a line number nobody can look up. Every failing check that names a line
    carries one, so this is the defensive branch, not the usual one.
    """
    code = _text(_line(subject, index).get("code"))
    position = str(index + 1) if index is not None else UNAVAILABLE
    return f"Line {position} (code {code})"


def _eob_share(subjects: dict[UUID, Subject], bill: Subject | None) -> str:
    """What the EOBs beside this bill say the patient owes, summed."""
    service_date = bill.attributes.get("service_date") if bill else None
    shares = [
        _money(item.get("patient_resp"))
        for subject in subjects.values()
        if subject.type_name == TYPE_EOB and subject.attributes.get("service_date") == service_date
        for item in subject.attributes.get("line_items") or []
        if isinstance(item, dict)
    ]
    present = [s for s in shares if s is not None]
    if not present or len(present) != len(shares):
        return UNAVAILABLE
    return f"{sum(present):.2f}"


def _sentence(point: dict[str, Any], subjects: dict[UUID, Subject]) -> str:
    """One discrepancy, in the words an addressee can act on.

    The numbers come from the candidates *at render time*. That is the whole
    storage decision in one line: a receipt may never quote a value from a
    document (ADR 017) and neither may a stored proposal, but the draft a human
    is about to read has to, or it is not a dispute letter.
    """
    check = point.get("check")
    subject = _lookup(subjects, point.get("subject_id"))
    index = point.get("line_index") if isinstance(point.get("line_index"), int) else None
    attributes = subject.attributes if subject else {}
    item = _line(subject, index)

    if check == CHECK_LINE_ITEMS_SUM:
        items = attributes.get("line_items")
        amounts = (
            [_money(i.get("amount")) for i in items if isinstance(i, dict)]
            if isinstance(items, list)
            else []
        )
        listed = (
            f"{sum(a for a in amounts if a is not None):.2f}"
            if amounts and all(a is not None for a in amounts)
            else UNAVAILABLE
        )
        return (
            f"The charges listed add up to {listed}, but the amount asked for is "
            f"{_amount(attributes.get('total'))}."
        )
    if check == CHECK_EOB_LINE_SPLIT:
        return (
            f"{_line_label(subject, index)}: the plan paid {_amount(item.get('plan_paid'))} and my "
            f"share is given as {_amount(item.get('patient_resp'))}, which do not add up to the "
            f"allowed amount of {_amount(item.get('allowed'))}."
        )
    if check == CHECK_EOB_ALLOWED_WITHIN_BILLED:
        return (
            f"{_line_label(subject, index)}: the allowed amount {_amount(item.get('allowed'))} is "
            f"greater than the amount billed, {_amount(item.get('billed'))}."
        )
    if check == CHECK_EOB_AMOUNTS_NON_NEGATIVE:
        return f"{_line_label(subject, index)} carries a negative amount."
    if check == CHECK_NO_DUPLICATE_LINES:
        return f"{_line_label(subject, index)} appears more than once."
    if check == CHECK_BILL_EOB_PATIENT_RESP:
        return (
            f"The explanation of benefits for this service puts my share at "
            f"{_eob_share(subjects, subject)}, but this statement asks for "
            f"{_amount(attributes.get('total'))}."
        )
    # Unreachable while `points` is bounded to DISPUTABLE_CHECKS by the schema.
    # Said out loud rather than silently skipped: an unnamed discrepancy in a
    # letter to a third party is worse than no letter.
    return f"An unrecognised discrepancy ({_text(check)}) was recorded against this statement."


PREAMBLE = (
    "DRAFT - NOT SENT\n"
    "lifeos prepared this from a failed reconciliation and cannot send it: no\n"
    "component of this system has an outbound channel. Approving it authorises\n"
    "exactly one thing - showing you this text."
)


def render_draft(ctx: AccessContext, attributes: dict[str, Any]) -> str:
    """Compose one proposal's draft letter from the records it cites.

    Deterministic: the same graph state renders the same bytes, which is what
    lets an approval bind to a digest. Nothing in the body is dated by the
    clock — a body carrying "today" would change its own digest overnight and
    revoke every approval at midnight.
    """
    subjects = _subjects(ctx, attributes.get("subject_ids") or [])
    ordered = _ordered(subjects)
    bill = next((s for s in ordered if s.type_name == TYPE_BILL), None)
    eob = next((s for s in ordered if s.type_name == TYPE_EOB), None)
    addressee = (
        _text(bill.attributes.get("issuer"))
        if bill
        else _text(eob.attributes.get("payer"))
        if eob
        else UNAVAILABLE
    )
    header = bill or eob
    reference = (
        _text(header.attributes.get("account_ref") or header.attributes.get("claim_no"))
        if header
        else UNAVAILABLE
    )
    service_date = _text(header.attributes.get("service_date")) if header else UNAVAILABLE
    # Every cited candidate's currency, in the body and therefore inside the
    # digest: a letter quoting bare "140.00" to a third party is ambiguous, and
    # a currency that changed after the approval must invalidate it exactly as
    # a changed amount does.
    currencies = sorted(
        {s.attributes["currency"] for s in ordered if isinstance(s.attributes.get("currency"), str)}
    )
    currency = ", ".join(currencies) if currencies else UNAVAILABLE

    points = attributes.get("points") or []
    lines = [f"  {n}. {_sentence(p, subjects)}" for n, p in enumerate(points, start=1)]
    unresolved = attributes.get("unresolved_count")
    note = (
        f"\nA further {unresolved} check(s) on this statement did not pass but are not\n"
        "stated above: they may reflect what my own records could not read rather\n"
        "than an error on your part.\n"
        if isinstance(unresolved, int) and unresolved > 0
        else ""
    )
    return "\n".join(
        [
            PREAMBLE,
            "",
            f"To: {addressee}",
            f"Reference: {reference}",
            f"Service date: {service_date}",
            f"Currency: {currency}",
            "",
            "To whom it may concern,",
            "",
            "I am writing about the statement above. Reconciling it against my own",
            "records did not come out even:",
            "",
            *lines,
            note,
            "Please review these items and send me a corrected statement, or an",
            "explanation of each one.",
            "",
            f"Prepared from lifeos verification receipt "
            f"{_text(attributes.get('verification_receipt_id'))}.",
        ]
    )


def digest_of(body: str) -> str:
    """sha256 over the exact text a human read. This is what an approval binds
    to, and what the gate re-checks before it emits anything."""
    return sha256(body.encode()).hexdigest()


def _uuid(raw: Any) -> UUID | None:
    if not isinstance(raw, str):
        return None
    try:
        return UUID(raw)
    except ValueError:
        return None


def _subjects(ctx: AccessContext, ids: list[Any]) -> dict[UUID, Subject]:
    """The candidates a proposal concerns, as they are right now.

    A subject that no longer resolves is simply absent, and the renderer shows
    `[unavailable]` for what it held — which changes the digest, which is what
    makes an approval stop authorising anything.
    """
    subjects: dict[UUID, Subject] = {}
    for raw in ids[:MAX_IDS]:
        entity_id = _uuid(raw)
        if entity_id is None:
            continue
        try:
            view = services.get_entity(ctx, entity_id)
        except LookupError:
            continue
        type_name = next((t for t in view.types if t in (TYPE_BILL, TYPE_EOB)), None)
        if type_name is not None:
            subjects[entity_id] = Subject(entity_id, type_name, view.entity.attributes)
    return subjects


def _lookup(subjects: dict[UUID, Subject], raw: Any) -> Subject | None:
    entity_id = _uuid(raw)
    return subjects.get(entity_id) if entity_id is not None else None


def _ordered(subjects: dict[UUID, Subject]) -> list[Subject]:
    """Stable order, so the rendered bytes do not depend on read order."""
    return [subjects[key] for key in sorted(subjects)]


# --- generating proposals from failed verification receipts -----------------


def _point_key(check: dict[str, Any]) -> tuple[str, str, int]:
    index = check.get("line_index")
    return (
        str(check.get("check")),
        str(check.get("subject_id")),
        index if isinstance(index, int) else -1,
    )


def points_for(
    checks: list[dict[str, Any]], subjects: dict[UUID, Subject]
) -> tuple[list[dict[str, Any]], int]:
    """The disputable failures, and how many other verdicts did not pass.

    Only `RESULT_FAIL` on a `DISPUTABLE_CHECKS` member becomes a point. An
    `unchecked` verdict never does: "my records could not check this" is not an
    accusation, and turning one into a letter is the C3 finding pointed at a
    third party.

    The bill/EOB cross-check is recorded against BOTH records (ADR 017), which
    is one discrepancy wearing two verdicts. The EOB's side is dropped before
    anything is counted — not just before it is stated — or the draft would say
    the disagreement once and then claim a further unstated check on top of it.
    """

    def is_cross_check(check: dict[str, Any]) -> bool:
        return check.get("check") == CHECK_BILL_EOB_PATIENT_RESP

    def names_a_bill(check: dict[str, Any]) -> bool:
        subject = _lookup(subjects, check.get("subject_id"))
        return subject is not None and subject.type_name == TYPE_BILL

    not_passed = [c for c in checks if c.get("result") != RESULT_PASS]
    stated_from_the_bill = any(names_a_bill(c) for c in not_passed if is_cross_check(c))
    findings = [
        c
        for c in sorted(not_passed, key=_point_key)
        if not (stated_from_the_bill and is_cross_check(c) and not names_a_bill(c))
    ]

    points: list[dict[str, Any]] = []
    for check in findings:
        name = check.get("check")
        subject = _lookup(subjects, check.get("subject_id"))
        if check.get("result") != RESULT_FAIL or name not in DISPUTABLE_CHECKS or subject is None:
            continue
        point: dict[str, Any] = {"check": name, "subject_id": str(subject.entity_id)}
        if isinstance(check.get("line_index"), int):
            point["line_index"] = check["line_index"]
        points.append(point)
    points = points[:MAX_POINTS]
    # Counted after the cap, so a truncated draft still accounts for everything
    # it is not stating.
    return points, len(findings) - len(points)


@dataclass
class ProposalReport:
    receipts: int = 0
    proposed: int = 0
    withdrawn: int = 0
    # Left exactly as they are: an approved proposal must never have its points
    # rewritten under the approval, and a rejected one must never be resurrected.
    held: int = 0
    # The receipt failed, but nothing it recorded is disputable — every failure
    # was about what this system could not read. Said out loud, not silent.
    undisputable: int = 0
    # The receipt's verdicts are erased or knowingly partial (`checks_truncated`),
    # so why it failed is no longer fully knowable and no honest letter follows.
    unreadable: int = 0
    errors: int = 0
    produced: list[UUID] = field(default_factory=list)

    def line(self) -> str:
        return (
            f"dispute drafts: receipts={self.receipts} proposed={self.proposed} "
            f"withdrawn={self.withdrawn} held={self.held} "
            f"undisputable={self.undisputable} unreadable={self.unreadable} "
            f"errors={self.errors}"
        )

    @property
    def ok(self) -> bool:
        return not self.errors


def proposal_key(receipt_id: UUID, kind: str) -> str:
    """One proposal per receipt per kind, so a re-run supersedes rather than
    piling up drafts and the earlier proposal stays in history (invariant 3)."""
    return sha256(f"{receipt_id}|{kind}".encode()).hexdigest()


def _existing(ctx: AccessContext, key: str) -> tuple[UUID, dict[str, Any]] | None:
    found = services.find(ctx, type_name=TYPE_PROPOSAL, filters={"proposal_key": key})
    return (found[0].id, found[0].attributes) if found else None


def _withdraw(ctx: AccessContext, entity_id: UUID, attributes: dict[str, Any]) -> bool:
    """Take back a proposal whose basis no longer supports it.

    The ADR 017 layer-3 analogue: nothing stays granted on the strength of an
    old ruling. An approved proposal is withdrawn too — the authority receipt
    stays in history as the record that a human once said yes, and the gate
    refuses because the proposal is no longer approved.
    """
    if attributes.get("state") not in (STATE_PROPOSED, STATE_APPROVED):
        return False
    services.capture(
        ctx,
        TYPE_PROPOSAL,
        {**attributes, "state": STATE_WITHDRAWN, "decided_at": datetime.now(UTC).isoformat()},
        actor=JOB,
    )
    return True


def propose_for_receipt(
    ctx: AccessContext, receipt_id: UUID, report: ProposalReport
) -> UUID | None:
    """Rule on one verification receipt: propose, refresh, withdraw or hold."""
    receipt = services.get_entity(ctx, receipt_id).entity.attributes
    key = proposal_key(receipt_id, KIND_DISPUTE_DRAFT)
    existing = _existing(ctx, key)
    subjects = _subjects(ctx, receipt.get("subject_ids") or [])
    raw_checks = receipt.get("checks")

    if receipt.get("passed") is not True and (
        raw_checks is None or receipt.get("checks_truncated") is True
    ):
        # Two ways the verdict detail is not all there, and both mean the same
        # thing: why this document failed is no longer fully knowable, so no
        # draft can honestly be built from it.
        #
        # `checks is None` — the detail was erased (it is `x-pii`).
        # `checks_truncated` — the run recorded more than MAX_CHECKS verdicts
        # and stored only the first slice (ADR 017), which promotes nothing.
        # Building a letter from the surviving slice would state some
        # discrepancies to a provider and then claim, with a number, to have
        # accounted for the rest — an outward-facing accusation assembled from a
        # knowingly partial record. That is the same silence-as-pass shape the
        # C3 finding is about, so it is counted and printed, never inferred past.
        report.unreadable += 1
        return None
    checks = [c for c in raw_checks or [] if isinstance(c, dict)]
    points, unresolved = points_for(checks, subjects)

    if receipt.get("passed") is True or not points:
        if receipt.get("passed") is not True and not points:
            report.undisputable += 1
        if existing and _withdraw(ctx, *existing):
            report.withdrawn += 1
        return None

    if existing and existing[1].get("state") != STATE_PROPOSED:
        report.held += 1
        return existing[0]

    attributes: dict[str, Any] = {
        "proposal_key": key,
        "kind": KIND_DISPUTE_DRAFT,
        "state": STATE_PROPOSED,
        "document_id": str(receipt.get("document_id")),
        "verification_receipt_id": str(receipt_id),
        "subject_ids": sorted(str(s) for s in subjects),
        "points": points,
        "unresolved_count": unresolved,
        "proposed_at": datetime.now(UTC).isoformat(),
        "provenance": {
            "source_entity_ids": [str(receipt_id)]
            + sorted(str(s) for s in subjects)[: MAX_IDS - 1],
            "source_event_ids": _receipt_event_ids(ctx, receipt_id),
            "method": METHOD,
            # Deterministic re-reading of a receipt this process read directly;
            # no model anywhere in the path (ADR 010/017).
            "confidence": 1.0,
        },
    }
    if existing:
        stored = existing[1]
        if all(stored.get(k) == v for k, v in attributes.items() if k != "proposed_at"):
            return existing[0]  # unchanged: emit no event (the ADR 014 precedent)
    report.proposed += 1
    return services.capture(ctx, TYPE_PROPOSAL, attributes, actor=JOB).entity_id


def _receipt_event_ids(ctx: AccessContext, receipt_id: UUID) -> list[str]:
    events = [e for e in services.history(ctx, receipt_id) if e.actor != JOB]
    return [str(events[-1].id)] if events else []


def _failed_receipts(ctx: AccessContext, document_ids: list[UUID] | None) -> list[UUID]:
    """Every verification receipt, or those for the named documents.

    Passing receipts are included on purpose: a document that now reconciles
    must be able to withdraw the draft it used to justify.
    """
    wanted = {str(d) for d in document_ids} if document_ids is not None else None
    return [
        receipt.id
        for receipt in services.find(ctx, type_name=TYPE_VERIFICATION)
        if wanted is None or receipt.attributes.get("document_id") in wanted
    ]


def generate_proposals(
    ctx: AccessContext, document_ids: list[UUID] | None = None
) -> ProposalReport:
    """Propose a dispute draft for every verification receipt that failed.

    Write scope is required **first**, before anything is read (the C1 HIGH
    precedent). This writes proposals only — a proposal authorises nothing on
    its own, which is why this job is allowed to run unattended and the
    approval that follows it is not.
    """
    require(ctx, f"{DOMAIN}:write")
    define_bills_types(ctx)
    report = ProposalReport()
    for receipt_id in _failed_receipts(ctx, document_ids):
        report.receipts += 1
        try:
            produced = propose_for_receipt(ctx, receipt_id, report)
        except Exception as exc:
            # Class name only: a message here is built from the values being
            # rendered, and those came from a bill (the C1/C2/C3 precedent).
            log.warning("receipt %s: proposal failed: %s", receipt_id, type(exc).__name__)
            report.errors += 1
            continue
        if produced is not None:
            report.produced.append(produced)
    return report


# --- the human decision, and the artifact it mints --------------------------


class ProposalStateError(ValueError):
    """This transition is not available from the state the proposal is in."""


class AuthorityRefused(ValueError):
    """No valid, matching, unexpired authority covers this act."""


class DraftChanged(AuthorityRefused):
    """The draft is not the text that was approved."""


class ApprovalRefused(AuthorityRefused):
    """This context may not mint authority, whatever scopes it holds."""


class ProposalView(BaseModel):
    """One proposal as a reviewer sees it.

    `body` and `draft_digest` are present **only while the proposal is
    `proposed`**, and that is a security property rather than an optimisation.
    Rendering a draft is exactly the act an `authority_receipt` grants
    (`permits: ["display_draft"], channel: "on_screen"`), so a listing that
    returned the body in every state would be an ungated twin of `emit_draft`:
    approve, let the grant lapse, and the gate would 403 while the listing
    served the same bytes at 200. Every row of ADR 018's refusal table would be
    defeated by the adjacent route.

    Reading is a prerequisite to deciding, so a `proposed` draft is readable —
    an approver cannot approve text they may not see. Once decided it is
    reachable only through `emit_draft`, and no state transition ever returns a
    proposal to `proposed` (`propose_for_receipt` holds anything already
    decided), so a lapsed grant can never fall back into the readable state.
    """

    proposal_id: UUID
    kind: str
    state: str
    subject_ids: list[UUID]
    verification_receipt_id: UUID | None = None
    points: list[dict[str, Any]] = []
    unresolved_count: int = 0
    authority_receipt_id: UUID | None = None
    body: str | None = None
    draft_digest: str | None = None


class DecisionResult(BaseModel):
    proposal_id: UUID
    state: str
    authority_receipt_id: UUID | None = None
    expires_at: str | None = None


class EmittedDraft(BaseModel):
    """The terminal artifact of this slice: an approved draft, on a screen.

    `channel` can only ever be `on_screen` and `permits` only `display_draft` —
    the types have no other members. This model is what a transmitting slice
    would have to change, and changing it is meant to be visible.
    """

    proposal_id: UUID
    authority_receipt_id: UUID
    channel: str
    permits: list[str]
    expires_at: str
    body: str


def _load(ctx: AccessContext, entity_id: UUID, type_name: str) -> dict[str, Any]:
    view = services.get_entity(ctx, entity_id)
    if type_name not in view.types:
        raise ValueError(f"entity {entity_id} is not a {type_name}")
    return view.entity.attributes


def proposal_view(ctx: AccessContext, entity: Entity) -> ProposalView:
    """One proposal as a reviewer sees it.

    The draft is rendered only for a `proposed` proposal — see `ProposalView`.
    For anything already decided the letter comes from `emit_draft` or not at
    all, so that `emit_draft` really is the one function that hands a draft out.
    """
    attributes = entity.attributes
    state = str(attributes.get("state"))
    body = render_draft(ctx, attributes) if state == STATE_PROPOSED else None
    return ProposalView(
        proposal_id=entity.id,
        kind=str(attributes.get("kind")),
        state=state,
        subject_ids=[u for u in (_uuid(s) for s in attributes.get("subject_ids") or []) if u],
        verification_receipt_id=_uuid(attributes.get("verification_receipt_id")),
        points=[p for p in attributes.get("points") or [] if isinstance(p, dict)],
        unresolved_count=int(attributes.get("unresolved_count") or 0),
        authority_receipt_id=_uuid(attributes.get("authority_receipt_id")),
        body=body,
        draft_digest=digest_of(body) if body is not None else None,
    )


def list_proposals(ctx: AccessContext, state: str | None = None) -> list[ProposalView]:
    """Every proposal, or those in one state. A read: it writes nothing, and an
    approval is never a side effect of looking at one."""
    filters = {"state": state} if state else None
    return [
        proposal_view(ctx, entity)
        for entity in services.find(ctx, type_name=TYPE_PROPOSAL, filters=filters)
    ]


def approve_proposal(
    ctx: AccessContext,
    proposal_id: UUID,
    expected_digest: str,
    granted_by: str,
    granted_via: str,
    actor: str = DEFAULT_ACTOR,
) -> DecisionResult:
    """Mint the authority receipt for one proposal. The only thing that does.

    Four properties this is built for:

    - **Explicit.** It is its own call, reachable only from `POST .../approve`,
      and it refuses unless the caller echoes back the sha256 of the exact
      draft it read. Reading a proposal cannot approve it, and approving one
      cannot be done without having read it.
    - **Made by the owner in person.** An authority receipt is the system's
      only artifact distinguishing a human decision from an automated one, so
      it may be minted only under the owner's own unrestricted session. A
      context carrying an explicit scope set is refused outright — that is the
      shape a token takes (`api.auth._context_from` narrows on a `scopes`
      claim, "the same path future agent tokens take"), and a credential that
      names its own powers is a credential, not a person. Holding
      `bills:write` is necessary and deliberately not sufficient. `granted_via`
      then records how the subject was established, because "the environment
      said so" is a weaker claim than "a verified session said so" and the
      record should not blur them.
    - **Not forgeable.** `authority_receipt` and `action_proposal` are both
      refused by `verify.guard_capture`, so neither can be written through
      `POST /capture` at all; `proposal_key` is in that guard's owned-keys map,
      so no foreign type can merge into a proposal either. The schema then
      binds `state: "approved"` to the authority id, so an approval that names
      no authority does not validate.
    - **Checked before it acts.** Write scope is required first: minting
      authority is the consequential write in this path, and a `bills:read`
      credential must be turned away before it, not by a check that happens to
      run later inside `capture` (the C1 HIGH precedent).
    """
    require(ctx, f"{DOMAIN}:write")
    if ALL_SCOPES not in ctx.scopes:
        raise ApprovalRefused(
            "an approval is minted only under the owner's own unrestricted session; "
            "a scope-narrowed context may read a proposal but may not authorise one"
        )
    if not _PRINCIPAL.match(granted_by):
        raise ValueError("granted_by is not a bounded principal identifier")
    if granted_via not in GRANT_VIAS:
        raise ValueError(f"granted_via must be one of {GRANT_VIAS}")
    attributes = _load(ctx, proposal_id, TYPE_PROPOSAL)
    if attributes.get("state") != STATE_PROPOSED:
        raise ProposalStateError(
            f"proposal {proposal_id} is {attributes.get('state')}, not {STATE_PROPOSED}"
        )
    body = render_draft(ctx, attributes)
    digest = digest_of(body)
    if digest != expected_digest:
        raise DraftChanged(
            "this draft is not the text that was read; re-read the proposal and approve again"
        )

    now = datetime.now(UTC)
    expires_at = (now + AUTHORITY_TTL).isoformat()
    authority_id = services.capture(
        ctx,
        TYPE_AUTHORITY,
        {
            "proposal_id": str(proposal_id),
            "verification_receipt_id": str(attributes.get("verification_receipt_id")),
            "subject_ids": list(attributes.get("subject_ids") or []),
            "draft_digest": digest,
            "granted_by": granted_by,
            "granted_via": granted_via,
            "granted_at": now.isoformat(),
            "expires_at": expires_at,
            # The whole grant, and it is deliberately tiny.
            "permits": [ACT_DISPLAY_DRAFT],
            "channel": CHANNEL_ON_SCREEN,
            "provenance": {
                "source_entity_ids": [str(proposal_id)],
                "source_event_ids": [],
                "method": "human_approval",
                "confidence": 1.0,
            },
        },
        actor=actor,
    ).entity_id
    # Authority first: a failure part-way leaves an authority nothing cites,
    # which grants nothing, rather than an approved proposal with no authority.
    services.capture(
        ctx,
        TYPE_PROPOSAL,
        {
            **attributes,
            "state": STATE_APPROVED,
            "authority_receipt_id": str(authority_id),
            "decided_at": now.isoformat(),
        },
        actor=actor,
    )
    log.info("proposal %s approved; authority %s", proposal_id, authority_id)
    return DecisionResult(
        proposal_id=proposal_id,
        state=STATE_APPROVED,
        authority_receipt_id=authority_id,
        expires_at=expires_at,
    )


def reject_proposal(
    ctx: AccessContext, proposal_id: UUID, actor: str = DEFAULT_ACTOR
) -> DecisionResult:
    """Say no. Mints nothing: there is no authority in a refusal."""
    require(ctx, f"{DOMAIN}:write")
    attributes = _load(ctx, proposal_id, TYPE_PROPOSAL)
    if attributes.get("state") != STATE_PROPOSED:
        raise ProposalStateError(
            f"proposal {proposal_id} is {attributes.get('state')}, not {STATE_PROPOSED}"
        )
    services.capture(
        ctx,
        TYPE_PROPOSAL,
        {**attributes, "state": STATE_REJECTED, "decided_at": datetime.now(UTC).isoformat()},
        actor=actor,
    )
    return DecisionResult(proposal_id=proposal_id, state=STATE_REJECTED)


# --- the gate ---------------------------------------------------------------


def _refuse(proposal_id: UUID, reason: str, error: type[ValueError] = AuthorityRefused) -> NoReturn:
    # The reason is a constant this module wrote, never a value from a bill.
    log.warning("draft emission refused for proposal %s: %s", proposal_id, reason)
    raise error(reason)


def emit_draft(ctx: AccessContext, proposal_id: UUID) -> EmittedDraft:
    """Hand out an approved draft — the one step that would ever transmit.

    Today the only destination this system can express is a screen, and there
    is no code path to any other. The gate is built anyway, and built here
    rather than at the (non-existent) transport, because the check that matters
    is "did a human authorise *this text*", and that is knowable only where the
    draft is produced.

    Seven ways to be refused, each of them explicit and each of them recording
    nothing: the proposal is not approved; it cites no authority; the authority
    it cites was granted for a different proposal; the grant does not actually
    permit this act; it names a channel this system cannot serve; it has expired
    or carries an unusable expiry; or the draft no longer matches the digest
    that was approved — including the case where the digest itself was erased,
    which is a refusal and never a pass, because "we cannot check what was
    approved" must not read as "this was approved" (the C3 precedent).

    **The grant's own constraints are checked, not echoed.** The first version
    read `permits` and `channel` out of the receipt straight into the result and
    filtered an unrecognised permit to `[]`, so a receipt granting nothing
    emitted a draft anyway. That the enums have one member each is a write-time
    constraint; a gate that trusts it is a gate that stops working the moment
    `CHANNELS` gains a second member — which is exactly the change this ADR says
    must be safe to make.
    """
    attributes = _load(ctx, proposal_id, TYPE_PROPOSAL)
    if attributes.get("state") != STATE_APPROVED:
        _refuse(proposal_id, "proposal is not approved", ProposalStateError)
    authority_id = _uuid(attributes.get("authority_receipt_id"))
    if authority_id is None:
        _refuse(proposal_id, "approved proposal cites no authority receipt")
    authority = _load(ctx, authority_id, TYPE_AUTHORITY)

    if authority.get("proposal_id") != str(proposal_id):
        _refuse(proposal_id, "authority receipt was granted for a different proposal")
    permits = [p for p in authority.get("permits") or [] if isinstance(p, str)]
    if ACT_DISPLAY_DRAFT not in permits:
        _refuse(proposal_id, "authority receipt does not permit displaying this draft")
    if authority.get("channel") != CHANNEL_ON_SCREEN:
        # The only channel this system can serve. A grant naming another one is
        # refused rather than served on screen "because that is all we have":
        # the human agreed to a destination, and substituting a different one is
        # not ours to do.
        _refuse(proposal_id, "authority receipt names a channel this system cannot serve")
    expires_at = authority.get("expires_at")
    expiry = _instant(expires_at)
    if expiry is None or expiry <= datetime.now(UTC):
        _refuse(proposal_id, "authority receipt is expired or carries no usable expiry")
    granted = authority.get("draft_digest")
    body = render_draft(ctx, attributes)
    if not isinstance(granted, str) or granted != digest_of(body):
        _refuse(
            proposal_id,
            "the draft is not the text that was approved (or the approved digest was erased)",
            DraftChanged,
        )
    return EmittedDraft(
        proposal_id=proposal_id,
        authority_receipt_id=authority_id,
        # Checked above, not merely copied out: reaching here means the grant
        # named this channel and permitted this act.
        channel=CHANNEL_ON_SCREEN,
        permits=[ACT_DISPLAY_DRAFT],
        expires_at=str(expires_at),
        body=body,
    )


def _instant(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


# --- the CLI ----------------------------------------------------------------


def proposal_context() -> AccessContext:
    """Exactly what proposing needs: this domain, plus the execution receipt.
    No `documents:read` and no wider read of any kind — this job reads the
    verification receipts and the candidates they name, and nothing else."""
    return AccessContext.of("bills:read", "bills:write", "ops:read", "ops:write")


# `ops` stays model-readable so the briefing works, which makes it the wrong
# place for "2 disputed medical bills" (the C2/C3 precedent unchanged). The
# receipt carries its name, its status and a pointer; the counts and ids live in
# the `action_proposal` records inside the withheld `bills` domain, and the full
# line still goes to stdout, which is the operator's own terminal.
RECEIPT_SUMMARY = "proposals are in the action_proposal records (bills domain)"


def _job(ctx: AccessContext, document_ids: list[UUID] | None) -> JobResult:
    for name in define_bills_types(ctx):
        print(f"defined type {name} (domain: {DOMAIN})")
    report = generate_proposals(ctx, document_ids=document_ids)
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
        print("usage: python -m domains.bills.dispute [document_id ...]", file=sys.stderr)
        return 2
    return run_job(proposal_context(), JOB, lambda ctx: _job(ctx, document_ids))


if __name__ == "__main__":
    raise SystemExit(main())
