"""Episode chat lines and the briefing line (EP1 T3): routing, verbatim
playbook quotation, exact card rendering, the golden questions end to end,
and the anti-reassurance repeat rule.

Every value here is synthetic — no operator personal content (cell rule).
Integration fixtures use their own onset dates (2028-*) so nothing merges
with other modules' episodes (identity = onset_date).
"""

from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import pytest

from domains.episodes import lines as lines_module
from domains.episodes.capture import guard_capture
from domains.episodes.evidence import compute_card, evidence_card
from domains.episodes.lines import (
    ABSTAIN_LINE,
    METHOD,
    ROUTE_COMPOSE,
    ROUTE_PREDICTION,
    card_lines,
    deterministic_reply,
    has_open,
    latest_playbooks,
    playbook_lines,
    route,
    usual_present,
)
from domains.episodes.types import TYPE_EPISODE, TYPE_PLAYBOOK, define_episode_types
from kernel import services
from kernel.access import AccessContext
from kernel.models import Entity
from tests.support import event_count

# --- pure: routing ----------------------------------------------------------


@pytest.mark.parametrize(
    "message",
    [
        "Will I have an episode next week?",
        "Am I going to have another episode?",
        "What's the risk of an episode tomorrow?",
        "When will this episode end?",
    ],
)
def test_prediction_shaped_questions_route_to_abstention(message: str) -> None:
    assert route(message) == ROUTE_PREDICTION


@pytest.mark.parametrize(
    "message",
    [
        "What does my playbook say?",
        "How long did episodes actually last vs feared?",
        "I'm worried - am I ok?",
        "How long will this last?",
        "Will this ever end?",
    ],
)
def test_playbook_evidence_and_wellbeing_questions_compose(message: str) -> None:
    assert route(message) == ROUTE_COMPOSE


@pytest.mark.parametrize("message", ["What's on my calendar today?", "hello", "who am I?"])
def test_other_messages_stay_on_the_model_path(message: str) -> None:
    assert route(message) is None


# --- pure: rendering --------------------------------------------------------


def _entity(n: int, **attributes: Any) -> Entity:
    moment = datetime(2026, 1, 1, tzinfo=UTC)
    return Entity(id=UUID(int=n), attributes=attributes, created_at=moment, updated_at=moment)


def test_open_gate_uses_the_evidence_card_definition() -> None:
    closed = _entity(1, onset_date="2026-03-01", end_date="2026-03-02")
    opened = _entity(2, onset_date="2026-03-05")
    assert not has_open([closed])
    assert has_open([closed, opened])


def test_latest_version_renders_verbatim_and_supersedes_earlier_ones() -> None:
    v1 = _entity(
        11, name="synthetic plan", version=1, steps=[{"if": "old trigger", "then": "old response"}]
    )
    v2 = _entity(
        12,
        name="synthetic plan",
        version=2,
        steps=[{"if": "synthetic trigger", "then": "synthetic response, verbatim"}],
    )
    latest = latest_playbooks([v1, v2])
    assert [p.id for p in latest] == [v2.id]
    joined = "\n".join(playbook_lines(latest))
    assert "if synthetic trigger, then synthetic response, verbatim" in joined
    assert "old trigger" not in joined
    assert '"synthetic plan" (version 2)' in joined


def test_no_playbook_is_said_not_invented() -> None:
    assert playbook_lines([]) == ["Playbook: none recorded yet."]


def test_card_lines_render_the_fixture_ledger_exactly() -> None:
    """Hand-computed: closed durations in onset order [3, 5] -> median 4,
    halves [3] vs [5] -> lengthening; gaps [-11, -5] -> median -8."""
    episodes = [
        _entity(
            1,
            onset_date="2026-03-01",
            end_date="2026-03-04",
            feared_duration_days=14,
            perturbation_tags=["travel", "short-sleep"],
        ),
        _entity(
            2,
            onset_date="2026-03-10",
            end_date="2026-03-15",
            feared_duration_days=10,
            perturbation_tags=["travel", "conflict"],
        ),
        _entity(3, onset_date="2026-05-02", feared_duration_days=5, perturbation_tags=["travel"]),
    ]
    assert card_lines(compute_card(episodes)) == [
        "Evidence card, computed from your episode records:",
        "- Episodes recorded: 3 (2 closed, 1 open; open episodes are counted but "
        "excluded from duration figures).",
        "- Actual duration of closed episodes: median 4 days; trend so far: "
        "lengthening (earlier half median 3 days, later half 5 days).",
        "- Feared vs actual over 2 closed episodes: median feared 12 days, median "
        "actual 4 days, median gap -8 days (negative means episodes ended sooner "
        "than feared).",
        "- Perturbations recorded together: conflict + travel (1), short-sleep + travel (1).",
    ]


