"""Unit: agent tokens are read-only by construction (ADR 010)."""

from datetime import UTC, datetime, timedelta

import jwt
import pytest

from kernel.access import has
from mcp_server.tokens import AUDIENCE, ISSUER, AgentTokenError, decode_key, mint, verify


def test_round_trip_builds_read_only_context(keypair: tuple[str, str]) -> None:
    private_pem, public_pem = keypair
    token = mint(private_pem, ["health:read"], agent="tests", days=1)
    ctx = verify(token, public_pem)
    assert has(ctx, "health:read")
    assert not has(ctx, "health:write")
    assert not has(ctx, "relationships:read")


@pytest.mark.parametrize(
    "scope", ["health:write", "*", "*:read", ":read", "health", "health:admin"]
)
def test_mint_refuses_non_read_scopes(keypair: tuple[str, str], scope: str) -> None:
    with pytest.raises(AgentTokenError, match="read"):
        mint(keypair[0], [scope], agent="tests", days=1)


def test_mint_refuses_empty_scopes(keypair: tuple[str, str]) -> None:
    with pytest.raises(AgentTokenError, match="at least one"):
        mint(keypair[0], [], agent="tests", days=1)


def test_verify_refuses_smuggled_write_scope(keypair: tuple[str, str]) -> None:
    """A hand-crafted token bypassing mint() still cannot carry a write."""
    private_pem, public_pem = keypair
    now = datetime.now(UTC)
    token = jwt.encode(
        {
            "iss": ISSUER,
            "aud": AUDIENCE,
            "sub": "agent:tests",
            "iat": now,
            "exp": now + timedelta(days=1),
            "scopes": ["health:read", "health:write"],
        },
        private_pem,
        algorithm="ES256",
    )
    with pytest.raises(AgentTokenError, match="read"):
        verify(token, public_pem)


def test_verify_refuses_expired_token(keypair: tuple[str, str]) -> None:
    private_pem, public_pem = keypair
    token = mint(private_pem, ["health:read"], agent="tests", days=-1)
    with pytest.raises(AgentTokenError, match="expired"):
        verify(token, public_pem)


def test_verify_refuses_wrong_key(
    keypair: tuple[str, str], other_keypair: tuple[str, str]
) -> None:
    token = mint(keypair[0], ["health:read"], agent="tests", days=1)
    with pytest.raises(AgentTokenError):
        verify(token, other_keypair[1])


def test_verify_requires_scopes_claim(keypair: tuple[str, str]) -> None:
    private_pem, public_pem = keypair
    now = datetime.now(UTC)
    token = jwt.encode(
        {
            "iss": ISSUER,
            "aud": AUDIENCE,
            "sub": "agent:tests",
            "iat": now,
            "exp": now + timedelta(days=1),
        },
        private_pem,
        algorithm="ES256",
    )
    with pytest.raises(AgentTokenError, match="scopes"):
        verify(token, public_pem)


def test_decode_key_refuses_garbage() -> None:
    with pytest.raises(AgentTokenError, match="base64"):
        decode_key("not base64!!")
