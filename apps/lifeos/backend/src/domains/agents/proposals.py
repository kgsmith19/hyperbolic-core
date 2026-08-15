"""Create, list, and decide generic Brain-originated action proposals.

Mediation, not scope-forwarding: `propose_action` checks the CALLER's own
`action-proposals:draft` scope (mcp_server.tokens.ACTION_PROPOSALS_DRAFT_SCOPE)
itself, then performs the actual entity write under a fixed, code-defined
internal context scoped to exactly this domain -- never the caller's own
context. A Brain token never holds `agents:write`; only this module's own
gate does, and it never receives access to any OTHER domain, since
`kernel.services.capture`'s type_name is hardcoded here to
TYPE_AGENT_PROPOSAL and no caller-supplied entity id is ever accepted. This
is the same "the service holds broader trust than its caller" shape
`kernel/services/capture.py` already gives every other write path via its
own domain-derived `require`; the difference is only that the narrow
permission checked at THIS module's own boundary is not itself
`<domain>:write`.

Response shape reuses domains.bills.dispute.ProposalView and DecisionResult
verbatim (a plain Pydantic shape import, not a call into bills' own write
logic) so the Approvals page's already-generated `ProposalView` frontend
type covers both proposal kinds with no regeneration needed -- api/main.py
is the one place that composes bills' and this domain's listings into one
response.
"""

from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

from domains.agents.types import (
    DOMAIN,
    STATE_APPROVED,
    STATE_PROPOSED,
    STATE_REJECTED,
    TYPE_AGENT_PROPOSAL,
    define_agent_types,
)
from domains.bills.dispute import (
    ApprovalRefused,
    AuthorityRefused,
    DecisionResult,
    ProposalStateError,
    ProposalView,
)
from kernel import services
from kernel.access import ALL_SCOPES, AccessContext, require
from kernel.events import DEFAULT_ACTOR
from kernel.models import Entity
from mcp_server.tokens import ACTION_PROPOSALS_DRAFT_SCOPE

# The one context this module ever acts with -- never the caller's own.
# Scoped to exactly this domain and nothing else, constructed here rather
# than accepted as a parameter so no caller can ever substitute a broader
# one.
#
# Read AND write. Every one of this module's own reads goes through this
# context -- services.find, get_entity, _load -- and so does
# define_missing(), whose whole job is to LIST the already-registered types
# and define only what is absent. With write alone that list came back
# empty, so define_agent_types() re-declared a type that already existed and
# propose_action() raised "type already defined" on its SECOND call in any
# process. Same read+write pairing bills uses for define_bills_types().
_INTERNAL_CTX = AccessContext.of(f"{DOMAIN}:read", f"{DOMAIN}:write")


def summary_digest(summary: str) -> str:
    """sha256 over the exact summary text a human reads in the Approvals
    listing -- the same "approval binds to the exact text that was read"
    property dispute.py's draft_digest keeps, computed over the summary
    itself since a generic proposal renders no separate letter."""
    return sha256(summary.encode()).hexdigest()


def agent_proposal_key(kind: str, summary: str, proposed_by: str) -> str:
    """One proposal per (proposer, kind, summary): a re-submitted identical
    proposal resolves to the same record rather than piling up duplicates
    (the same invariant-3 reasoning dispute.py's own proposal_key keeps).

    Named for this type, not `proposal_key` -- see the field's own note in
    types.py: identity resolution matches on the field NAME across types, and
    bills owns that one."""
    return sha256(f"{proposed_by}|{kind}|{summary}".encode()).hexdigest()