def test_card_lines_state_absence_explicitly() -> None:
    lines = card_lines(compute_card([_entity(1, onset_date="2026-03-01")]))
    assert lines[1].startswith("- Episodes recorded: 1 (0 closed, 1 open")
    assert "- Durations: no closed episodes recorded yet." in lines
    assert "- Feared vs actual: no closed episode recorded a feared duration yet." in lines


# --- pure: the briefing line ------------------------------------------------

BRIEF_DAY = date(2030, 6, 12)


def _tagged(n: int, onset: str, *tags: str) -> Entity:
    return _entity(n, onset_date=onset, perturbation_tags=list(tags))


def test_usual_present_counts_recurring_tags_in_the_week() -> None:
    episodes = [
        _tagged(1, "2030-01-05", "noise", "heat"),
        _tagged(2, "2030-03-01", "noise"),
        _tagged(3, "2030-06-10", "noise", "heat", "once-only"),
        _tagged(4, "2030-06-06", "heat"),  # boundary: day-6 is inside the week
    ]
    result = usual_present(episodes, BRIEF_DAY)
    assert result is not None
    line, cited = result
    assert line == "2 of your usual perturbations present this week"
    # every episode carrying a counted tag is cited — the evidence for both
    # "usual" and "present this week"
    assert {e.id for e in cited} == {UUID(int=n) for n in (1, 2, 3, 4)}
    assert "noise" not in line and "heat" not in line  # a count in words, never a tag


def test_week_is_exactly_seven_days_ending_on_the_briefing_day() -> None:
    history = _tagged(2, "2030-01-01", "noise")
    assert usual_present([_tagged(1, "2030-06-05", "noise"), history], BRIEF_DAY) is None
    result = usual_present([_tagged(1, "2030-06-06", "noise"), history], BRIEF_DAY)
    assert result is not None
    assert result[0] == "1 of your usual perturbations present this week"


def test_one_off_tags_make_no_line() -> None:
    episodes = [
        _tagged(1, "2030-06-10", "once-only"),
        _tagged(2, "2030-01-05", "noise"),
        _tagged(3, "2030-02-05", "noise"),
    ]
    assert usual_present(episodes, BRIEF_DAY) is None


def test_no_episodes_no_line() -> None:
    assert usual_present([], BRIEF_DAY) is None


# --- the reply service against the kernel -----------------------------------

STEP_IF = "synthetic body signal"
STEP_THEN = "synthetic grounding action"
OLD_STEP = "synthetic superseded step"


@pytest.fixture(scope="module", autouse=True)
def episode_types(ctx: AccessContext) -> None:
    define_episode_types(ctx)


def _capture(ctx: AccessContext, type_name: str, attributes: dict[str, Any]) -> UUID:
    """The door: guard first, then generic capture — the POST /capture order."""
    guard_capture(ctx, type_name, attributes)
    return services.capture(ctx, type_name, attributes).entity_id


@pytest.fixture(scope="module")
def seeded(ctx: AccessContext) -> dict[str, UUID]:
    """A two-version playbook, one closed and one open episode (2028-*)."""
    _capture(
        ctx,
        TYPE_PLAYBOOK,
        {"name": "synthetic plan", "version": 1, "steps": [{"if": OLD_STEP, "then": OLD_STEP}]},
    )
    playbook = _capture(
        ctx,
        TYPE_PLAYBOOK,
        {"name": "synthetic plan", "version": 2, "steps": [{"if": STEP_IF, "then": STEP_THEN}]},
    )
    closed = _capture(
        ctx,
        TYPE_EPISODE,
        {
            "onset_date": "2028-01-05",
            "end_date": "2028-01-09",
            "feared_duration_days": 7,
            "perturbation_tags": ["synthetic-lines-a", "synthetic-lines-b"],
        },
    )
    opened = _capture(
        ctx, TYPE_EPISODE, {"onset_date": "2028-02-01", "perturbation_tags": ["synthetic-lines-a"]}
    )
    return {"playbook": playbook, "closed": closed, "open": opened}


