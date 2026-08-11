"""Agent tokens for the MCP seam (ADR 010).

Self-issued ES256 JWTs, verified locally: the mint side holds the private
key (guards vault / operator .env, never this repo), the server holds only
the public key. Scopes are explicit ``<domain>:read`` entries — mint and
verify both refuse anything else, so a write scope cannot exist in a valid
token, and a new domain stays dark until the operator re-mints (fail closed).
"""

import base64
import binascii
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

import jwt

from kernel.access import AccessContext

ISSUER = "lifeos"
AUDIENCE = "lifeos-mcp"

_ALGORITHM = "ES256"
_REQUIRED_CLAIMS = ["exp", "iat", "sub", "aud", "iss", "scopes"]


class AgentTokenError(Exception):
    """Token is missing, malformed, expired, or carries a non-read scope."""


def read_scopes(scopes: Iterable[str]) -> frozenset[str]:
    """Validate that every scope is ``<domain>:read`` for a concrete domain."""
    validated = frozenset(scopes)
    if not validated:
        raise AgentTokenError("agent tokens need at least one scope")
    for scope in validated:
        domain, _, action = scope.rpartition(":")
        if action != "read" or not domain or "*" in domain:
            raise AgentTokenError(f"agent scopes must be '<domain>:read', got: {scope!r}")
    return validated


def decode_key(value: str) -> str:
    """Unwrap a base64-encoded PEM key (env files are line-based, PEM is not)."""
    try:
        return base64.b64decode(value, validate=True).decode()
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise AgentTokenError("key is not base64-wrapped PEM") from exc


def mint(private_key_pem: str, scopes: Iterable[str], agent: str, days: int) -> str:
    now = datetime.now(UTC)
    claims = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": f"agent:{agent}",
        "iat": now,
        "exp": now + timedelta(days=days),
        "scopes": sorted(read_scopes(scopes)),
    }
    return jwt.encode(claims, private_key_pem, algorithm=_ALGORITHM)


def verify(token: str, public_key_pem: str) -> AccessContext:
    try:
        claims = jwt.decode(
            token,
            public_key_pem,
            algorithms=[_ALGORITHM],
            audience=AUDIENCE,
            issuer=ISSUER,
            options={"require": _REQUIRED_CLAIMS},
        )
    except jwt.PyJWTError as exc:
        raise AgentTokenError(f"invalid agent token: {exc}") from exc
    scopes = claims["scopes"]
    if not isinstance(scopes, list) or not all(isinstance(s, str) for s in scopes):
        raise AgentTokenError("malformed scopes claim")
    return AccessContext(scopes=read_scopes(scopes))
