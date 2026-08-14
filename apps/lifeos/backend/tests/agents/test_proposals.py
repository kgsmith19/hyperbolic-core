"""Unit + integration: generic Brain-originated action proposals (M4-20,
07-brain-architecture.md section 7.12, LO-4).

Nothing in this module executes a proposal's payload, so there is nothing
to fake-send and nothing to verify was never sent -- the same reasoning
tests/bills/test_dispute.py states for its own module.

Tests share the session database, so every test uses its own kind/summary
marker to avoid colliding with another test's proposal_key.
"""

from uuid import uuid4

import pytest

from domains.agents.proposals import (
    AgentProposalCaptureRefused,
    approve_agent_proposal,
    guard_capture,
    is_agent_proposal,
    list_agent_proposals,
    proposal_key,
    propose_action,
    reject_agent_proposal,
    summary_digest,
)
from domains.agents.types import (
    STATE_APPROVED,
    STATE_PROPOSED,
    STATE_REJECTED,
    TYPE_AGENT_PROPOSAL,
)
from domains.bills.dispute import ApprovalRefused, AuthorityRefused, ProposalStateError
from kernel.access import AccessContext
from mcp_server.tokens import ACTION_PROPOSALS_DRAFT_SCOPE

DRAFT_ONLY_CTX = AccessContext.of(ACTION_PROPOSALS_DRAFT_SCOPE)
OWNER_CTX = AccessContext.all()


def a_marker() -> str:
    return f"agentprop{uuid4().hex[:12]}"


def test_propose_action_creates_a_pending_proposal_readable_by_the_owner(seeded: object) -> None:
    marker = a_marker()
    view = propose_action(
        DRAFT_ONLY_CTX,
        "test.kind",
        f"do the thing {marker}",
        {"note": marker},
        proposed_by="agent:brain",
    )

    assert view.state == STATE_PROPOSED
    assert view.kind == "test.kind"
    assert view.body == f"do the thing {marker}"
    assert view.draft_digest == summary_digest(f"do the thing {marker}")

    listed = list_agent_proposals(OWNER_CTX, state=STATE_PROPOSED)
    assert any(p.proposal_id == view.proposal_id for p in listed)


def test_propose_action_requires_the_draft_scope_and_nothing_narrower_substitutes(
    seeded: object,
) -> None:
    marker = a_marker()
    with pytest.raises(PermissionError):
        propose_action(
            AccessContext.of("bills:read"), "test.kind", marker, {}, proposed_by="agent:brain"
        )


def test_propose_action_is_idempotent_for_the_identical_proposer_kind_summary(
    seeded: object,
) -> None:
    marker = a_marker()
    first = propose_action(DRAFT_ONLY_CTX, "test.kind", marker, {"a": 1}, proposed_by="agent:brain")
    second = propose_action(
        DRAFT_ONLY_CTX, "test.kind", marker, {"a": 1}, proposed_by="agent:brain"
    )
    assert first.proposal_id == second.proposal_id


def test_proposing_never_touches_any_entity_other_than_the_proposal_itself(seeded: object) -> None:
    """LO-4b, the load-bearing half: 'no entity shall change until operator
    approval.' propose_action's own write path only ever calls
    services.capture with TYPE_AGENT_PROPOSAL -- this is the behavioral
    proof that a proposal, freshly created, is the only new/changed record."""
    marker = a_marker()
    before = list_agent_proposals(OWNER_CTX)
    propose_action(DRAFT_ONLY_CTX, "test.kind", marker, {}, proposed_by="agent:brain")
    after = list_agent_proposals(OWNER_CTX)
    assert len(after) == len(before) + 1


def test_is_agent_proposal_distinguishes_this_type_from_anything_else(seeded: object) -> None:
    marker = a_marker()
    view = propose_action(DRAFT_ONLY_CTX, "test.kind", marker, {}, proposed_by="agent:brain")
    assert is_agent_proposal(OWNER_CTX, view.proposal_id) is True
    assert is_agent_proposal(OWNER_CTX, uuid4()) is False


def test_approve_requires_the_exact_summary_digest(seeded: object) -> None:
    marker = a_marker()
    view = propose_action(DRAFT_ONLY_CTX, "test.kind", marker, {}, proposed_by="agent:brain")
    with pytest.raises(AuthorityRefused):
        approve_agent_proposal(OWNER_CTX, view.proposal_id, "0" * 64, granted_by="owner")


def test_approve_then_reject_the_same_proposal_is_refused_already_decided(seeded: object) -> None:
    marker = a_marker()
    view = propose_action(DRAFT_ONLY_CTX, "test.kind", marker, {}, proposed_by="agent:brain")
    approved = approve_agent_proposal(
        OWNER_CTX, view.proposal_id, view.draft_digest, granted_by="owner"
    )
    assert approved.state == STATE_APPROVED

    with pytest.raises(ProposalStateError):
        reject_agent_proposal(OWNER_CTX, view.proposal_id)

    listed = list_agent_proposals(OWNER_CTX)
    mine = [p for p in listed if p.proposal_id == view.proposal_id]
    assert mine[0].state == STATE_APPROVED
    # a decided proposal's summary is no longer served by the listing --
    # mirrors dispute.py's own ProposalView.body contract exactly.
    assert mine[0].body is None
    assert mine[0].draft_digest is None


def test_reject_ends_it_and_a_decided_proposal_cannot_then_be_approved(seeded: object) -> None:
    marker = a_marker()
    view = propose_action(DRAFT_ONLY_CTX, "test.kind", marker, {}, proposed_by="agent:brain")
    rejected = reject_agent_proposal(OWNER_CTX, view.proposal_id)
    assert rejected.state == STATE_REJECTED

    with pytest.raises(ProposalStateError):
        approve_agent_proposal(OWNER_CTX, view.proposal_id, view.draft_digest, granted_by="owner")


def test_approve_refuses_a_scope_narrowed_context_even_if_it_somehow_held_write(
    seeded: object,
) -> None:
    """No legitimately minted agent token can hold `agents:write` (mcp_server
    tokens.py never issues it) -- checked anyway, defense in depth, the
    same posture dispute.py's own approve_proposal keeps."""
    marker = a_marker()
    view = propose_action(DRAFT_ONLY_CTX, "test.kind", marker, {}, proposed_by="agent:brain")
    scoped_but_not_owner = AccessContext.of("agents:write")
    with pytest.raises(ApprovalRefused):
        approve_agent_proposal(
            scoped_but_not_owner, view.proposal_id, view.draft_digest, granted_by="someone"
        )


def test_guard_capture_refuses_a_direct_capture_of_the_proposal_type(seeded: object) -> None:
    with pytest.raises(AgentProposalCaptureRefused):
        guard_capture(TYPE_AGENT_PROPOSAL, {"proposal_key": "a" * 64, "state": STATE_APPROVED})


def test_guard_capture_allows_every_other_type_name(seeded: object) -> None:
    guard_capture("something_else", {})  # must not raise


def test_proposal_key_is_stable_for_identical_inputs_and_differs_otherwise(seeded: object) -> None:
    a = proposal_key("kind-a", "summary-a", "agent:brain")
    b = proposal_key("kind-a", "summary-a", "agent:brain")
    c = proposal_key("kind-b", "summary-a", "agent:brain")
    assert a == b
    assert a != c
