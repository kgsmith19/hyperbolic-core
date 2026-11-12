"""Nine LifeOS agent roles and a least-privilege permission gate (#591).

Role names and standing permissions come from the reviewed 2050 architecture
reference (agent mesh, `0001-feat-lifeos-2050-core-architecture.patch`). That
reference is input only: this module owns the rules. It is pure. No execution,
no persistence, no secrets, no network, no controller identities, no endpoints.

Rules held here (from #591):

- Exactly nine roles, each with an explicit, nonempty grant set. A registry
  missing a role, or granting an unknown permission, is refused.
- Every permission maps to exactly one action class.
- A held observation, draft or reversible-mutation permission is allowed. A
  permission the role does not hold is denied, with a reason.
- A consequential communication needs an explicit per-request approval.
- Payment and irreversible infrastructure are always refused, even when granted
  and approved. The repo bans money movement.
- Revocation returns a new registry and leaves the original unchanged.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum


class Role(StrEnum):
    CHIEF_OF_STAFF = "chief_of_staff"
    FINANCIAL_OPERATIONS = "financial_operations"
    FAMILY_LOGISTICS = "family_logistics"
    COMMUNICATIONS = "communications"
    HEALTH_ADMINISTRATION = "health_administration"
    HOUSEHOLD_OPERATIONS = "household_operations"
    SECURITY = "security"
    RELIABILITY_ENGINEER = "reliability_engineer"
    PERSONALIZATION = "personalization"


class ActionClass(StrEnum):
    OBSERVATION = "observation"
    DRAFT = "draft"
    REVERSIBLE_MUTATION = "reversible_mutation"
    CONSEQUENTIAL_COMMUNICATION = "consequential_communication"
    PAYMENT = "payment"
    IRREVERSIBLE_INFRA = "irreversible_infra"


# Each standing permission in the reference, mapped to one action class.
PERMISSION_CLASS: dict[str, ActionClass] = {
    "read_all_registries": ActionClass.OBSERVATION,
    "mutate_execution_scorecard": ActionClass.REVERSIBLE_MUTATION,
    "reorder_needs_me_queue": ActionClass.REVERSIBLE_MUTATION,
    "update_bills_sheet": ActionClass.REVERSIBLE_MUTATION,
    "flag_declined_autopay": ActionClass.REVERSIBLE_MUTATION,
    "draft_dispute_packet": ActionClass.DRAFT,
    # LifeOS extension (owner decision, Q3): a launch is its own draft, not a dispute packet.
    "launch_two_minute_action": ActionClass.DRAFT,
    "check_calendar_conflicts": ActionClass.OBSERVATION,
    "generate_packing_checklist": ActionClass.DRAFT,
    "read_emails": ActionClass.OBSERVATION,
    "apply_labels": ActionClass.REVERSIBLE_MUTATION,
    "create_drafts": ActionClass.DRAFT,
    "update_health_signals_log": ActionClass.REVERSIBLE_MUTATION,
    "create_care_task": ActionClass.DRAFT,
    "pop_bedtime_cpap_reminder": ActionClass.DRAFT,
    "read_home_records": ActionClass.OBSERVATION,
    "stage_maintenance_reminders": ActionClass.DRAFT,
    "read_credential_labels": ActionClass.OBSERVATION,
    "lock_compromised_session": ActionClass.REVERSIBLE_MUTATION,
    "raise_security_alarm": ActionClass.DRAFT,
    "query_telemetry": ActionClass.OBSERVATION,
    "execute_safe_rollback": ActionClass.REVERSIBLE_MUTATION,
    "alert_on_broken_connector": ActionClass.DRAFT,
    "update_preference_weights": ActionClass.REVERSIBLE_MUTATION,
    "record_decision_receipt": ActionClass.DRAFT,
}

# The reference's standing grants for each role.
REFERENCE_GRANTS: dict[Role, frozenset[str]] = {
    Role.CHIEF_OF_STAFF: frozenset(
        {"read_all_registries", "mutate_execution_scorecard", "reorder_needs_me_queue"}
    ),
    Role.FINANCIAL_OPERATIONS: frozenset(
        {"update_bills_sheet", "flag_declined_autopay", "draft_dispute_packet"}
    ),
    Role.FAMILY_LOGISTICS: frozenset({"check_calendar_conflicts", "generate_packing_checklist"}),
    Role.COMMUNICATIONS: frozenset({"read_emails", "apply_labels", "create_drafts"}),
    Role.HEALTH_ADMINISTRATION: frozenset(
        {"update_health_signals_log", "create_care_task", "pop_bedtime_cpap_reminder"}
    ),
    Role.HOUSEHOLD_OPERATIONS: frozenset({"read_home_records", "stage_maintenance_reminders"}),
    Role.SECURITY: frozenset(
        {"read_credential_labels", "lock_compromised_session", "raise_security_alarm"}
    ),
    Role.RELIABILITY_ENGINEER: frozenset(
        {"query_telemetry", "execute_safe_rollback", "alert_on_broken_connector"}
    ),
    Role.PERSONALIZATION: frozenset({"update_preference_weights", "record_decision_receipt"}),
}


# Grants added on top of the reference, each one a recorded owner decision.
# Kept apart from REFERENCE_GRANTS so the deviation from the 2050 reference stays visible.
LIFEOS_EXTENSION_GRANTS: dict[Role, frozenset[str]] = {
    Role.FINANCIAL_OPERATIONS: frozenset({"launch_two_minute_action"}),
}


@dataclass(frozen=True, slots=True)
class Decision:
    allowed: bool
    reason: str


@dataclass(frozen=True, slots=True)
class RoleRegistry:
    grants: Mapping[Role, frozenset[str]]


def build_registry(grants: Mapping[str, Iterable[str]]) -> RoleRegistry:
    """Validate a role-to-permissions mapping: exactly the nine roles, nothing else."""
    known = {role.value: role for role in Role}
    names = set(grants)
    missing = sorted(set(known) - names)
    if missing:
        raise ValueError(f"registry is missing role(s): {', '.join(missing)}")
    unknown_roles = sorted(names - set(known))
    if unknown_roles:
        raise ValueError(f"registry names unknown role(s): {', '.join(unknown_roles)}")

    built: dict[Role, frozenset[str]] = {}
    for name, permissions in grants.items():
        held = frozenset(permissions)
        if not held:
            raise ValueError(f"role {name} has no grants; every role needs an explicit grant set")
        unknown = sorted(held - set(PERMISSION_CLASS))
        if unknown:
            raise ValueError(f"role {name} grants unknown permission(s): {', '.join(unknown)}")
        built[known[name]] = held
    return RoleRegistry(grants=built)


def default_registry() -> RoleRegistry:
    """The reference's nine roles plus the recorded LifeOS extensions, validated as one registry."""
    merged = {
        role: frozenset(perms) | LIFEOS_EXTENSION_GRANTS.get(role, frozenset())
        for role, perms in REFERENCE_GRANTS.items()
    }
    return build_registry({role.value: perms for role, perms in merged.items()})


def revoke(registry: RoleRegistry, role: Role, permission: str) -> RoleRegistry:
    """A new registry without one grant. The original is never changed."""
    held = registry.grants.get(role, frozenset())
    if permission not in held:
        return RoleRegistry(grants=dict(registry.grants))
    updated = dict(registry.grants)
    updated[role] = held - {permission}
    return RoleRegistry(grants=updated)


def decide(
    registry: RoleRegistry,
    role: Role,
    permission: str,
    *,
    approved: bool = False,
) -> Decision:
    """Decide one request from the role's grants and the permission's action class."""
    action = PERMISSION_CLASS.get(permission)
    if action is None:
        return Decision(False, f"unknown permission {permission!r}")
    if action in (ActionClass.PAYMENT, ActionClass.IRREVERSIBLE_INFRA):
        return Decision(False, f"{action.value} is always refused, even when granted and approved")
    if permission not in registry.grants.get(role, frozenset()):
        return Decision(False, f"role {role.value} does not hold {permission!r}")
    if action is ActionClass.CONSEQUENTIAL_COMMUNICATION and not approved:
        return Decision(False, "a consequential communication needs explicit per-request approval")
    return Decision(True, f"{action.value} permitted for {role.value}")
