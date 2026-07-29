"""E2E: POST /chat over the SSE wire with the model client overridden."""

from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from api import chat
from api.main import app
from tests.api.test_chat_loop import FakeClient, FakeStream, _final, _text, _tool_use


def _sse_events(body: str) -> list[tuple[str, str]]:
    events = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.split("\n"))
        events.append((lines["event"], lines["data"]))
    return events


def test_chat_streams_text_tool_and_done(seeded: dict[str, Any]) -> None:
    fake = FakeClient(
        [
            FakeStream([], _final([_tool_use("find", {"type_name": "workout"})], "tool_use")),
            FakeStream(["Two ", "workouts."], _final([_text("Two workouts.")])),
        ]
    )
    app.dependency_overrides[chat.get_model_client] = lambda: fake
    try:
        with TestClient(app) as client:
            response = client.post(
                "/chat", json={"messages": [{"role": "user", "content": "workouts?"}]}
            )
    finally:
        app.dependency_overrides.pop(chat.get_model_client)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _sse_events(response.text)
    assert [name for name, _ in events] == ["tool", "text", "text", "done"]
    assert '"name": "find"' in events[0][1]
    assert "kernel.find" in events[-1][1]


def test_chat_rejects_empty_history(seeded: object) -> None:
    fake = FakeClient([])
    app.dependency_overrides[chat.get_model_client] = lambda: fake
    try:
        with TestClient(app) as client:
            response = client.post("/chat", json={"messages": []})
    finally:
        app.dependency_overrides.pop(chat.get_model_client)
    assert response.status_code == 422


def test_chat_mid_stream_failure_emits_error_frame(seeded: object) -> None:
    class Boom(SimpleNamespace):
        def __call__(self, **kwargs: Any) -> Any:
            raise RuntimeError("model unavailable")

    fake = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=Boom())))
    app.dependency_overrides[chat.get_model_client] = lambda: fake
    try:
        with TestClient(app) as client:
            response = client.post("/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    finally:
        app.dependency_overrides.pop(chat.get_model_client)
    events = _sse_events(response.text)
    assert events[-1][0] == "error"
    assert "model unavailable" in events[-1][1]