def _view(entity: Entity) -> ProposalView:
    attributes = entity.attributes
    state = str(attributes.get("state"))
    summary = str(attributes.get("summary") or "")
    return ProposalView(
        proposal_id=entity.id,
        kind=str(attributes.get("kind")),
        state=state,
        subject_ids=[],
        verification_receipt_id=None,
        points=[],
        unresolved_count=0,
        authority_receipt_id=None,
        # Mirrors dispute.py's own ProposalView.body contract: readable
        # only while `proposed` (a decided proposal's summary is history,
        # not something the listing re-serves as if still awaiting
        # review).
        body=summary if state == STATE_PROPOSED else None,
        draft_digest=str(attributes.get("summary_digest")) if state == STATE_PROPOSED else None,
    )


def propose_action(
    ctx: AccessContext,
    kind: str,
    summary: str,
    payload: dict[str, Any],
    proposed_by: str,
) -> ProposalView:
    """The Brain's `proposeAction` (05-e-lifeos.md section 3). Creates a
    PENDING proposal and nothing else -- no entity other than the proposal
    record itself is ever touched here, which is what makes LO-4b's "no
    entity shall change until operator approval" true by construction
    rather than by a check that could be wrong."""
    require(ctx, ACTION_PROPOSALS_DRAFT_SCOPE)
    define_agent_types(_INTERNAL_CTX)

    # Return an existing proposal untouched rather than capturing over it.
    # This is NOT made redundant by the type's x-identity: a capture would
    # resolve onto the same record, but it would also write `state: proposed`
    # back over a proposal a human had already approved or rejected. Re-
    # proposing is idempotent; it is never a way to reopen a decision.
    key = agent_proposal_key(kind, summary, proposed_by)
    existing = services.find(
        _INTERNAL_CTX, type_name=TYPE_AGENT_PROPOSAL, filters={"agent_proposal_key": key}
    )
    if existing:
        return _view(existing[0])

    now = datetime.now(UTC)
    attributes = {
        "agent_proposal_key": key,
        "kind": kind,
        "state": STATE_PROPOSED,
        "summary": summary,
        "payload": payload,
        "summary_digest": summary_digest(summary),
        "proposed_at": now.isoformat(),
        "proposed_by": proposed_by,
    }
    result = services.capture(_INTERNAL_CTX, TYPE_AGENT_PROPOSAL, attributes, actor=DEFAULT_ACTOR)
    view = services.get_entity(_INTERNAL_CTX, result.entity_id)
    return _view(view.entity)


def list_agent_proposals(ctx: AccessContext, state: str | None = None) -> list[ProposalView]:
    """Read-only; approving/rejecting is never a side effect of listing.
    Requires the caller's own read access -- unlike propose_action, a
    listing is not mediated through an internal elevated context, since
    read access to this domain is exactly what `agents:read` already
    means and there is no narrower scope for it to hide behind."""
    filters = {"state": state} if state else None
    entities = services.find(ctx, type_name=TYPE_AGENT_PROPOSAL, filters=filters)
    return [_view(e) for e in entities]


def _load(ctx: AccessContext, proposal_id: UUID) -> dict[str, Any]:
    view = services.get_entity(ctx, proposal_id)
    if TYPE_AGENT_PROPOSAL not in view.types:
        raise ValueError(f"entity {proposal_id} is not a {TYPE_AGENT_PROPOSAL}")
    return view.entity.attributes


def is_agent_proposal(ctx: AccessContext, proposal_id: UUID) -> bool:
    """api/main.py's own dispatch point: which domain module owns this
    proposal id, so the shared `POST /action-proposals/{id}/approve|reject`
    routes can route to the right one without either domain needing to
    know about the other."""
    try:
        view = services.get_entity(ctx, proposal_id)
    except LookupError:
        return False
    return TYPE_AGENT_PROPOSAL in view.types


