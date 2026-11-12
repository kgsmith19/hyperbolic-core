"""Agent tokens for the MCP seam (ADR 010).

Self-issued ES256 JWTs, verified locally: the mint side holds the private
key (guards vault / operator .env, never this repo), the server holds only
the public key. Scopes are ``<domain>:read`` entries, plus exactly one
sanctioned exceptions: ``action-proposals:draft`` (M4-20,
07-brain-architecture.md section 7.12, LO-4c) — the Brain's proposal lane —
and ``agents:request`` (#596), which lets a controller ask the role gate for a
decision and nothing else. An ``agents:request`` token must carry a non-empty
``roles`` allowlist; no other token may carry one.
Mint and verify both refuse everything else, so no other write scope and no
wildcard can exist in a valid token, and a new domain stays dark until the
operator re-mints (fail closed).
"""

import base64
import binascii
import re
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

import jwt

from kernel.access import AccessContext

ISSUER = "lifeos"
AUDIENCE = "lifeos-mcp"

_ALGORITHM = "ES256"
_REQUIRED_CLAIMS = ["exp", "iat", "sub", "aud", "iss", "scopes"]

# The one write-shaped scope a minted agent token may ever carry (LO-4c):
# create-only access to the generic action-proposal lane
# (domains/agents/proposals.py). Not a domain scope -- it names an action,
# not a `<domain>:<read|write>` pair, which is why it is checked as an
# exact literal rather than by the domain/action split below.
ACTION_PROPOSALS_DRAFT_SCOPE = "action-proposals:draft"

# Ask the role gate for a decision (#596). Like the proposal lane, an exact
# literal: it names an action, never `agents:write`, and executes nothing.
AGENTS_REQUEST_SCOPE = "agents:request"
_EXACT_SCOPES = frozenset({ACTION_PROPOSALS_DRAFT_SCOPE, AGENTS_REQUEST_SCOPE})
_ROLE = re.compile(r"^[a-z][a-z_]{0,63}$")


class AgentTokenError(Exception):
    """Token is missing, malformed, expired, or carries a scope that is
    neither ``<domain>:read`` nor the one sanctioned
    ``action-proposals:draft`` exception."""


def read_scopes(scopes: Iterable[str]) -> frozenset[str]:
    """Validate that every scope is ``<domain>:read`` for a concrete domain,
    or exactly ``action-proposals:draft``. A wildcard is refused either way
    -- it is never treated as a member of either sanctioned shape, so a
    token cannot smuggle broader access by pairing it with a legitimate
    scope name."""
    validated = frozenset(scopes)
    if not validated:
        raise AgentTokenError("agent tokens need at least one scope")
    for scope in validated:
        if scope in _EXACT_SCOPES:
            continue
        domain, _, action = scope.rpartition(":")
        if action != "read" or not domain or "*" in domain:
            raise AgentTokenError(
                f"agent scopes must be '<domain>:read' or one of "
                f"{sorted(_EXACT_SCOPES)}, got: {scope!r}"
            )
    return validated


def request_roles(scopes: frozenset[str], roles: Iterable[str] | None) -> tuple[str, ...]:
    """Validate the role allowlist: required with ``agents:request``, refused without.
    Role names are checked for shape here; the gate checks them against its roles."""
    held = tuple(sorted(set(roles or ())))
    if AGENTS_REQUEST_SCOPE not in scopes:
        if held:
            raise AgentTokenError(f"a roles allowlist needs the {AGENTS_REQUEST_SCOPE!r} scope")
        return ()
    if not held:
        raise AgentTokenError(f"{AGENTS_REQUEST_SCOPE!r} needs a non-empty roles allowlist")
    for role in held:
        if not isinstance(role, str) or not _ROLE.fullmatch(role):
            raise AgentTokenError(f"malformed role in allowlist: {role!r}")
    return held


def decode_key(value: str) -> str:
    """Unwrap a base64-encoded PEM key (env files are line-based, PEM is not)."""
    try:
        return base64.b64decode(value, validate=True).decode()
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise AgentTokenError("key is not base64-wrapped PEM") from exc


def mint(
    private_key_pem: str,
    scopes: Iterable[str],
    agent: str,
    days: int,
    roles: Iterable[str] | None = None,
) -> str:
    now = datetime.now(UTC)
    validated = read_scopes(scopes)
    allowlist = request_roles(validated, roles)
    claims: dict[str, object] = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": f"agent:{agent}",
        "iat": now,
        "exp": now + timedelta(days=days),
        "scopes": sorted(validated),
    }
    if allowlist:
        claims["roles"] = list(allowlist)
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
    validated = read_scopes(scopes)
    roles = claims.get("roles")
    if roles is not None and (
        not isinstance(roles, list) or not all(isinstance(r, str) for r in roles)
    ):
        raise AgentTokenError("malformed roles claim")
    request_roles(validated, roles)
    return AccessContext(scopes=validated)
