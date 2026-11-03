"""Today command center (#531, first slice).

Integration-tested against real kernel writes: "at most three one-offs",
"anchors are never one-offs" and "a progress change appends an event" are
claims about what the event log and the projection hold, not about a pure
function. Every title carries a per-test marker so fixtures never collide
with another module's intentions in the shared session database; the view
is filtered to this test's marker before asserting.
"""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from domains.intentions.focus import capture_intention
from domains.intentions.today import (
    ONE_OFF_LIMIT,
    TodayItem,
    progress_history,
    progress_of,
    set_progress,
    today,
)
from domains.intentions.types import STATUS_CANDIDATE, TYPE_NAME, define_intention_types
from kernel import services
from kernel.access import AccessContext
from tests.support import event_count


@pytest.fixture(scope="module")
def seed_ctx(ctx: AccessContext) -> AccessContext:
    define_intention_types(ctx)
    return ctx


@pytest.fixture
def marker() -> str:
    return f"today-{uuid4().hex[:12]}"


def seed(ctx: AccessContext, title: str, **overrides: object) -> None:
    attributes: dict[str, object] = {
        "title": title,
        "kind": "task",
        "status": "active",
        "focus": False,
        **overrides,
    }
    capture_intention(ctx, attributes)


def mine(items: list[TodayItem], marker: str) -> list[TodayItem]:
    return [i for i in items if i.title.startswith(marker)]


def entity_id(ctx: AccessContext, title: str) -> UUID:
    found = services.find(ctx, type_name=TYPE_NAME)
    return next(e.id for e in found if e.attributes["title"] == title)


def test_at_most_three_one_offs_are_surfaced_and_the_rest_counted(
    seed_ctx: AccessContext, marker: str
) -> None:
    """AC: max three surfaced; the rest stay inspectable as a count, not clutter."""
    before = today(seed_ctx)
    for n in range(ONE_OFF_LIMIT + 2):
        seed(seed_ctx, f"{marker}-task-{n}")
    view = today(seed_ctx)
    assert len(view.one_offs) <= ONE_OFF_LIMIT
    total_open = len(view.one_offs) + view.more_one_offs
    assert total_open == len(before.one_offs) + before.more_one_offs + ONE_OFF_LIMIT + 2


def test_anchors_are_listed_apart_and_never_counted_as_one_offs(
    seed_ctx: AccessContext, marker: str
) -> None:
    """AC: anchors (recurring commitments, habit quotas) are not one-offs."""
    seed(seed_ctx, f"{marker}-walk", kind="habit_quota")
    seed(seed_ctx, f"{marker}-standup", kind="recurring_commitment")
    view = today(seed_ctx)
    assert {i.title for i in mine(view.anchors, marker)} == {f"{marker}-walk", f"{marker}-standup"}
    assert mine(view.one_offs, marker) == []


def test_candidates_never_appear(seed_ctx: AccessContext, marker: str) -> None:
    """An unconfirmed import candidate is not something the operator agreed to plan around."""
    seed(seed_ctx, f"{marker}-proposed", status=STATUS_CANDIDATE)
    view = today(seed_ctx)
    assert mine(view.one_offs, marker) == [] and mine(view.anchors, marker) == []


def test_progress_change_appends_one_event_and_keeps_history(
    seed_ctx: AccessContext, marker: str
) -> None:
    """AC: status changes persist with audit history; no event is ever edited."""
    title = f"{marker}-ship"
    seed(seed_ctx, title)
    eid = entity_id(seed_ctx, title)
    before = event_count()
    item = set_progress(seed_ctx, eid, "STARTED")
    assert item.progress == "STARTED"
    assert event_count() == before + 1
    set_progress(seed_ctx, eid, "BLOCKED")
    set_progress(seed_ctx, eid, "DONE")
    history = [c.progress for c in progress_history(seed_ctx, eid)]
    assert history == ["READY", "STARTED", "BLOCKED", "DONE"]
    done = services.get_entity(seed_ctx, eid).entity.attributes
    assert done["done"] is True and done["progress"] == "DONE"


def test_done_one_offs_leave_the_day(seed_ctx: AccessContext, marker: str) -> None:
    title = f"{marker}-finish"
    seed(seed_ctx, title)
    set_progress(seed_ctx, entity_id(seed_ctx, title), "DONE")
    all_titles = {i.title for i in today(seed_ctx).one_offs}
    assert title not in all_titles


def test_an_unknown_progress_is_refused_before_any_write(
    seed_ctx: AccessContext, marker: str
) -> None:
    """Negative control: only READY/STARTED/BLOCKED/WAITING/DONE are accepted."""
    title = f"{marker}-bad"
    seed(seed_ctx, title)
    before = event_count()
    with pytest.raises(ValueError, match="progress must be one of"):
        set_progress(seed_ctx, entity_id(seed_ctx, title), "ALMOST")
    assert event_count() == before


def test_legacy_done_flag_reads_as_done() -> None:
    """The Tomorrow page's mark-done (done=True, no progress) and this view agree."""
    assert progress_of({"done": True}) == "DONE"
    assert progress_of({"progress": "WAITING"}) == "WAITING"
    assert progress_of({}) == "READY"
    assert progress_of({"progress": "nonsense"}) == "READY"


def test_stale_flag_after_two_weeks(seed_ctx: AccessContext, marker: str) -> None:
    """AC: clear stale indicators -- an item untouched for 14 days is flagged.

    An anchor, because anchors are always listed, so the item is present in
    both views and the assertion can never pass vacuously."""
    title = f"{marker}-old"
    seed(seed_ctx, title, kind="habit_quota")
    later = datetime.now(UTC) + timedelta(days=15)
    (stale,) = [i for i in today(seed_ctx, now=later).anchors if i.title == title]
    (fresh,) = [i for i in today(seed_ctx).anchors if i.title == title]
    assert stale.stale is True
    assert fresh.stale is False
