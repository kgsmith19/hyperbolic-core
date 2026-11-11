"""Identity collisions must never silently merge LifeOS tasks."""

from uuid import UUID

import pytest

from kernel.external_identity import ExternalIdentity, IdentityConflict, IdentityCrosswalk


def test_same_legacy_id_in_different_sources_is_not_same_task() -> None:
    crosswalk = IdentityCrosswalk()
    ops = UUID("00000000-0000-4000-8000-000000000001")
    hud = UUID("00000000-0000-4000-8000-000000000002")
    assert crosswalk.register(ExternalIdentity("operations-registry", "P-02", ops))
    assert crosswalk.register(ExternalIdentity("execution-registry", "P-02", hud))
    assert crosswalk.resolve("operations-registry", "P-02") == ops
    assert crosswalk.resolve("execution-registry", "P-02") == hud


def test_repeat_is_idempotent_but_reassignment_fails_closed() -> None:
    crosswalk = IdentityCrosswalk()
    first = UUID("00000000-0000-4000-8000-000000000001")
    other = UUID("00000000-0000-4000-8000-000000000002")
    assert crosswalk.register(ExternalIdentity("google-tasks", "abc", first))
    assert not crosswalk.register(ExternalIdentity("google-tasks", "abc", first))
    with pytest.raises(IdentityConflict):
        crosswalk.register(ExternalIdentity("google-tasks", "abc", other))
    assert crosswalk.resolve("google-tasks", "abc") == first


def test_aliases_and_unknowns() -> None:
    crosswalk = IdentityCrosswalk()
    canonical = UUID("00000000-0000-4000-8000-000000000001")
    crosswalk.register(ExternalIdentity("operations-registry", "P-25", canonical))
    crosswalk.register(ExternalIdentity("execution-registry", "P-02", canonical))
    assert len(crosswalk.aliases(canonical)) == 2
    assert crosswalk.resolve("execution-registry", "P-99") is None


@pytest.mark.parametrize("source,external_id", [("", "P-02"), ("operations", ""), (" ops", "P-02")])
def test_invalid_identifiers_rejected(source: str, external_id: str) -> None:
    with pytest.raises(ValueError):
        ExternalIdentity(source, external_id, UUID("00000000-0000-4000-8000-000000000001"))


@pytest.mark.parametrize(\n    "source,external_id",\n    [(" ops", "P-02"), ("ops", " P-02"), ("ops ", "P-02")],\n)
def test_lookup_rejects_unnormalized_identifiers(source: str, external_id: str) -> None:
    crosswalk = IdentityCrosswalk()
    with pytest.raises(ValueError, match="normalized"):
        crosswalk.resolve(source, external_id)
