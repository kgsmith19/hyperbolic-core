"""Intentions daily planner (LO-3d/LO-3e, m5-08).

`_priority_key`'s ordering shape is exercised directly with constructed
entities (unit tier, no database) in test_review_feed.py's own sibling
style; `plan_today`/`mark_done` are integration-tested against real
kernel writes, since "append an event, never mutate history" and
"re-import preserves done" are both claims about the real event log,
not something a pure function alone could prove.

Every title carries a per-test uuid marker (the domains/agents/
proposals.py precedent) so this module's fixtures never collide with
another test module's intentions in the shared test database.
"""

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest

from domains.intentions.focus import capture_intention
from domains.intentions.import_priorities import run_import
from domains.intentions.planner import PlannedIntention, mark_done, plan_today
from domains.intentions.types import STATUS_CANDIDATE, TYPE_NAME, define_intention_types
from domains.ops.receipts import JobResult, emit_receipt
from domains.ops.types import define_ops_types
from kernel import services
from kernel.access import AccessContext, ScopeError
from tests.intentions.test_import_priorities import FakeClient, listing
from tests.support import event_count


def a_title(label: str) -> str:
    return f"planner-{label}-{uuid4().hex[:12]}"


@pytest.fixture(scope="module")
def seed_ctx(ctx: AccessContext) -> AccessContext:
    define_intention_types(ctx)
    define_ops_types(ctx)  # the not-an-intention refusal case captures a receipt
    return ctx


@pytest.fixture
def focus_ctx(seed_ctx: AccessContext) -> AccessContext:
    """A context whose focus-3 budget is clear, for the tests below that need
    to focus intentions of their own.

    The focus rule (ADR-019 rule 3, domains/intentions/focus.py) is global and
    every test module shares one database, so the three focus slots are a
    SESSION-wide resource: whoever captures a focus=true intention holds a slot
    until something releases it, and nothing did. The two tests below were the
    ones that happened to ask for a slot after the third was taken, so they
    failed on FocusLimitExceeded for a reason unrelated to the ordering they
    assert -- test isolation, not a defect in the rule or the planner.

    Releasing is a re-capture with focus=False, which supersedes by `title`
    (the type's own x-identity) exactly as an operator clearing a focus goal in
    the UI does -- not a direct row edit, so the guard and the event log both
    see it as the ordinary write it is.
    """
    for entity in services.find(seed_ctx, type_name=TYPE_NAME, filters={"focus": True}):
        capture_intention(seed_ctx, {**entity.attributes, "focus": False})
    return seed_ctx


def seed(ctx: AccessContext, title: str, **overrides: object) -> None:
    attributes: dict[str, object] = {
        "title": title,
        "kind": "task",
        "status": "active",
        "focus": False,
        **overrides,
    }
    capture_intention(ctx, attributes)


def by_title(items: list[PlannedIntention], title: str) -> PlannedIntention:
    return next(p for p in items if p.title == title)


# ---------------------------------------------------------------------------
# LO-3d: priority ordering and candidate exclusion.
# ---------------------------------------------------------------------------


def test_plan_excludes_still_unconfirmed_candidates(seed_ctx: AccessContext) -> None:
    confirmed = a_title("confirmed")
    candidate = a_title("candidate")
    seed(seed_ctx, confirmed)
    seed(seed_ctx, candidate, status=STATUS_CANDIDATE)

    titles = {p.title for p in plan_today(seed_ctx)}

    assert confirmed in titles
    assert candidate not in titles


def test_focus_intentions_lead_non_focus_ones(focus_ctx: AccessContext) -> None:
    plain = a_title("plain")
    focused = a_title("focused")
    seed(focus_ctx, plain, focus=False)
    seed(focus_ctx, focused, focus=True)

    plan = plan_today(focus_ctx)
    plain_index = next(i for i, p in enumerate(plan) if p.title == plain)
    focused_index = next(i for i, p in enumerate(plan) if p.title == focused)

    assert focused_index < plain_index


