"""Generic agent-originated action proposals (M4-20, 07-brain-architecture.md
section 7.12, LO-4). A domain-agnostic sibling of domains.bills.dispute's own
PROPOSED -> APPROVED/REJECTED/WITHDRAWN state machine, for an arbitrary
Brain-described action rather than a bills dispute letter.

Deliberately its own entity type (``agent_action_proposal``), not bills'
own ``action_proposal`` (domains.bills.types.TYPE_PROPOSAL): that type's
schema, capture guard, and draft-letter rendering (render_draft) are all
bills-specific and tightly bound to ADR 018's dispute-letter design. Reusing
it here would mean teaching domains.bills.dispute to render a kind it was
never designed for, inside a module this Issue does not own and should not
destabilize. The two proposal kinds share a state machine SHAPE, not a
type or a module.

Approving one mints no authority to act automatically -- the same posture
dispute.py's own emit_draft keeps (ADR 018): nothing in this system ever
executes a proposal's payload on its own. Approval only records "a human
reviewed this exact summary and permits it"; whatever actually performs the
described action is a separate, human-driven step outside this module. That
is also why invariant 8 (no component combines broad reads + external
comms + high-consequence writes) holds here: propose and approve are both
writes with no external effect, so neither the (b) nor (c) leg of the
trifecta is present in this path at all.
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "agents"
TYPE_AGENT_PROPOSAL = "agent_action_proposal"

STATE_PROPOSED = "proposed"
STATE_APPROVED = "approved"
STATE_REJECTED = "rejected"
STATE_WITHDRAWN = "withdrawn"
PROPOSAL_STATES = (STATE_PROPOSED, STATE_APPROVED, STATE_REJECTED, STATE_WITHDRAWN)

# Bounded, matching bills' own "no unbounded free-text field" discipline
# (domains/bills/types.py's own header comment): a kind label and a
# one-paragraph summary are still fully expressive for a task-class
# description, and the schema drops (never truncates) anything past the
# bound rather than accepting a half-injected string.
MAX_KIND_LEN = 120
MAX_SUMMARY_LEN = 2000

AGENT_ACTION_PROPOSAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "agent_proposal_key",
        "kind",
        "state",
        "summary",
        "payload",
        "summary_digest",
        "proposed_at",
        "proposed_by",
    ],
    "properties": {
        # One proposal per (proposed_by, kind, summary) -- a retried or
        # re-submitted identical proposal resolves to the same record
        # rather than piling up duplicates (the same invariant-3 reasoning
        # domains.bills.dispute.proposal_key already documents).
        #
        # NOT named `proposal_key`, which is bills' own. ExactIdentityResolver
        # matches on the identity field *name* across every type declaring it,
        # so sharing the name would let an agent proposal and a bills proposal
        # resolve onto each other -- exactly what domains.bills.verify.OWNED_KEYS
        # embargoes `proposal_key` to prevent. Its own name, like `bill_key`,
        # `eob_key` and `cpap_receipt_key` each keep.
        "agent_proposal_key": {"type": "string", "minLength": 1, "maxLength": 128},
        "kind": {"type": "string", "minLength": 1, "maxLength": MAX_KIND_LEN},
        "state": {"enum": list(PROPOSAL_STATES)},
        "summary": {"type": "string", "minLength": 1, "maxLength": MAX_SUMMARY_LEN},
        # Opaque to this module by design, exactly like a bills draft's
        # underlying records: the Brain describes what it wants done, this
        # system stores and displays the summary, and nothing here parses
        # or acts on the payload -- propose, never execute.
        "payload": {"type": "object"},
        # sha256 of `summary` at propose time -- the same "approval binds
        # to the exact text a human read" property dispute.py's
        # draft_digest keeps, computed over the summary itself since a
        # generic proposal has no separately-rendered letter.
        "summary_digest": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
        "proposed_at": {"type": "string", "format": "date-time"},
        "proposed_by": {"type": "string", "minLength": 1, "maxLength": 128},
        "decided_at": {"type": "string", "format": "date-time"},
        # Written by approve_agent_proposal alongside decided_at. Absent
        # here until now, and with additionalProperties False that made
        # approving an agent proposal impossible: the write validated as
        # "Additional properties are not allowed ('approved_by' was
        # unexpected)" and surfaced as a 422. Bounded like proposed_by,
        # its counterpart on the other end of the decision.
        "approved_by": {"type": "string", "minLength": 1, "maxLength": 128},
    },
    # Without this the type declared NO identity field, and
    # ExactIdentityResolver's "no identity fields declared -> always NEW" rule
    # meant every capture wrote a brand-new entity. approve/reject therefore
    # created a SECOND record carrying `state: approved`, while the id the
    # caller held still addressed the original `proposed` one -- so approving
    # or rejecting appeared to succeed and changed nothing, and a decided
    # proposal could be decided again. Same declaration bills' own
    # `action_proposal` carries, for the same reason.
    "x-identity": ["agent_proposal_key"],
}


def define_agent_types(ctx: AccessContext) -> list[str]:
    """Registration step this domain runs at startup (matching every other
    domain module's own `define_<domain>_types`)."""
    return define_missing(ctx, DOMAIN, {TYPE_AGENT_PROPOSAL: AGENT_ACTION_PROPOSAL_SCHEMA})
