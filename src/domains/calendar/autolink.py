"""Zero-LLM auto-link: calendar attendees -> the person spine (ADR 013, roadmap B2).

Deterministic and exact. An attendee matches a person only when their emails
are equal after normalization; there is no fuzzy matching, no LLM, and display
names are never matched on. A single match emits an
``attendee -[is_person]-> person`` edge carrying the ADR 010 provenance
envelope; two or more candidates (or a candidate that contradicts an existing
link) emit a ``link_review`` item instead of a guess; no match emits nothing,
because a stranger on a calendar invite is not a defect.

Edges only: this pass never mutates attendee or person attributes, never
merges entities, and never deletes anything. One identity spine (invariant 4)
means an automated pass may point at the spine, never rewrite it.

Idempotent: an existing active ``is_person`` edge short-circuits the link, and
an open review item with the same candidates short-circuits the review — so a
re-run against unchanged data emits zero new events.

Runs as ``python -m domains.calendar.autolink`` on the same scheduler path as
ingestion, under a code-built AccessContext of exactly ``calendar:read`` +
``calendar:write`` + ``relationships:read`` + ``relationships:write`` — narrow
by construction; ``relate`` requires write on every domain the edge's
endpoints belong to, and agent tokens stay read-only (ADR 010/012).
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from domains.calendar.types import define_calendar_types
from kernel import services
from kernel.access import AccessContext

METHOD = "autolink.exact_email"
IS_PERSON = "is_person"

REASON_AMBIGUOUS = "ambiguous_email_match"
REASON_CONFLICT = "conflicting_existing_link"

# Dots and plus-tags are aliases of the same mailbox only at Google: gmail
# ignores both, and googlemail.com is the same mailbox as gmail.com. Everywhere
# else `a.b@host` and `ab@host` are different people's mailboxes, so applying
# the rule generally would fabricate matches. Any other provider's alias scheme
# is a new ADR, not a quiet addition here.
_GOOGLE_DOMAINS = {"gmail.com", "googlemail.com"}


def normalize_email(raw: str) -> str | None:
    """Canonical mailbox key, or None when the value is not an address."""
    local, at, domain = raw.strip().lower().rpartition("@")
    if not at or not local or not domain:
        return None
    if domain in _GOOGLE_DOMAINS:
        local = local.split("+", 1)[0].replace(".", "")
        domain = "gmail.com"
        if not local:
            return None
    return f"{local}@{domain}"


@dataclass
class AutolinkReport:
    """linked = edges emitted; ambiguous = review items opened or updated;
    skipped = everything that produced nothing (no candidate, already linked,
    already under review, no usable email)."""

    linked: int = 0
    ambiguous: int = 0
    skipped: int = 0

    def line(self) -> str:
        return f"autolink: linked={self.linked} ambiguous={self.ambiguous} skipped={self.skipped}"


def _person_index(ctx: AccessContext) -> dict[str, set[UUID]]:
    """Normalized email -> person ids. One read of the spine per run."""
    index: defaultdict[str, set[UUID]] = defaultdict(set)
    for person in services.find(ctx, type_name="person"):
        emails = person.attributes.get("emails")
        for value in emails if isinstance(emails, list) else []:
            if isinstance(value, str) and (key := normalize_email(value)):
                index[key].add(person.id)
    return dict(index)


def _open_review(
    ctx: AccessContext,
    attendee_id: UUID,
    candidates: list[UUID],
    reason: str,
    now: datetime,
    report: AutolinkReport,
) -> None:
    """Queue a human decision instead of guessing. IDs and a reason code only —
    never the attendee's email or name (see LINK_REVIEW_SCHEMA)."""
    candidate_ids = sorted(str(c) for c in candidates)
    review_key = f"{attendee_id}:{reason}"
    existing = services.find(ctx, type_name="link_review", filters={"review_key": review_key})
    if existing and existing[0].attributes.get("candidate_person_ids") == candidate_ids:
        report.skipped += 1  # same open question, already queued
        return
    services.capture(
        ctx,
        "link_review",
        {
            "review_key": review_key,
            "attendee_id": str(attendee_id),
            "candidate_person_ids": candidate_ids,
            "reason": reason,
            "method": METHOD,
            "detected_at": now.isoformat(),
        },
        actor=METHOD,
    )
    report.ambiguous += 1


def run_autolink(ctx: AccessContext) -> AutolinkReport:
    """Link every attendee that matches exactly one person; review the rest."""
    report = AutolinkReport()
    index = _person_index(ctx)
    now = datetime.now(UTC)

    for attendee in services.find(ctx, type_name="attendee"):
        email = attendee.attributes.get("email")
        key = normalize_email(email) if isinstance(email, str) else None
        candidates = index.get(key, set()) if key else set()
        if not candidates:
            report.skipped += 1  # a stranger (or an erased email) is not a defect
            continue

        view = services.get_entity(ctx, attendee.id)
        linked = {e.to_entity for e in view.edges_out if e.relation == IS_PERSON}
        if len(candidates) > 1:
            _open_review(ctx, attendee.id, sorted(candidates), REASON_AMBIGUOUS, now, report)
            continue
        (person_id,) = candidates
        if person_id in linked:
            report.skipped += 1  # already linked: re-runs emit nothing
            continue
        if linked:  # the spine says someone else; a human decides, not this pass
            _open_review(
                ctx, attendee.id, sorted(linked | {person_id}), REASON_CONFLICT, now, report
            )
            continue

        provenance: dict[str, Any] = {
            "method": METHOD,
            "confidence": 1.0,
            "source_entity_ids": [str(attendee.id), str(person_id)],
        }
        services.relate(
            ctx,
            attendee.id,
            IS_PERSON,
            person_id,
            valid_from=now,
            attributes=provenance,
            actor=METHOD,
        )
        report.linked += 1
    return report


def autolink_context() -> AccessContext:
    """Exactly the scopes the pass needs: it reads both domains and writes an
    edge whose endpoints span both, and `relate` requires write on every domain
    an endpoint belongs to (ADR 013)."""
    return AccessContext.of(
        "calendar:read", "calendar:write", "relationships:read", "relationships:write"
    )


def main() -> int:
    ctx = autolink_context()
    for name in define_calendar_types(ctx):
        print(f"defined type {name} (domain: calendar)")
    print(run_autolink(ctx).line())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
