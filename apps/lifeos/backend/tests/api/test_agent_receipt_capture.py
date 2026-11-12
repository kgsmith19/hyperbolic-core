"""E2E: the generic capture door refuses agent action receipts (#592).

Receipts are written only through the gate's `record`, never through capture,
so a caller cannot forge a receipt through the generic route.
"""

from fastapi.testclient import TestClient

from api.main import app
from domains.agents.receipts import TYPE_RECEIPT, define_receipt_types
from kernel.access import AccessContext

client = TestClient(app)


def test_capture_route_refuses_an_agent_action_receipt(ctx: AccessContext) -> None:
    define_receipt_types(ctx)
    payload = {
        "type_name": TYPE_RECEIPT,
        "attributes": {
            "receipt_key": "0" * 64,
            "role": "security",
            "permission": "query_telemetry",
            "action_class": "observation",
            "allowed": True,
            "reason": "forged",
            "recorded_at": "2026-11-12T00:00:00+00:00",
        },
    }

    response = client.post("/capture", json=payload)

    assert response.status_code == 422
    assert "written only by the gate" in response.json()["detail"]