def test_playbook_golden_question_is_verbatim_and_cited(
    ctx: AccessContext, seeded: dict[str, UUID]
) -> None:
    """Golden Q: "What does my playbook say?" — the operator's own steps,
    byte-for-byte, citing the quoted version and its latest event."""
    reply = deterministic_reply(ctx, "What does my playbook say?")
    assert reply is not None
    joined = "\n".join(reply["lines"])
    assert f"if {STEP_IF}, then {STEP_THEN}" in joined
    assert OLD_STEP not in joined  # only the latest version is the playbook
    provenance = reply["provenance"]
    assert provenance["method"] == METHOD and provenance["confidence"] == 1.0
    assert str(seeded["playbook"]) in provenance["source_entity_ids"]
    events = services.history(ctx, seeded["playbook"])
    assert str(events[-1].id) in provenance["source_event_ids"]


def test_durations_golden_question_is_computed_and_cited(
    ctx: AccessContext, seeded: dict[str, UUID]
) -> None:
    """Golden Q: "How long did episodes actually last vs feared?" — the reply
    carries exactly the evidence card's rendering and cites every episode the
    card saw (exact arithmetic is pinned by the pure ledger test above)."""
    reply = deterministic_reply(ctx, "How long did episodes actually last vs feared?")
    card = evidence_card(ctx)
    assert reply is not None
    for line in card_lines(card):
        assert line in reply["lines"]
    assert set(card["provenance"]["source_entity_ids"]) <= set(
        reply["provenance"]["source_entity_ids"]
    )
    assert str(seeded["open"]) in reply["provenance"]["source_entity_ids"]


def test_prediction_golden_question_abstains(ctx: AccessContext, seeded: dict[str, UUID]) -> None:
    """Golden Q: "Will I have an episode next week?" — abstains, cites nothing,
    and carries no record content at all."""
    reply = deterministic_reply(ctx, "Will I have an episode next week?")
    assert reply is not None
    assert reply["lines"] == [ABSTAIN_LINE]
    assert reply["provenance"]["source_entity_ids"] == []
    assert reply["provenance"]["source_event_ids"] == []
    assert STEP_IF not in str(reply)


def test_same_day_wellbeing_repeats_return_the_playbook_never_fresh_text(
    ctx: AccessContext, seeded: dict[str, UUID]
) -> None:
    """Two differently-worded wellbeing queries get the identical reply — the
    playbook, not fresh reassurance (roadmap EP1 anti-reassurance rule)."""
    first = deterministic_reply(ctx, "I'm worried - am I ok?")
    second = deterministic_reply(ctx, "How long will this last?")
    assert first is not None and first == second
    assert f"if {STEP_IF}, then {STEP_THEN}" in "\n".join(first["lines"])


def test_reply_is_none_without_an_open_episode(monkeypatch: pytest.MonkeyPatch) -> None:
    """All episodes closed: chat belongs to the ordinary model path again."""
    closed = [_entity(1, onset_date="2026-03-01", end_date="2026-03-02")]
    monkeypatch.setattr(
        lines_module.services, "find", lambda ctx, type_name=None, **kw: list(closed)
    )
    assert deterministic_reply(AccessContext.of("episodes:read"), "worried - am I ok?") is None


def test_reply_without_episodes_read_is_none(seeded: dict[str, UUID]) -> None:
    """A token without episodes:read composes nothing — and leaks nothing."""
    assert deterministic_reply(AccessContext.of("ops:read"), "What does my playbook say?") is None


def test_reply_none_when_domain_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(ctx: AccessContext, type_name: str | None = None, **kw: Any) -> list[Entity]:
        raise LookupError(type_name)

    monkeypatch.setattr(lines_module.services, "find", missing)
    assert deterministic_reply(AccessContext.of("episodes:read"), "my playbook?") is None


def test_reply_is_pull_only_and_writes_nothing(ctx: AccessContext, seeded: dict[str, UUID]) -> None:
    before = event_count()
    deterministic_reply(ctx, "What does my playbook say?")
    deterministic_reply(ctx, "Will I have an episode next week?")
    assert event_count() == before
