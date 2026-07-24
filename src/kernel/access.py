"""Scope-shaped access control, separate from containment (invariant 5).

Scopes are ``<domain>:<read|write>`` where domain comes from
``type_definition.domain``. Every service call carries an AccessContext and
goes through ``require`` — no service bypasses it, even single-user.
"""

from dataclasses import dataclass

ALL_SCOPES = "*"


class ScopeError(PermissionError):
    def __init__(self, scope: str) -> None:
        super().__init__(f"missing required scope: {scope}")
        self.scope = scope


@dataclass(frozen=True)
class AccessContext:
    scopes: frozenset[str]

    @classmethod
    def all(cls) -> "AccessContext":
        """Single-user default: every scope. The check still runs on each call."""
        return cls(scopes=frozenset({ALL_SCOPES}))

    @classmethod
    def of(cls, *scopes: str) -> "AccessContext":
        return cls(scopes=frozenset(scopes))


def require(ctx: AccessContext, scope: str) -> None:
    if ALL_SCOPES in ctx.scopes or scope in ctx.scopes:
        return
    raise ScopeError(scope)