def test_creation_order_breaks_ties_within_a_focus_group(focus_ctx: AccessContext) -> None:
    first = a_title("first")
    second = a_title("second")
    # Captured in this exact order -- created_at is server-assigned
    # (kernel/services/capture.py's own `now`), so the real sequence of
    # these two calls IS the fixture, the same way it is the operator's
    # own priority-list import order in production.
    seed(focus_ctx, first, focus=True)
    seed(focus_ctx, second, focus=True)

    plan = plan_today(focus_ctx)
    first_index = next(i for i, p in enumerate(plan) if p.title == first)
    second_index = next(i for i, p in enumerate(plan) if p.title == second)

    assert first_index < second_index


def test_plan_view_carries_the_fields_the_page_needs() -> None:
    ctx = AccessContext.all()
    title = a_title("fields")
    seed(ctx, title, kind="project", floor="one sentence", next_action="send the email")

    view = by_title(plan_today(ctx), title)

    assert view.kind == "project"
    assert view.floor == "one sentence"
    assert view.next_action == "send the email"
    assert view.done is False


# ---------------------------------------------------------------------------
# LO-3d: marking done appends an event, never mutates history.
# ---------------------------------------------------------------------------


def test_mark_done_sets_done_and_preserves_every_other_field(seed_ctx: AccessContext) -> None:
    title = a_title("done")
    seed(seed_ctx, title, kind="habit_quota", floor="one push-up", next_action="do it now")
    view = by_title(plan_today(seed_ctx), title)

    updated = mark_done(seed_ctx, view.intention_id)

    assert updated.done is True
    assert updated.kind == "habit_quota"
    assert updated.floor == "one push-up"
    assert updated.next_action == "do it now"


def test_mark_done_appends_exactly_one_new_event_never_edits_the_old_one(
    seed_ctx: AccessContext,
) -> None:
    title = a_title("append-only")
    seed(seed_ctx, title)
    view = by_title(plan_today(seed_ctx), title)
    before = event_count()

    mark_done(seed_ctx, view.intention_id)

    assert event_count() == before + 1


def test_mark_done_is_reflected_in_the_next_plan_read(seed_ctx: AccessContext) -> None:
    title = a_title("reflected")
    seed(seed_ctx, title)
    view = by_title(plan_today(seed_ctx), title)

    mark_done(seed_ctx, view.intention_id)

    assert by_title(plan_today(seed_ctx), title).done is True


def test_mark_done_refuses_an_entity_that_is_not_an_intention(seed_ctx: AccessContext) -> None:
    now = datetime.now(UTC)
    receipt_id = emit_receipt(seed_ctx, "test-planner-fixture", now, now, JobResult())

    with pytest.raises(ValueError, match="not an intention"):
        mark_done(seed_ctx, receipt_id)


def test_mark_done_propagates_a_lookup_error_for_an_unknown_id(seed_ctx: AccessContext) -> None:
    with pytest.raises(LookupError):
        mark_done(seed_ctx, uuid4())


# ---------------------------------------------------------------------------
# LO-3e: done-state survives a re-import of the same title.
# ---------------------------------------------------------------------------


def test_re_importing_an_already_known_title_preserves_its_done_state(
    seed_ctx: AccessContext, tmp_path: Path
) -> None:
    title = a_title("reimport")
    seed(seed_ctx, title)
    view = by_title(plan_today(seed_ctx), title)
    mark_done(seed_ctx, view.intention_id)
    assert by_title(plan_today(seed_ctx), title).done is True

    # `title` is already known, so run_import's own existing-title skip
    # (import_priorities.py's own docstring: "never re-captured, never
    # sent back to the model, never clobbered") means this never reaches
    # the model at all -- the empty response list proves it: a real call
    # would raise AssertionError inside FakeClient.
    report = run_import(seed_ctx, listing(tmp_path, title), client=FakeClient([]))

    assert report.existing == 1
    assert report.seeded == 0
    assert by_title(plan_today(seed_ctx), title).done is True


def test_plan_today_refuses_without_intentions_read_scope() -> None:
    with pytest.raises(ScopeError):
        plan_today(AccessContext.of("ops:read"))
