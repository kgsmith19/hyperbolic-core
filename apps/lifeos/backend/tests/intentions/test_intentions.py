"""Integration: the intention type (INT1) lands as registry data, the service
rejects a fourth focus goal, and the golden questions (docs/golden-questions.md
Q15/Q16) answer with citations on fixture data."""

from typing import Any

import jsonschema
import pytest

from domains.intentions.focus import FOCUS_LIMIT, FocusLimitExceeded, capture_intention
from domains.intentions.types import TYPE_NAME, define_intention_types
from kernel import services
from kernel.access import AccessContext
from mcp_server import tools

SOURCE = "priority list 2026-07"

FIXTURE: list[dict[str, Any]] = [
    {
        "title": "Reverse the health slide",
        "kind": "project",
        "status": "active",
        "focus": True,
        "floor": "a ten-minute walk",
        "next_action": "book the follow-up labs",
        "source": SOURCE,
    },
    {
        "title": "Strength training",
        "kind": "habit_quota",
        "status": "active",
        "focus": True,
        "floor": "one set of squats at home",
        "next_action": "load the Monday plan",
        "source": SOURCE,
    },
    {
        "title": "Ship lifeos intentions",
        "kind": "task",
        "status": "active",
        "focus": True,
        "next_action": "land the intention type",
        "source": SOURCE,
    },
    {
        "title": "Renew passport",
        "kind": "research_errand",
        "status": "waiting",
        "focus": False,
        "next_action": "dig out the old passport",
        "source": SOURCE,
    },
]

FOCUS_TITLES = {i["title"] for i in FIXTURE if i["focus"] is True}


@pytest.fixture(scope="module")
def goals(ctx: AccessContext) -> dict[str, str]:
    """Fixture intentions, seeded once: three focus goals and one backlog item.

    Clears any focus flag left behind by earlier test modules first, so the
    assertions below are exact whatever order the session ran in.
    """
    define_intention_types(ctx)
    for entity in services.find(ctx, type_name=TYPE_NAME, filters={"focus": True}):
        capture_intention(ctx, {**entity.attributes, "focus": False})
    return {str(item["title"]): str(capture_intention(ctx, item).entity_id) for item in FIXTURE}


def test_define_is_idempotent(ctx: AccessContext) -> None:
    define_intention_types(ctx)
    assert define_intention_types(ctx) == []


def test_unknown_kind_rejected(ctx: AccessContext, goals: dict[str, str]) -> None:
    someday = {"title": "Someday pile", "kind": "someday", "status": "active", "focus": False}
    with pytest.raises(jsonschema.ValidationError):
        capture_intention(ctx, someday)


def test_fourth_focus_rejected(ctx: AccessContext, goals: dict[str, str]) -> None:
    fourth = {"title": "A fourth thing", "kind": "task", "status": "active", "focus": True}
    with pytest.raises(FocusLimitExceeded):
        capture_intention(ctx, fourth)
    # the refusal wrote nothing
    assert services.find(ctx, type_name=TYPE_NAME, filters={"title": "A fourth thing"}) == []


def test_refocus_of_a_focus_goal_updates_not_a_fourth(
    ctx: AccessContext, goals: dict[str, str]
) -> None:
    updated = {
        "title": "Strength training",
        "kind": "habit_quota",
        "status": "active",
        "focus": True,
        "next_action": "swap Monday to lower body",
    }
    result = capture_intention(ctx, updated)
    assert str(result.entity_id) == goals["Strength training"]
    # the merge kept the floor: an update never silently drops it
    [entity] = services.find(ctx, type_name=TYPE_NAME, filters={"title": "Strength training"})
    assert entity.attributes["floor"] == "one set of squats at home"


def test_non_focus_capture_passes_at_the_cap(ctx: AccessContext, goals: dict[str, str]) -> None:
    backlog = {"title": "Clean the garage", "kind": "task", "status": "someday", "focus": False}
    capture_intention(ctx, backlog)  # three focus goals exist; this is not a fourth


def test_golden_q_three_focus_goals_with_citations(
    ctx: AccessContext, goals: dict[str, str]
) -> None:
    """Q15 "What are my 3 focus goals?" — exactly the focus records, cited."""
    answer = tools.find(ctx, type_name=TYPE_NAME, filters={"focus": True})
    assert len(answer["entities"]) == FOCUS_LIMIT
    assert {e["attributes"]["title"] for e in answer["entities"]} == FOCUS_TITLES
    provenance = answer["provenance"]
    assert set(provenance["source_entity_ids"]) == {goals[str(title)] for title in FOCUS_TITLES}
    assert provenance["method"] == "kernel.find"
    assert provenance["confidence"] == 1.0


def test_golden_q_floor_version_of_habit_with_citations(
    ctx: AccessContext, goals: dict[str, str]
) -> None:
    """Q16 "What is the floor version of Strength training?" — the floor
    string verbatim, cited to the record it came from."""
    answer = tools.find(ctx, type_name=TYPE_NAME, filters={"title": "Strength training"})
    [entity] = answer["entities"]
    assert entity["attributes"]["floor"] == "one set of squats at home"
    assert answer["provenance"]["source_entity_ids"] == [goals["Strength training"]]
    assert answer["provenance"]["confidence"] == 1.0
