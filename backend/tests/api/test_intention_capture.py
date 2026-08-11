"""E2E: the generic capture door dispatches to the intentions focus rule
(INT1) — a fourth focus=true intention is a 422 and never a write."""

from typing import Any

from fastapi.testclient import TestClient

from api.main import app
from domains.intentions.types import TYPE_NAME, define_intention_types
from kernel import services
from kernel.access import AccessContext

client = TestClient(app)


def _capture(title: str, *, focus: bool) -> Any:
    attributes = {"title": title, "kind": "task", "status": "active", "focus": focus}
    return client.post("/capture", json={"type_name": TYPE_NAME, "attributes": attributes})


def test_capture_door_enforces_the_focus_cap(ctx: AccessContext) -> None:
    define_intention_types(ctx)
    already = len(services.find(ctx, type_name=TYPE_NAME, filters={"focus": True}))
    mine = [f"Door focus goal {i}" for i in range(3 - already)]
    for title in mine:
        response = _capture(title, focus=True)
        assert response.status_code == 200, response.text

    fourth = _capture("Door fourth goal", focus=True)
    assert fourth.status_code == 422
    assert "focus" in fourth.json()["detail"]
    assert services.find(ctx, type_name=TYPE_NAME, filters={"title": "Door fourth goal"}) == []

    # at the cap, a non-focus intention still lands: the lock is on focus only
    backlog = _capture("Door backlog item", focus=False)
    assert backlog.status_code == 200, backlog.text

    # leave the focus slots as this test found them for the rest of the session
    for title in mine:
        assert _capture(title, focus=False).status_code == 200
