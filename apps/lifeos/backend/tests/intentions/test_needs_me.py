"""Needs Me queue acceptance tests (#532, first slice).

Integration-tested against real kernel writes, because the claims are about what
the event log and projection hold: snooze hides and returns, completion needs
evidence, and a repeated action writes no event. Every title carries a per-test
marker and the queue is filtered to it, so fixtures never collide with another
module's intentions in the shared session database.
"""

from datetime import date, timedelta
from uuid import UUID, uuid4

import pytest

from domains.intentions.focus import capture_intention
from domains.intentions.needs_me import (
    FLAG_DEADLINE_UNSOURCED,
    FLAG_NO_NEXT_ACTION,
    NeedsMeItem,
    complete,
    needs_me,
    reschedule,
    snooze,
)
from domains.intentions.types import STATUS_CANDIDATE, TYPE_NAME, define_intention_types
from kernel import services
from kernel.access import AccessContext

TODAY = date(2026, 11, 12)


@pytest.fixture(scope="module")
def seed_ctx(ctx: AccessContext) -> AccessContext:
    define_intention_types(ctx)
    return ctx


@pytest.fixture
def marker() -> str:
    return f"needsme-{uuid4().hex[:12]}"


def seed(ctx: AccessContext, title: str, **overrides: object) -> UUID:
    attributes: dict[str, object] = {
        "title": title,
        "kind": "task",
        "status": "active",
        "focus": False,
        **overrides,
    }
    capture_intention(ctx, attributes)
    return next(
        e.id for e in services.find(ctx, type_name=TYPE_NAME) if e.attributes["title"] == title
    )


def mine(items: list[NeedsMeItem], marker: str) -> list[NeedsMeItem]:
    return [i for i in items if i.title.startswith(marker)]


def event_total(ctx: AccessContext, intention_id: UUID) -> int:
    return len(services.history(ctx, intention_id))


def test_item_without_a_next_action_is_listed_and_flagged_never_invented(
    seed_ctx: AccessContext, marker: str
) -> None:
    seed(seed_ctx, f"{marker}-bare")

    item = mine(needs_me(seed_ctx, TODAY), marker)[0]

    assert item.next_action is None
    assert FLAG_NO_NEXT_ACTION in item.flags


def test_deadline_without_a_source_is_flagged(seed_ctx: AccessContext, marker: str) -> None:
    seed(seed_ctx, f"{marker}-undated-source", deadline="2026-11-20")
    seed(seed_ctx, f"{marker}-sourced", deadline="2026-11-20", deadline_source="school letter")

    items = {i.title: i for i in mine(needs_me(seed_ctx, TODAY), marker)}

    assert FLAG_DEADLINE_UNSOURCED in items[f"{marker}-undated-source"].flags
    assert FLAG_DEADLINE_UNSOURCED not in items[f"{marker}-sourced"].flags


def test_dated_items_come_first_soonest_then_undated(seed_ctx: AccessContext, marker: str) -> None:
    seed(seed_ctx, f"{marker}-later", deadline="2026-12-01", deadline_source="x")
    seed(seed_ctx, f"{marker}-undated")
    seed(seed_ctx, f"{marker}-sooner", deadline="2026-11-14", deadline_source="x")

    order = [i.title for i in mine(needs_me(seed_ctx, TODAY), marker)]

    assert order == [f"{marker}-sooner", f"{marker}-later", f"{marker}-undated"]


def test_snooze_hides_until_its_date_then_the_item_returns(
    seed_ctx: AccessContext, marker: str
) -> None:
    intention = seed(seed_ctx, f"{marker}-snoozed")
    until = TODAY + timedelta(days=3)

    snooze(seed_ctx, intention, until, today=TODAY)

    assert mine(needs_me(seed_ctx, TODAY), marker) == []
    assert mine(needs_me(seed_ctx, until - timedelta(days=1)), marker) == []
    back = mine(needs_me(seed_ctx, until), marker)
    assert [i.title for i in back] == [f"{marker}-snoozed"]


def test_snooze_must_end_after_today(seed_ctx: AccessContext, marker: str) -> None:
    intention = seed(seed_ctx, f"{marker}-past")

    with pytest.raises(ValueError, match="after today"):
        snooze(seed_ctx, intention, TODAY, today=TODAY)


def test_repeating_the_same_snooze_writes_no_new_event(
    seed_ctx: AccessContext, marker: str
) -> None:
    intention = seed(seed_ctx, f"{marker}-idempotent")
    until = TODAY + timedelta(days=2)
    snooze(seed_ctx, intention, until, today=TODAY)
    before = event_total(seed_ctx, intention)

    snooze(seed_ctx, intention, until, today=TODAY)

    assert event_total(seed_ctx, intention) == before


def test_reschedule_refuses_a_blank_source_and_records_a_sourced_date(
    seed_ctx: AccessContext, marker: str
) -> None:
    intention = seed(seed_ctx, f"{marker}-resched")

    with pytest.raises(ValueError, match="source"):
        reschedule(seed_ctx, intention, date(2026, 11, 20), "   ", actor="test")

    item = reschedule(seed_ctx, intention, date(2026, 11, 20), "billing statement")
    assert item.deadline == date(2026, 11, 20)
    assert item.deadline_source == "billing statement"
    assert FLAG_DEADLINE_UNSOURCED not in item.flags


def test_a_status_change_alone_never_completes_an_item(
    seed_ctx: AccessContext, marker: str
) -> None:
    seed(seed_ctx, f"{marker}-status-only", status="done")

    assert [i.title for i in mine(needs_me(seed_ctx, TODAY), marker)] == [f"{marker}-status-only"]


def test_completion_requires_evidence(seed_ctx: AccessContext, marker: str) -> None:
    intention = seed(seed_ctx, f"{marker}-needs-proof")

    with pytest.raises(ValueError, match="evidence"):
        complete(seed_ctx, intention, "   ")


def test_completion_with_evidence_leaves_the_queue(seed_ctx: AccessContext, marker: str) -> None:
    intention = seed(seed_ctx, f"{marker}-finished")

    item = complete(seed_ctx, intention, "confirmed by the owner", actor="test")

    assert item.intention_id == intention
    assert mine(needs_me(seed_ctx, TODAY), marker) == []


def test_candidates_are_never_listed(seed_ctx: AccessContext, marker: str) -> None:
    seed(seed_ctx, f"{marker}-candidate", status=STATUS_CANDIDATE)

    assert mine(needs_me(seed_ctx, TODAY), marker) == []


def test_anchors_are_never_listed(seed_ctx: AccessContext, marker: str) -> None:
    seed(seed_ctx, f"{marker}-anchor", kind="recurring_commitment")

    assert mine(needs_me(seed_ctx, TODAY), marker) == []
