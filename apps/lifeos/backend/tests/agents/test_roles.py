"""Nine agent roles and the least-privilege gate acceptance tests (#591). Pure, no fixtures."""

import pytest

import domains.agents.roles as roles
from domains.agents.roles import (
    LIFEOS_EXTENSION_GRANTS,
    PERMISSION_CLASS,
    REFERENCE_GRANTS,
    ActionClass,
    Role,
    build_registry,
    decide,
    default_registry,
    revoke,
)


def _grants_for_all() -> dict[str, list[str]]:
    return {role.value: sorted(perms) for role, perms in REFERENCE_GRANTS.items()}


def test_exactly_nine_roles_with_nonempty_reference_grants() -> None:
    registry = default_registry()

    assert len(registry.grants) == 9
    assert set(registry.grants) == set(Role)
    assert all(registry.grants[role] for role in Role)
    expected = {
        role: REFERENCE_GRANTS[role] | LIFEOS_EXTENSION_GRANTS.get(role, frozenset())
        for role in Role
    }
    assert dict(registry.grants) == expected


def test_a_registry_missing_a_role_is_refused() -> None:
    grants = _grants_for_all()
    grants.pop(Role.SECURITY.value)

    with pytest.raises(ValueError, match="missing role"):
        build_registry(grants)


def test_an_unknown_role_is_refused() -> None:
    grants = _grants_for_all()
    grants["oracle"] = ["query_telemetry"]

    with pytest.raises(ValueError, match="unknown role"):
        build_registry(grants)


def test_an_empty_grant_set_is_refused() -> None:
    grants = _grants_for_all()
    grants[Role.PERSONALIZATION.value] = []

    with pytest.raises(ValueError, match="no grants"):
        build_registry(grants)


def test_a_registry_granting_an_unknown_permission_is_refused() -> None:
    grants = _grants_for_all()
    grants[Role.COMMUNICATIONS.value] = ["read_emails", "teleport_money"]

    with pytest.raises(ValueError, match="unknown permission"):
        build_registry(grants)


def test_the_default_registry_adds_only_the_recorded_launch_extension() -> None:
    registry = default_registry()

    assert "launch_two_minute_action" in registry.grants[Role.FINANCIAL_OPERATIONS]
    assert REFERENCE_GRANTS[Role.FINANCIAL_OPERATIONS] == frozenset(
        {"update_bills_sheet", "flag_declined_autopay", "draft_dispute_packet"}
    )
    assert PERMISSION_CLASS["launch_two_minute_action"] is ActionClass.DRAFT


def test_every_granted_permission_maps_to_exactly_one_action_class() -> None:
    granted = {p for perms in REFERENCE_GRANTS.values() for p in perms}

    assert granted <= set(PERMISSION_CLASS)
    assert all(isinstance(PERMISSION_CLASS[p], ActionClass) for p in granted)


def test_held_observation_draft_and_mutation_are_allowed() -> None:
    registry = default_registry()

    assert decide(registry, Role.COMMUNICATIONS, "read_emails").allowed  # observation
    assert decide(registry, Role.COMMUNICATIONS, "create_drafts").allowed  # draft
    assert decide(registry, Role.COMMUNICATIONS, "apply_labels").allowed  # reversible mutation


def test_a_permission_the_role_does_not_hold_is_denied_with_a_reason() -> None:
    registry = default_registry()

    decision = decide(registry, Role.COMMUNICATIONS, "update_bills_sheet")

    assert decision.allowed is False
    assert "does not hold" in decision.reason


def test_an_unknown_permission_is_denied_with_a_reason() -> None:
    decision = decide(default_registry(), Role.SECURITY, "teleport_money")

    assert decision.allowed is False
    assert "unknown permission" in decision.reason


def test_consequential_communication_needs_explicit_per_request_approval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(PERMISSION_CLASS, "send_email", ActionClass.CONSEQUENTIAL_COMMUNICATION)
    registry = build_registry({**_grants_for_all(), Role.COMMUNICATIONS.value: ["send_email"]})

    unapproved = decide(registry, Role.COMMUNICATIONS, "send_email")
    approved = decide(registry, Role.COMMUNICATIONS, "send_email", approved=True)

    assert unapproved.allowed is False
    assert "per-request approval" in unapproved.reason
    assert approved.allowed is True


def test_payment_is_always_refused_even_granted_and_approved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(PERMISSION_CLASS, "pay_bill", ActionClass.PAYMENT)
    registry = build_registry({**_grants_for_all(), Role.FINANCIAL_OPERATIONS.value: ["pay_bill"]})

    decision = decide(registry, Role.FINANCIAL_OPERATIONS, "pay_bill", approved=True)

    assert decision.allowed is False
    assert "always refused" in decision.reason


def test_irreversible_infra_is_always_refused_even_granted_and_approved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(PERMISSION_CLASS, "delete_repo", ActionClass.IRREVERSIBLE_INFRA)
    registry = build_registry(
        {**_grants_for_all(), Role.RELIABILITY_ENGINEER.value: ["delete_repo"]}
    )

    decision = decide(registry, Role.RELIABILITY_ENGINEER, "delete_repo", approved=True)

    assert decision.allowed is False
    assert "always refused" in decision.reason


def test_revocation_returns_a_new_registry_and_leaves_the_original_unchanged() -> None:
    original = default_registry()

    revoked = revoke(original, Role.COMMUNICATIONS, "create_drafts")

    assert "create_drafts" not in revoked.grants[Role.COMMUNICATIONS]
    assert "create_drafts" in original.grants[Role.COMMUNICATIONS]
    assert revoked is not original
    assert decide(revoked, Role.COMMUNICATIONS, "create_drafts").allowed is False
    assert decide(original, Role.COMMUNICATIONS, "create_drafts").allowed is True


def test_revoking_a_grant_the_role_lacks_changes_nothing() -> None:
    original = default_registry()

    revoked = revoke(original, Role.SECURITY, "update_bills_sheet")

    assert dict(revoked.grants) == dict(original.grants)


def test_the_module_exports_only_its_public_names() -> None:
    assert roles.Role is Role
    assert roles.ActionClass is ActionClass
