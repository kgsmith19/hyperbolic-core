"""The controller-token contract for external minters (#596, hyper-agents #82).

hyper-agents mints and renews the standing controller tokens without this codebase
(op ``lifeos.controller_tokens.renew``). This test pins the exact wire format it
produces -- hand-built with PyJWT, not with ``mint()`` -- so a change here that would
reject those tokens fails in this repository first.

Contract (ES256 JWT):
  iss="lifeos", aud="lifeos-mcp", sub="agent:<name>", iat, exp,
  scopes=["agents:request"], roles=<sorted non-empty list>.
Keys are base64-wrapped PEM (PKCS8 private, SubjectPublicKeyInfo public).
"""

import base64
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
from fastapi.testclient import TestClient

from api import auth
from api.main import app
from mcp_server.tokens import AGENTS_REQUEST_SCOPE, decode_key, verify

_KEY = ec.generate_private_key(ec.SECP256R1())
_PRIVATE_B64 = base64.b64encode(
    _KEY.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
).decode()
_PUBLIC_B64 = base64.b64encode(
    _KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
).decode()

client = TestClient(app)


@pytest.fixture(autouse=True)
def platform_mode(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("LIFEOS_AUTH_MODE", "platform")
    monkeypatch.setenv("LIFEOS_PLATFORM_URL", "http://127.0.0.1:8400")
    monkeypatch.setenv("LIFEOS_OWNER_USER_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.setenv("LIFEOS_AGENT_JWT_PUBLIC_KEY", _PUBLIC_B64)
    monkeypatch.setattr(auth, "read_env", lambda name: os.environ.get(name))
    yield


def external_token(agent: str, roles: list[str], days: int = 30) -> str:
    """Exactly what the external minter produces."""
    now = datetime.now(UTC)
    claims = {
        "iss": "lifeos",
        "aud": "lifeos-mcp",
        "sub": f"agent:{agent}",
        "iat": now,
        "exp": now + timedelta(days=days),
        "scopes": [AGENTS_REQUEST_SCOPE],
        "roles": sorted(roles),
    }
    return jwt.encode(claims, decode_key(_PRIVATE_B64), algorithm="ES256")


def ask(token: str, role: str, permission: str) -> tuple[int, dict[str, object]]:
    response = client.post(
        "/agents/requests",
        json={"role": role, "permission": permission, "idempotency_key": f"c-{uuid4().hex}"},
        headers={"Authorization": f"Bearer {token}"},
    )
    return response.status_code, response.json()


def test_an_externally_minted_controller_token_verifies_with_the_vault_key_format() -> None:
    token = external_token("claude-code", ["reliability_engineer", "financial_operations"])
    context = verify(token, decode_key(_PUBLIC_B64))
    assert context.scopes == frozenset({AGENTS_REQUEST_SCOPE})  # exactly the one scope


def test_the_route_allows_a_low_risk_request_and_denies_another_role() -> None:
    claude = external_token("claude-code", ["financial_operations", "reliability_engineer"])
    chatgpt = external_token("chatgpt", ["communications", "household_operations"])
    status, body = ask(claude, "reliability_engineer", "query_telemetry")
    assert status == 200, body
    assert body["allowed"] is True and body["executed"] is False
    assert body["requested_by"] == "agent:claude-code"
    status, body = ask(chatgpt, "financial_operations", "draft_dispute_packet")
    assert status == 403, body