def approve_agent_proposal(
    ctx: AccessContext,
    proposal_id: UUID,
    expected_summary_digest: str,
    granted_by: str,
    actor: str = DEFAULT_ACTOR,
) -> DecisionResult:
    """Records that a human reviewed and permits this proposal. Mints no
    authority to act -- there is nothing here that could act. Refuses
    unless the caller echoes the digest of the exact summary they read,
    the same discipline dispute.py's own approve_proposal keeps for its
    draft letter."""
    require(ctx, f"{DOMAIN}:write")
    if ALL_SCOPES not in ctx.scopes:
        # Same guard as dispute.py's own approve_proposal, restated here
        # rather than shared, since the two live in different modules
        # deliberately (this module's own header comment). No legitimately
        # minted agent token can hold `agents:write` today (mcp_server/
        # tokens.py only ever issues `<domain>:read` or
        # `action-proposals:draft`), so this branch is unreachable through
        # any real token -- checked anyway, because "cannot happen today"
        # is not the same claim as "structurally cannot happen."
        raise ApprovalRefused(
            "a proposal is approved only under the owner's own unrestricted session; "
            "a scope-narrowed context may read a proposal but may not approve one"
        )
    attributes = _load(_INTERNAL_CTX, proposal_id)
    if attributes.get("state") != STATE_PROPOSED:
        raise ProposalStateError(
            f"proposal {proposal_id} is {attributes.get('state')}, not {STATE_PROPOSED}"
        )
    current_digest = attributes.get("summary_digest")
    if current_digest != expected_summary_digest:
        # AuthorityRefused (a ValueError subclass, api/main.py's own 403
        # mapping), not a bare ValueError: this is bills' own DraftChanged
        # case restated for a summary instead of a rendered letter -- "the
        # text you're approving is not the text you read" is a refused
        # authorization, not a 422 bad-input shape.
        raise AuthorityRefused(
            "this summary is not the text that was read; re-read the proposal and approve again"
        )

    now = datetime.now(UTC)
    services.capture(
        _INTERNAL_CTX,
        TYPE_AGENT_PROPOSAL,
        {
            **attributes,
            "state": STATE_APPROVED,
            "decided_at": now.isoformat(),
            "approved_by": granted_by,
        },
        actor=actor,
    )
    return DecisionResult(proposal_id=proposal_id, state=STATE_APPROVED)


def reject_agent_proposal(
    ctx: AccessContext, proposal_id: UUID, actor: str = DEFAULT_ACTOR
) -> DecisionResult:
    """Say no. Mints nothing -- there is no authority in a refusal."""
    require(ctx, f"{DOMAIN}:write")
    attributes = _load(_INTERNAL_CTX, proposal_id)
    if attributes.get("state") != STATE_PROPOSED:
        raise ProposalStateError(
            f"proposal {proposal_id} is {attributes.get('state')}, not {STATE_PROPOSED}"
        )
    services.capture(
        _INTERNAL_CTX,
        TYPE_AGENT_PROPOSAL,
        {**attributes, "state": STATE_REJECTED, "decided_at": datetime.now(UTC).isoformat()},
        actor=actor,
    )
    return DecisionResult(proposal_id=proposal_id, state=STATE_REJECTED)


class AgentProposalCaptureRefused(ValueError):
    pass


def guard_capture(type_name: str, attributes: dict[str, Any]) -> None:
    """Refuse a `POST /capture` that would land on an agent proposal record
    (mirrors `domains.documents.capture.guard_capture`'s own simpler,
    no-identity-field case). No caller external to this module legitimately
    holds `agents:write` (mcp_server/tokens.py never mints it, and this
    module's own internal context is a code constant, never exposed) --
    but the generic capture route is still refused explicitly, the same
    belt-and-suspenders posture every other proposal-shaped type in this
    codebase already keeps, so a proposal can never be constructed
    pre-decided (e.g. `state: "approved"`) by skipping propose_action/
    approve_agent_proposal's own state-machine discipline.
    """
    if type_name == TYPE_AGENT_PROPOSAL:
        raise AgentProposalCaptureRefused(
            "'agent_action_proposal' records are written by propose_action/"
            "approve_agent_proposal/reject_agent_proposal, never by a direct capture"
        )
