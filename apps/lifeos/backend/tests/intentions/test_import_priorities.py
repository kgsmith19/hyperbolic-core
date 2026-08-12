"""Integration + unit: the priority-list import seeds FLAGGED candidate
intentions from an operator-local file (roadmap INT1 T2).

The model client is always a scripted fake — nothing here calls Anthropic —
and every list is synthetic: by rule, no line of any real priority list
exists in this repo.
"""

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from domains.intentions.focus import capture_intention
from domains.intentions.import_priorities import (
    DEFAULT_KIND,
    MODEL_REFUSED,
    MODEL_UNPARSABLE,
    SOURCE,
    main,
    parse_priority_list,
    run_import,
)
from domains.intentions.types import (
    MAX_TITLE,
    STATUS_CANDIDATE,
    TYPE_NAME,
    define_intention_types,
)
from kernel import db
from kernel.access import AccessContext
from kernel.services import find


class FakeClient:
    """Mirrors the `client.beta.messages.create(**kw)` surface the import
    uses. Records every call, so a test can assert what was sent and — more
    to the point — that nothing was sent at all."""

    def __init__(self, responses: list[Any]) -> None:
        self.calls: list[dict[str, Any]] = []
        self._responses = list(responses)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("the fake model client was called more often than scripted")
        return self._responses.pop(0)


def json_response(body: dict[str, Any]) -> Any:
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps(body))], stop_reason="end_turn"
    )


def refusal() -> Any:
    return SimpleNamespace(content=[], stop_reason="refusal")


def proposal(index: int, kind: str, next_action: str) -> dict[str, Any]:
    return {"index": index, "kind": kind, "next_action": next_action}


