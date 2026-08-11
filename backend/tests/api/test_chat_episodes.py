"""E2E: the episodes deterministic chat path (EP1) over the SSE wire.

The model client here is a FakeClient with NO scripted turns: if any of these
questions ever reached the model the test would fail — the assertion
`fake.calls == []` is the ADR 016 guarantee made visible at the route level.
All fixtures are synthetic (cell rule) and use 2029-* onset dates so nothing
merges with other modules' episodes (identity = onset_date).
"""

import json
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from api import chat
from api.main import app
from domains.episodes.evidence import evidence_card
from domains.episodes.lines import ABSTAIN_LINE, METHOD, card_lines
from domains.episodes.types import TYPE_EPISODE, TYPE_PLAYBOOK, define_episode_types
from kernel import services
from kernel.access import AccessContext
from tests.api.test_chat import _sse_events
from tests.api.test_chat_loop import FakeClient, FakeStream, _final, _text

STEP_IF = "synthetic chat trigger"
STEP_THEN = "synthetic chat response"


@pytest.fixture(scope="module")
def episode_data(ctx: AccessContext) -> dict[str, UUID]:
    define_episode_types(ctx)
    playbook = services.capture(
        ctx,
        TYPE_PLAYBOOK,
        {
            "name": "synthetic chat plan",
            "version": 1,
            "steps": [{"if": STEP_IF, "then": STEP_THEN}],
        },
    ).entity_id
    closed = services.capture(
        ctx,
        TYPE_EPISODE,
        {"onset_date": "2029-01-05", "end_date": "2029-01-08", "feared_duration_days": 6},
    ).entity_id
    opened = services.capture(ctx, TYPE_EPISODE, {"onset_date": "2029-02-01"}).entity_id
    return {"playbook": playbook, "closed": closed, "open": opened}


def _post_messages(fake: Any, messages: list[dict[str, str]]) -> Any:
    app.dependency_overrides[chat.get_model_client] = lambda: fake
    try:
        with TestClient(app) as client:
            return client.post("/chat", json={"messages": messages})
    finally:
        app.dependency_overrides.pop(chat.get_model_client)


def _post(fake: Any, text: str) -> Any:
    return _post_messages(fake, [{"role": "user", "content": text}])


def _text_of(response: Any) -> str:
    return "".join(
        json.loads(data)["delta"] for name, data in _sse_events(response.text) if name == "text"
    )


def _done_of(response: Any) -> dict[str, Any]:
    name, data = _sse_events(response.text)[-1]
    assert name == "done"
    return dict(json.loads(data))


def test_playbook_question_is_answered_verbatim_without_the_model(
    episode_data: dict[str, UUID],
) -> None:
    fake = FakeClient([])
    response = _post(fake, "What does my playbook say?")

    assert response.status_code == 200
    assert f"if {STEP_IF}, then {STEP_THEN}" in _text_of(response)
    done = _done_of(response)
    assert str(episode_data["playbook"]) in done["citations"]["entity_ids"]
    assert done["citations"]["methods"] == [METHOD]
    assert done["model"] == "deterministic"
    assert fake.calls == []  # the model never saw the question or the answer


def test_durations_question_is_computed_and_cited(episode_data: dict[str, UUID]) -> None:
    fake = FakeClient([])
    response = _post(fake, "How long did episodes actually last vs feared?")

    text = _text_of(response)
    for line in card_lines(evidence_card(AccessContext.of("episodes:read"))):
        assert line in text
    cited = _done_of(response)["citations"]["entity_ids"]
    assert str(episode_data["closed"]) in cited and str(episode_data["open"]) in cited
    assert fake.calls == []


def test_prediction_question_abstains(episode_data: dict[str, UUID]) -> None:
    fake = FakeClient([])
    response = _post(fake, "Will I have an episode next week?")

    assert ABSTAIN_LINE in _text_of(response)
    done = _done_of(response)
    assert done["citations"]["entity_ids"] == [] and done["citations"]["event_ids"] == []
    assert fake.calls == []


def test_same_day_wellbeing_repeats_stream_the_identical_playbook(
    episode_data: dict[str, UUID],
) -> None:
    first = _post(FakeClient([]), "I'm worried - am I ok?")
    second = _post(FakeClient([]), "How long will this last?")

    assert _text_of(first) == _text_of(second)  # the playbook, never fresh reassurance
    assert f"if {STEP_IF}, then {STEP_THEN}" in _text_of(first)


def test_non_episode_chat_still_reaches_the_model(episode_data: dict[str, UUID]) -> None:
    fake = FakeClient([FakeStream(["All good."], _final([_text("All good.")]))])
    response = _post(fake, "hello there")

    assert "All good." in _text_of(response)
    assert len(fake.calls) == 1


def test_replayed_deterministic_turns_never_reach_the_model(
    episode_data: dict[str, UUID],
) -> None:
    """The ADR 016 guarantee across turns (PR #55 security review): the
    stateless client replays the playbook reply as ordinary assistant text,
    and the next model call must carry neither that reply nor the
    episode-shaped question that produced it — while benign history stays."""
    fake = FakeClient([FakeStream(["Nothing today."], _final([_text("Nothing today.")]))])
    response = _post_messages(
        fake,
        [
            {"role": "user", "content": "hello there"},
            {"role": "assistant", "content": "All good."},
            {"role": "user", "content": "What does my playbook say?"},
            {"role": "assistant", "content": f"Your playbook: if {STEP_IF}, then {STEP_THEN}"},
            {"role": "user", "content": "What's on my calendar today?"},
        ],
    )

    assert response.status_code == 200
    assert len(fake.calls) == 1
    sent = json.dumps(fake.calls[0]["messages"])
    assert STEP_IF not in sent and STEP_THEN not in sent
    assert "playbook" not in sent.lower()  # the routed question is scrubbed with its reply
    assert "hello there" in sent and "All good." in sent  # benign turns survive
    assert "calendar today" in sent  # the live question arrives


def test_routed_final_message_without_composition_reaches_the_model(
    episode_data: dict[str, UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A routed message that composes nothing (no open episode, no scope) is
    the ordinary model path: the final user turn is never scrubbed."""
    monkeypatch.setattr(chat.episode_lines, "deterministic_reply", lambda ctx, message: None)
    fake = FakeClient([FakeStream(["ok"], _final([_text("ok")]))])
    response = _post(fake, "I'm worried - am I ok?")

    assert response.status_code == 200
    assert len(fake.calls) == 1
    assert "worried" in json.dumps(fake.calls[0]["messages"])
