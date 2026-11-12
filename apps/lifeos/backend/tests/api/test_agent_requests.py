"""Agent controller requests at the HTTP door (#596).

A real agent token (minted and verified with the same functions production uses)
calls POST /agents/requests. The claims under test are about who may ask, as what,
and that nothing is approved or executed. Each test uses its own idempotency key,
since the session database is shared.
"""

import base64
import os
from collections.abc import Iterator
from uuid import uuid4

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
from domains.agents.receipts import get_by_key
from domains.agents.requests import requester_of
from domains.agents.roles import Role
from kernel.access import AccessContext
from mcp_server.tokens import AGENTS_REQUEST_SCOPE, AgentTokenError, mint, verify

_KEY = ec.generate_private_key(ec.SECP256R1())
_PRIVATE = _KEY.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
_PUBLIC = _KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
READ = AccessContext.of("agents:read")

client = TestClient(app)


@pytest.fixture(autouse=True)
def platform_mode(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("LIFEOS_AUTH_MODE", "platform")
    monkeypatch.setenv("LIFEOS_PLATFORM_URL", "http://127.0.0.1:8400")
    monkeypatch.setenv("LIFEOS_OWNER_USER_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.setenv("LIFEOS_AGENT_JWT_PUBLIC_KEY", base64.b64encode(_PUBLIC.encode()).decode())
    monkeypatch.setattr(auth, "read_env", lambda name: os.environ.get(name))
    yield


def claude_code() -> str:
    return mint(
        _PRIVATE,
        [AGENTS_REQUEST_SCOPE],
        agent="claude-code",
        days=30,
        roles=["financial_operations", "reliability_engineer"],
    )


def chatgpt() -> str:
    return mint(
        _PRIVATE,
        [AGENTS_REQUEST_SCOPE],
        agent="chatgpt",
        days=30,
        roles=["communications", "household_operations"],
    )


def ask(token: str, **body: object) -> tuple[int, dict[str, object]]:
    response = client.post(
        "/agents/requests", json=body, headers={"Authorization": f"Bearer {token}"}
    )
    return response.status_code, response.json()


def _key() -> str:
    return f"idem-{uuid4().hex}"


def test_an_allowed_request_records_requested_by_from_the_token_and_executes_nothing() -> None:
    """The receipt is allowed, `requested_by` is the verified subject, and nothing ran."""
    key = _key()
    status, body = ask(
        claude_code(),
        role="reliability_engineer",
        permission="query_telemetry",
        idempotency_key=key,
    )
    assert status == 200, body
    assert body["allowed"] is True
    assert body["requested_by"] == "agent:claude-code"
    assert body["executed"] is False
    assert requester_of(READ, str(body["receipt_key"])) == "agent:claude-code"


def test_a_retry_returns_the_original_receipt_as_a_duplicate() -> None:
    """Same controller, same key: one receipt, read back as a duplicate."""
    key = _key()
    args = {"role": "communications", "permission": "create_drafts", "idempotency_key": key}
    first_status, first = ask(chatgpt(), **args)
    second_status, second = ask(chatgpt(), **args)
    assert (first_status, second_status) == (200, 200)
    assert first["duplicate"] is False and second["duplicate"] is True
    assert first["receipt_key"] == second["receipt_key"]


def test_two_controllers_with_the_same_key_never_share_a_receipt() -> None:
    """The key is namespaced by the requester, so neither can read the other's answer."""
    key = _key()
    _, mine = ask(
        claude_code(),
        role="reliability_engineer",
        permission="query_telemetry",
        idempotency_key=key,
    )
    owner_like = mint(
        _PRIVATE, [AGENTS_REQUEST_SCOPE], agent="other", days=1, roles=["reliability_engineer"]
    )
    _, theirs = ask(
        owner_like, role="reliability_engineer", permission="query_telemetry", idempotency_key=key
    )
    assert mine["receipt_key"] != theirs["receipt_key"]
    assert theirs["duplicate"] is False


def test_a_role_outside_the_token_allowlist_is_refused_and_nothing_is_recorded() -> None:
    """ChatGPT may not ask as Financial Operations, Security or Chief of Staff."""
    for role, permission in (
        ("financial_operations", "draft_dispute_packet"),
        ("security", "raise_security_alarm"),
        ("chief_of_staff", "read_all_registries"),
    ):
        key = _key()
        status, body = ask(chatgpt(), role=role, permission=permission, idempotency_key=key)
        assert status == 403, body
        assert "may not request as" in str(body["detail"])
        assert get_by_key(READ, Role(role), permission, f"agent:chatgpt\x1f{key}") is None


def test_only_observation_and_draft_may_be_requested() -> None:
    """A reversible mutation is refused before the gate, even for a role that holds it."""
    status, body = ask(
        claude_code(),
        role="reliability_engineer",
        permission="execute_safe_rollback",
        idempotency_key=_key(),
    )
    assert status == 403
    assert "observation or draft" in str(body["detail"])


def test_approved_and_requested_by_cannot_be_sent() -> None:
    """The body has no `approved` or `requested_by`; sending either is refused (422)."""
    for extra in ({"approved": True}, {"requested_by": "owner"}):
        status, _ = ask(
            chatgpt(),
            role="communications",
            permission="create_drafts",
            idempotency_key=_key(),
            **extra,
        )
        assert status == 422


def test_a_token_without_agents_request_is_refused() -> None:
    """A read or proposal token cannot reach the gate."""
    token = mint(_PRIVATE, ["ops:read"], agent="brain", days=1)
    status, _ = ask(
        token, role="communications", permission="create_drafts", idempotency_key=_key()
    )
    assert status == 403


def test_the_scope_needs_an_allowlist_and_an_allowlist_needs_the_scope() -> None:
    """Mint refuses `agents:request` without roles, and roles without the scope."""
    with pytest.raises(AgentTokenError, match="non-empty roles"):
        mint(_PRIVATE, [AGENTS_REQUEST_SCOPE], agent="x", days=1)
    with pytest.raises(AgentTokenError, match="needs the 'agents:request'"):
        mint(_PRIVATE, ["ops:read"], agent="x", days=1, roles=["communications"])
    with pytest.raises(AgentTokenError, match="malformed role"):
        mint(_PRIVATE, [AGENTS_REQUEST_SCOPE], agent="x", days=1, roles=["Bad Role"])
    assert verify(claude_code(), _PUBLIC).scopes == frozenset({AGENTS_REQUEST_SCOPE})