def listing(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "priorities.txt"
    path.write_text(text, encoding="utf-8")
    return path


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def by_title(ctx: AccessContext, title: str) -> Any:
    entities = find(ctx, type_name=TYPE_NAME, filters={"title": title})
    assert len(entities) == 1, entities
    return entities[0]


@pytest.fixture(autouse=True, scope="module")
def _types(ctx: AccessContext) -> None:
    define_intention_types(ctx)


def test_import_seeds_flagged_candidates(ctx: AccessContext, tmp_path: Path) -> None:
    fake = FakeClient(
        [
            json_response(
                {
                    "proposals": [
                        proposal(1, "task", "Buy cedar shingles for the birdhouse"),
                        proposal(2, "habit_quota", "Put the soup pot on the Sunday plan"),
                        proposal(3, "research_errand", "List three desk models with prices"),
                    ]
                }
            )
        ]
    )
    path = listing(
        tmp_path,
        "# synthetic fixture — not any real list\n"
        "1. Fix the birdhouse roof\n"
        "2. Weekly soup batch\n"
        "- [ ] Price out a standing desk\n"
        "\n"
        "Fix the birdhouse roof\n",  # in-file duplicate: one candidate, not two
    )
    report = run_import(ctx, path, client=fake)
    assert report.ok
    assert (report.items, report.seeded, report.existing) == (3, 3, 0)
    assert (report.invalid, report.defaulted) == (0, 0)
    assert len(report.produced) == 3
    roof = by_title(ctx, "Fix the birdhouse roof")
    assert roof.attributes["status"] == STATUS_CANDIDATE
    assert roof.attributes["focus"] is False
    assert roof.attributes["kind"] == "task"
    assert roof.attributes["next_action"] == "Buy cedar shingles for the birdhouse"
    assert roof.attributes["source"] == SOURCE
    assert by_title(ctx, "Price out a standing desk").attributes["kind"] == "research_errand"
    # exactly one call, carrying the de-duplicated items as a numbered list
    [call] = fake.calls
    assert call["messages"] == [
        {
            "role": "user",
            "content": (
                "1. Fix the birdhouse roof\n2. Weekly soup batch\n3. Price out a standing desk"
            ),
        }
    ]


def test_rerun_writes_nothing_and_sends_nothing(ctx: AccessContext, tmp_path: Path) -> None:
    text = "- Clear the crawlspace\n- Refill the bird feeder\n"
    first = FakeClient(
        [
            json_response(
                {
                    "proposals": [
                        proposal(1, "project", "Haul the empty boxes to the curb"),
                        proposal(2, "task", "Pour a scoop of seed into the feeder"),
                    ]
                }
            )
        ]
    )
    assert run_import(ctx, listing(tmp_path, text), client=first).seeded == 2
    before = event_count()
    silent = FakeClient([])  # fails the run if the import calls the model at all
    rerun = run_import(ctx, listing(tmp_path, text), client=silent)
    assert rerun.ok
    assert (rerun.items, rerun.existing, rerun.seeded) == (2, 2, 0)
    assert rerun.produced == []
    assert silent.calls == []
    assert event_count() == before  # zero dupes, zero writes of any kind


def test_confirmed_intention_never_clobbered_or_resent(ctx: AccessContext, tmp_path: Path) -> None:
    capture_intention(
        ctx,
        {
            "title": "Morning pages, kept",
            "kind": "habit_quota",
            "status": "active",
            "focus": False,
            "floor": "one sentence before coffee",
        },
    )
    fake = FakeClient(
        [json_response({"proposals": [proposal(1, "task", "Pick up the loft ladder")]})]
    )
    path = listing(tmp_path, "1. Morning pages, kept\n2. Borrow the loft ladder\n")
    report = run_import(ctx, path, client=fake)
    assert (report.items, report.existing, report.seeded) == (2, 1, 1)
    kept = by_title(ctx, "Morning pages, kept")
    assert kept.attributes["status"] == "active"  # never demoted back to candidate
    assert kept.attributes["floor"] == "one sentence before coffee"
    assert "source" not in kept.attributes
    # the known title was never composed into the outbound request
    [call] = fake.calls
    assert call["messages"][0]["content"] == "1. Borrow the loft ladder"


def test_operator_confirms_a_candidate_through_the_capture_door(
    ctx: AccessContext, tmp_path: Path
) -> None:
    fake = FakeClient(
        [json_response({"proposals": [proposal(1, "task", "Find the paint can opener")]})]
    )
    report = run_import(ctx, listing(tmp_path, "- Repaint the shed door\n"), client=fake)
    [seeded_id] = report.produced
    confirmed = capture_intention(
        ctx,
        {"title": "Repaint the shed door", "kind": "project", "status": "active", "focus": False},
    )
    assert confirmed.entity_id == seeded_id  # merged by title identity: no duplicate entity
    entity = by_title(ctx, "Repaint the shed door")
    assert entity.attributes["status"] == "active"
    assert entity.attributes["kind"] == "project"  # the operator's correction won
    assert entity.attributes["next_action"] == "Find the paint can opener"  # the merge kept it
    assert entity.attributes["source"] == SOURCE


def test_model_refusal_fails_the_run_and_seeds_nothing(ctx: AccessContext, tmp_path: Path) -> None:
    path = listing(tmp_path, "- A list the model declined\n")
    report = run_import(ctx, path, client=FakeClient([refusal()]))
    assert not report.ok
    assert report.status == MODEL_REFUSED
    assert report.seeded == 0
    assert find(ctx, type_name=TYPE_NAME, filters={"title": "A list the model declined"}) == []


def test_out_of_enum_kind_is_refused_as_unparsable(ctx: AccessContext, tmp_path: Path) -> None:
    """The request schema is the model's contract, not our validator: a
    payload violating it locally fails the run rather than seeding garbage."""
    bad = json_response({"proposals": [proposal(1, "someday", "not a real kind")]})
    report = run_import(
        ctx, listing(tmp_path, "- Sort the seed packets\n"), client=FakeClient([bad])
    )
    assert not report.ok
    assert report.status == MODEL_UNPARSABLE
    assert report.seeded == 0
    assert find(ctx, type_name=TYPE_NAME, filters={"title": "Sort the seed packets"}) == []


def test_proposal_bounds_index_and_action(ctx: AccessContext, tmp_path: Path) -> None:
    fake = FakeClient(
        [
            json_response(
                {
                    "proposals": [
                        proposal(1, "project", "First proposal wins"),
                        proposal(1, "task", "Second proposal for the same item is ignored"),
                        proposal(2, "recurring_commitment", "x" * 501),  # dropped, not truncated
                        proposal(9, "task", "Names no real item"),
                    ]
                }
            )
        ]
    )
    path = listing(tmp_path, "- Rebuild the compost bin\n- Quarterly filter swap\n")
    report = run_import(ctx, path, client=fake)
    assert (report.seeded, report.defaulted) == (2, 0)
    compost = by_title(ctx, "Rebuild the compost bin")
    assert compost.attributes["kind"] == "project"
    assert compost.attributes["next_action"] == "First proposal wins"
    swap = by_title(ctx, "Quarterly filter swap")
    assert swap.attributes["kind"] == "recurring_commitment"
    assert "next_action" not in swap.attributes


def test_item_without_a_proposal_defaults_and_is_counted(
    ctx: AccessContext, tmp_path: Path
) -> None:
    fake = FakeClient(
        [json_response({"proposals": [proposal(2, "task", "Drop the parcel at the counter")]})]
    )
    path = listing(tmp_path, "- Unproposed attic sweep\n- Post the parcel\n")
    report = run_import(ctx, path, client=fake)
    assert (report.seeded, report.defaulted) == (2, 1)
    attic = by_title(ctx, "Unproposed attic sweep")
    assert attic.attributes["kind"] == DEFAULT_KIND
    assert attic.attributes["status"] == STATUS_CANDIDATE  # still routed to the operator
    assert "next_action" not in attic.attributes


def test_parse_priority_list() -> None:
    text = (
        "# a comment\n"
        "1. Numbered item\n"
        "2) Numbered with paren\n"
        "- Bulleted item\n"
        "* Starred   item\twith   messy\x00spacing\n"
        "- [ ] Checkbox item\n"
        "\n"
        "Bare line\n"
        "Bare line\n"  # duplicate: kept once
        "\x01\x02\n"  # cleans to nothing: invalid
        + "y" * (MAX_TITLE + 1)
        + "\n"  # overlong: invalid, dropped rather than truncated
    )
    titles, invalid = parse_priority_list(text)
    assert titles == [
        "Numbered item",
        "Numbered with paren",
        "Bulleted item",
        "Starred item with messy spacing",
        "Checkbox item",
        "Bare line",
    ]
    assert invalid == 2


def test_main_argument_errors(tmp_path: Path) -> None:
    assert main([]) == 2
    assert main(["a.txt", "b.txt"]) == 2
    assert main([str(tmp_path / "missing.txt")]) == 2
