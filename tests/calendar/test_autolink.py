"""Integration: zero-LLM auto-link of attendees to the person spine (ADR 013).

Tests share the session database and run in definition order; the erasure
regression runs last because it strips an attendee's email. Every address here
is synthetic and unique to this module, so nothing crosses into the ingestion
tests.
"""

from uuid import UUID

import pytest

from domains.calendar.autolink import (
    IS_PERSON,
    METHOD,
    REASON_AMBIGUOUS,
    REASON_CONFLICT,
    autolink_context,
    normalize_email,
    run_autolink,
)
from domains.calendar.types import define_calendar_types
from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.services import capture, find, forget, get_entity, history, relate


@pytest.fixture(scope="module")
def link_ctx(seeded: dict[str, UUID]) -> AccessContext:
    """The exact production context; `seeded` defines the person type."""
    ctx = autolink_context()
    define_calendar_types(ctx)
    return ctx


def make_person(ctx: AccessContext, name: str, *emails: str) -> UUID:
    return capture(ctx, "person", {"full_name": name, "emails": list(emails)}).entity_id


def make_attendee(ctx: AccessContext, email: str) -> UUID:
    return capture(ctx, "attendee", {"email": email}).entity_id


def links_of(ctx: AccessContext, attendee_id: UUID) -> list[UUID]:
    return [e.to_entity for e in get_entity(ctx, attendee_id).edges_out if e.relation == IS_PERSON]


def review_for(ctx: AccessContext, attendee_id: UUID, reason: str) -> dict[str, object] | None:
    found = find(ctx, type_name="link_review", filters={"review_key": f"{attendee_id}:{reason}"})
    return dict(found[0].attributes) if found else None


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def test_normalization_is_exact_with_google_aliases_only() -> None:
    assert normalize_email("  Ann@Autolink.TEST ") == "ann@autolink.test"
    # dots and plus-tags are the same mailbox at Google, and only at Google
    assert normalize_email("Pat.Lee+work@googlemail.com") == "patlee@gmail.com"
    assert normalize_email("patlee@gmail.com") == "patlee@gmail.com"
    assert normalize_email("pat.lee@autolink.test") != normalize_email("patlee@autolink.test")
    assert normalize_email("pat+work@autolink.test") == "pat+work@autolink.test"
    for junk in ("", "  ", "nobody", "@nodomain.test", "nolocal@"):
        assert normalize_email(junk) is None


def test_exact_match_links_attendee_with_provenance(link_ctx: AccessContext) -> None:
    ann = make_person(link_ctx, "Ann Adler", "Ann@Autolink.test")  # case differs on purpose
    attendee = make_attendee(link_ctx, "ann@autolink.test")

    report = run_autolink(link_ctx)
    assert report.linked == 1 and report.ambiguous == 0

    (edge,) = [e for e in get_entity(link_ctx, attendee).edges_out if e.relation == IS_PERSON]
    assert edge.to_entity == ann
    assert edge.attributes == {
        "method": METHOD,
        "confidence": 1.0,
        "source_entity_ids": [str(attendee), str(ann)],
    }
    # edges only: neither endpoint's attributes were touched (invariant 4)
    assert get_entity(link_ctx, ann).entity.attributes["emails"] == ["Ann@Autolink.test"]
    assert get_entity(link_ctx, attendee).entity.attributes["email"] == "ann@autolink.test"


def test_google_alias_matches_across_dots_plus_and_googlemail(link_ctx: AccessContext) -> None:
    pat = make_person(link_ctx, "Pat Lee", "pat.lee+work@gmail.com")
    attendee = make_attendee(link_ctx, "PatLee@googlemail.com")
    run_autolink(link_ctx)
    assert links_of(link_ctx, attendee) == [pat]


def test_rerun_emits_nothing_new(link_ctx: AccessContext) -> None:
    before = event_count()
    report = run_autolink(link_ctx)
    assert report.linked == 0 and report.ambiguous == 0
    assert event_count() == before  # the idempotency proof


def test_no_match_emits_nothing(link_ctx: AccessContext) -> None:
    stranger = make_attendee(link_ctx, "stranger@autolink.test")
    before = event_count()
    run_autolink(link_ctx)
    assert links_of(link_ctx, stranger) == []
    assert find(link_ctx, type_name="link_review", filters={"attendee_id": str(stranger)}) == []
    assert event_count() == before  # a stranger is not a defect


def test_ambiguous_match_opens_a_review_item_instead_of_guessing(
    link_ctx: AccessContext,
) -> None:
    # two spine entries claim the same mailbox: exactly what must not be guessed
    one = make_person(link_ctx, "Dee Roy", "deeroy@gmail.com")
    two = make_person(link_ctx, "D. Roy", "dee.roy@googlemail.com")
    attendee = make_attendee(link_ctx, "dee.roy+cal@gmail.com")

    report = run_autolink(link_ctx)
    assert report.ambiguous == 1
    assert links_of(link_ctx, attendee) == []  # no edge, no merge, no guess

    review = review_for(link_ctx, attendee, REASON_AMBIGUOUS)
    assert review is not None
    assert review["candidate_person_ids"] == sorted([str(one), str(two)])
    assert review["reason"] == REASON_AMBIGUOUS and review["method"] == METHOD
    # IDs and a reason code only — never the third party's email or name
    assert "dee.roy" not in str(review) and "@" not in str(review)

    before = event_count()
    assert run_autolink(link_ctx).ambiguous == 0  # the queue does not churn
    assert event_count() == before


def test_conflicting_existing_link_is_reviewed_not_relinked(link_ctx: AccessContext) -> None:
    incumbent = make_person(link_ctx, "Cy Prior", "cy.prior@autolink.test")
    attendee = make_attendee(link_ctx, "cy@autolink.test")
    now = get_entity(link_ctx, attendee).entity.created_at
    relate(link_ctx, attendee, IS_PERSON, incumbent, valid_from=now)  # a human's earlier call
    challenger = make_person(link_ctx, "Cy Newman", "cy@autolink.test")

    assert run_autolink(link_ctx).ambiguous == 1
    assert links_of(link_ctx, attendee) == [incumbent]  # nothing rewritten

    review = review_for(link_ctx, attendee, REASON_CONFLICT)
    assert review is not None
    assert review["candidate_person_ids"] == sorted([str(incumbent), str(challenger)])


def test_linking_without_relationships_write_fails_closed(link_ctx: AccessContext) -> None:
    make_person(link_ctx, "Fay Closed", "fay@autolink.test")
    make_attendee(link_ctx, "fay@autolink.test")
    read_only = AccessContext.of("calendar:read", "calendar:write", "relationships:read")
    with pytest.raises(ScopeError):
        run_autolink(read_only)


# Runs last on purpose: forgetting the attendee strips the email later tests
# would match on.
def test_forgotten_attendee_email_unfindable_including_review_items(
    link_ctx: AccessContext,
) -> None:
    run_autolink(link_ctx)  # settle the pending fay link
    email = "dee.roy+cal@gmail.com"
    (attendee,) = find(link_ctx, type_name="attendee", filters={"email": email})
    assert attendee.id in {e.id for e in find(link_ctx, text=email)}  # not vacuous

    forget(link_ctx, attendee.id)

    # the alias form belongs to the attendee alone — the candidate people store
    # other spellings — so nothing anywhere may still surface it
    assert find(link_ctx, text=email) == []
    assert "email" not in get_entity(link_ctx, attendee.id).entity.attributes
    for review in find(link_ctx, type_name="link_review"):
        assert "@" not in str(review.attributes)
    for event in history(link_ctx, attendee.id):
        assert email not in str(event.payload)
