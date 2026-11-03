"""Master TODO Tracker import (#535): structure mapping, dry run, idempotent apply.

Synthetic fixtures only: no real tracker item may appear in this repository.
"""

from uuid import uuid4

import pytest

from domains.intentions.import_tracker import apply_plan, parse_tracker
from domains.intentions.types import STATUS_CANDIDATE, TYPE_NAME, define_intention_types
from kernel import services
from kernel.access import AccessContext
from tests.support import event_count


def tracker(marker: str) -> str:
    return f"""TRACKER - SYNTHETIC
Status convention: OPEN / NEXT / LATER / WAITING / DONE.

OPEN - PRIORITY BACKLOG
\\[ \\] ALPHA: {marker} first open item
\\[ \\] BETA: {marker} second open item
\\[ \\] GAMMA: {marker} third open item
\\[ \\] DELTA: {marker} fourth open item
\\[x\\] EPSILON: {marker} already ticked

NEXT - ACTIVE
[ ] {marker} untagged next item

WAITING
[ ] ZETA: {marker} waiting on a reply

LATER / REVIEW BEFORE REACTIVATING
[ ] {marker} old idea to review

DONE
[ ] ETA: {marker} finished last week
"""


def test_sections_map_to_progress_and_plannability() -> None:
    plan = parse_tracker(tracker("m"))
    by_section = {i.section: i for i in plan.items}
    assert by_section["OPEN"].progress == "READY" and by_section["OPEN"].plannable
    assert by_section["WAITING"].progress == "WAITING"
    review = next(i for i in plan.items if "old idea" in i.title)
    assert review.plannable is False
    assert plan.skipped_done == 2  # one ticked box, one DONE section line


def test_only_the_first_three_open_items_are_proposed_focus() -> None:
    plan = parse_tracker(tracker("m"))
    assert [i.tag for i in plan.items if i.proposed_focus] == ["ALPHA", "BETA", "GAMMA"]


def test_excluded_tags_are_skipped_and_counted() -> None:
    plan = parse_tracker(tracker("m"), exclude_tags=["beta", "ZETA"])
    assert {i.tag for i in plan.items} >= {"ALPHA", "GAMMA"}
    assert "BETA" not in {i.tag for i in plan.items}
    assert plan.skipped_excluded == 2


def test_counts_carry_no_item_text() -> None:
    marker = f"secret-{uuid4().hex[:8]}"
    counts = parse_tracker(tracker(marker)).counts()
    assert marker not in repr(counts)
    assert counts["planned"] == 7 and counts["proposed_focus"] == 3


def test_lines_before_any_section_are_ignored() -> None:
    assert parse_tracker("[ ] ALPHA: orphan line\n").items == []


@pytest.fixture(scope="module")
def seed_ctx(ctx: AccessContext) -> AccessContext:
    define_intention_types(ctx)
    return ctx


def test_apply_captures_candidates_only_and_a_rerun_writes_nothing(
    seed_ctx: AccessContext,
) -> None:
    marker = f"tracker-{uuid4().hex[:12]}"
    plan = parse_tracker(tracker(marker))
    first = apply_plan(seed_ctx, plan)
    assert first["created"] == len(plan.items)
    mine = [e for e in services.find(seed_ctx, type_name=TYPE_NAME)
            if marker in str(e.attributes.get("title"))]
    assert len(mine) == len(plan.items)
    for entity in mine:
        assert entity.attributes["status"] == STATUS_CANDIDATE
        assert entity.attributes["focus"] is False
        assert entity.attributes.get("progress") != "DONE"
        assert entity.attributes.get("done") is not True
    before = event_count()
    second = apply_plan(seed_ctx, plan)
    assert second["created"] == 0 and second["existing"] == len(plan.items)
    assert event_count() == before
