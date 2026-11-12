"""E2E: the Needs Me routes (#532, first slice) — happy path and refusals.

Each route is a thin dispatch into domains.intentions.needs_me; these tests prove
the wire contract: a refused action is a 422 with a reason and writes nothing.
"""

from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from api.main import app
from domains.intentions.focus import capture_intention
from domains.intentions.types import TYPE_NAME, define_intention_types
from kernel import services
from kernel.access import AccessContext

client = TestClient(app)


def _seed(ctx: AccessContext, title: str) -> UUID:
    define_intention_types(ctx)
    capture_intention(ctx, {"title": title, "kind": "task", "status": "active", "focus": False})
    return next(
        e.id for e in services.find(ctx, type_name=TYPE_NAME) if e.attributes["title"] == title
    )


def _today() -> date:
    return datetime.now(UTC).date()


def test_needs_me_route_lists_the_queue(ctx: AccessContext) -> None:
    title = f"route-listed-{uuid4().hex[:8]}"
    _seed(ctx, title)

    response = client.get("/needs-me")

    assert response.status_code == 200, response.text
    assert title in [item["title"] for item in response.json()]


def test_snooze_route_hides_the_item_and_refuses_a_past_date(ctx: AccessContext) -> None:
    title = f"route-snooze-{uuid4().hex[:8]}"
    intention = _seed(ctx, title)
    until = _today() + timedelta(days=4)

    ok = client.post(f"/intentions/{intention}/snooze", json={"until": until.isoformat()})
    assert ok.status_code == 200, ok.text
    assert title not in [item["title"] for item in client.get("/needs-me").json()]

    refused = client.post(f"/intentions/{intention}/snooze", json={"until": _today().isoformat()})
    assert refused.status_code == 422
    assert "after today" in refused.json()["detail"]


def test_reschedule_route_refuses_a_blank_source_and_records_a_sourced_date(
    ctx: AccessContext,
) -> None:
    intention = _seed(ctx, f"route-resched-{uuid4().hex[:8]}")
    deadline = (_today() + timedelta(days=10)).isoformat()

    refused = client.post(
        f"/intentions/{intention}/reschedule", json={"deadline": deadline, "source": "  "}
    )
    assert refused.status_code == 422
    assert "source" in refused.json()["detail"]

    ok = client.post(
        f"/intentions/{intention}/reschedule",
        json={"deadline": deadline, "source": "clinic letter"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["deadline_source"] == "clinic letter"


def test_complete_route_needs_evidence_and_leaves_the_queue(ctx: AccessContext) -> None:
    title = f"route-complete-{uuid4().hex[:8]}"
    intention = _seed(ctx, title)

    refused = client.post(f"/intentions/{intention}/complete", json={"evidence": ""})
    assert refused.status_code == 422
    assert "evidence" in refused.json()["detail"]
    assert title in [item["title"] for item in client.get("/needs-me").json()]

    ok = client.post(
        f"/intentions/{intention}/complete", json={"evidence": "confirmed by the owner"}
    )
    assert ok.status_code == 200, ok.text
    assert title not in [item["title"] for item in client.get("/needs-me").json()]
