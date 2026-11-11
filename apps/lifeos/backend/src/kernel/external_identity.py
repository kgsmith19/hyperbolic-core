"""Fail-closed external identity crosswalk for LifeOS adapters (#535).

This module deliberately does not write kernel state or call external services.
Canonical entity IDs are assigned by the existing LifeOS kernel, not here.
"""

from dataclasses import dataclass
from uuid import UUID


class IdentityConflict(ValueError):
    """A source identifier would point at multiple canonical entities."""


@dataclass(frozen=True, slots=True)
class ExternalIdentity:
    source: str
    external_id: str
    canonical_id: UUID

    def __post_init__(self) -> None:
        if not self.source.strip() or not self.external_id.strip():
            raise ValueError("source and external_id must be nonblank")
        if self.source != self.source.strip() or self.external_id != self.external_id.strip():
            raise ValueError("identifiers must be normalized before registration")


class IdentityCrosswalk:
    """In-memory validation primitive; persistence must use kernel services.

    The namespace is the *source system*, not a shared legacy P-number.
    Never infer identity from a display title or a matching short ID.
    """

    def __init__(self) -> None:
        self._by_external: dict[tuple[str, str], UUID] = {}
        self._by_canonical: dict[UUID, set[tuple[str, str]]] = {}

    def register(self, identity: ExternalIdentity) -> bool:
        key = (identity.source, identity.external_id)
        previous = self._by_external.get(key)
        if previous is not None:
            if previous != identity.canonical_id:
                raise IdentityConflict("source identifier already belongs to another entity")
            return False
        self._by_external[key] = identity.canonical_id
        self._by_canonical.setdefault(identity.canonical_id, set()).add(key)
        return True

    def resolve(self, source: str, external_id: str) -> UUID | None:
        if not source.strip() or not external_id.strip():
            raise ValueError("source and external_id must be nonblank")
        return self._by_external.get((source, external_id))

    def aliases(self, canonical_id: UUID) -> frozenset[tuple[str, str]]:
        return frozenset(self._by_canonical.get(canonical_id, set()))
