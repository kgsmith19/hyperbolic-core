# ADR 018: Action proposals, authority receipts, and the gate that has nothing behind it

## Decision

**Shape.** Two new `type_definition` rows (`action_proposal`,
`authority_receipt`, domain `bills`) and one module
`src/domains/bills/dispute.py`, plus four API routes — zero kernel DDL
(invariant 1, ADR 002), no new deployable and no new repo (ADR 009). **No
kernel change.**

**One migration**, and it is not for the new types: those are absent everywhere,
so `define_missing` creates them. It is for `bill` and `eob`, whose
`service_date` / `due_date` gain a character-class bound —
`scripts/migrate_bill_date_charset.py`, idempotent, run once per environment.
See "A date is now prose" below.

**Scope of C4.** C2 proposes candidates, C3 disposes of them by arithmetic, and
this slice takes the first step *outward* — a failed verification can produce a
DRAFT dispute letter. It is proposed, never sent. The terminal state is an
approved draft on a screen. There is no SMTP, no HTTP client, no socket, no
outbound call of any kind anywhere in this path, and the types below cannot
express one.

### The three artifacts

`action_proposal` is a proposed outward-facing action: its `kind`
(`dispute_draft`), the `subject_ids` it concerns, the `verification_receipt_id`
it rests on, a `state` (`proposed` / `approved` / `rejected` / `withdrawn`),
and the failing checks it would state. It lives in `bills`, which is the whole
reason it needs no `x-sensitive` flag of its own: withholding from the shared
agent-tool surface is *declared per type and enforced per domain* because
scopes are domain-shaped (invariant 5), and `bill`/`eob` already carry the flag,
so every type in this domain — proposals and authority receipts included — is
already withheld from both LLM doors (ADR 016/017, confirmed against
`mcp_server.tools.agent_read_context` rather than assumed). A dispute draft is
the last thing that should reach a model through a generic read tool.

`authority_receipt` is what an explicit approval mints: the proposal, the
subjects, the verification receipt, the digest of the exact draft that was
read, **who** approved (the authenticated owner), **when**, until when, and the
constraints of the grant. It has no `x-identity` field, deliberately — every
approval is a distinct act and must never resolve onto an earlier one, the
`execution_receipt` precedent (ADR 014) — which also means nothing can merge
into one, because nothing can match one.

The **gate** is `dispute.emit_draft`: the one function that hands a draft out.
It refuses unless a valid, matching, unexpired authority receipt covers this
exact text, and a refusal writes nothing at all.

**"The one function that hands a draft out" is a claim the code has to keep
true, and the first draft of this slice did not.** `proposal_view` renders the
same bytes through `render_draft` and returned them as `body` for **every**
proposal in **every** state, with no authority check — while the act the grant
authorises is literally `permits: ["display_draft"], channel: "on_screen"`, the
act that listing performs. Approve, let the seven days lapse, and the gate would
403 while `GET /action-proposals` served the identical text at 200: every row of
the refusal table below defeated by the adjacent route, in exactly the shape a
UI or a future sender would reuse.

So the draft is included in a `ProposalView` **only while the proposal is
`proposed`**. That state is where reading is a prerequisite to deciding — an
approver cannot approve text they may not see, and there is no grant to check
because none exists yet. Every decided state reaches the letter only through
`emit_draft`. What makes the rule hold rather than merely start out true is that
the state machine is a one-way door: `propose_for_receipt` *holds* anything
already decided and never rewrites it back to `proposed`, so a lapsed grant
cannot fall back into the readable state.
`test_the_listing_stops_serving_the_draft_the_moment_it_is_decided` builds the
lapsed-grant case and asserts the gate and the listing agree;
`test_a_rejected_proposal_is_never_returned_to_the_readable_state` asserts the
door.

The metadata a reviewer needs — state, points, subject ids, the authority id —
stays in the listing throughout. Only the letter is gated.

### The draft body: rendered, never stored

This is the decision the slice turns on, and there was a wrong answer available.

A dispute letter necessarily contains PHI-ish text: the provider's name, the
account reference, the service date, the amounts. Three places it could live:

1. **An `x-pii` attribute on the proposal.** Rejected. `entity.search` is a
   generated tsvector over `attributes::text` and `forget()` is strictly
   per-entity, so the letter would be full-text searchable by anything holding
   `bills:read` and erasable only by erasing the proposal itself — while the
   *candidate* it was copied from could be erased and leave the copy standing.
   That is the binding B1/C1/C2 finding (ADR 015 §"Bytes and text live on the
   filesystem", ADR 016 §"No unbounded free-text field") for the fourth time,
   and the bills constitution states it as a rule: *no unbounded free-text
   field, anywhere*. An `x-pii` flag would make it erasable in one place and
   leave it derived-and-stale in another; it does not make it safe.
2. **The blob store the documents domain owns.** Rejected, for three reasons.
   The store is content-addressed by sha256 over *uploaded document bytes* and
   is reached through `documents.capture` (ADR 015: "another domain that needs a
   document's text asks through this function"); a draft is not a document, so
   this would mean adding a generic blob API to another cell for one caller.
   Writing there would need `documents:write`, which the bills constitution
   forbids this cell outright ("this cell must not be able to unlink a bill's
   blobs"). The recovery bundle captures blobs beside the `pg_dump` (ADR 015),
   but the two stores are not one transaction; putting derived draft state there
   would make restore consistency worse than the structured record it describes.
3. **Generated on demand from structured fields.** Chosen.

`action_proposal` stores ids, check enum names, line indices and one integer
count. `dispute.render_draft` composes the letter at read time from the
candidates the proposal cites, resolving each id through kernel services under
the caller's own context. The letter is real — it quotes the issuer and the
amounts, because a dispute that says "there is a discrepancy" without numbers
is not a dispute — and none of it is stored anywhere.

This is the same move made three times before in this repo: ADR 014's briefing
"cites entity ids and copies no third-party text", B4's Tomorrow page "resolves
the briefing's cited entity IDs at read time so no display text is copied out
of the entities that own it", and ADR 017's receipt, which "names ids, verdicts,
line indices and differences — never a value from the document". C4 is the first
time the rendered result is meant for someone *outside*, and the rule holds
anyway.

**The erasure story is that there is nothing to erase, and it is checked.**
`test_the_proposal_stores_no_word_of_the_draft` asserts the marker planted in
`issuer` appears in no attribute of the proposal and that the proposal is not
returned by a full-text search for it. Erasing a candidate through
`POST /entities/{id}/forget` empties the draft **by construction**: the next
render reads a husk and prints `[unavailable]` where the values were. No
cascade has to remember to run, which matters because `verify` and `dispute`
are operator-run and nothing schedules either.

**The one derived value that does need erasing.** An approval binds to
`draft_digest`, sha256 over the exact text the human read (see below). That is
derived from `x-pii` amounts, and a digest over guessable content is a
confirmation oracle — the same reasoning that made ADR 017's `delta` unsafe
when the other operand is zero. So `draft_digest` is `x-pii`, it is not
`required` (an erased authority receipt is an honest husk saying "this proposal
was approved by this principal at this time"), and `verify.forget_bill`
cascades to it exactly as it already cascades to `verification_receipt.checks`.
`DERIVED_PII` is now a two-entry table rather than one hard-coded type, and
`receipts_redacted` counts both.
`test_erasing_a_subject_reaches_the_approved_draft_and_its_authority` asserts
the digest is gone from live state **and from every event payload in the
database**, and that the gate then refuses to emit.

Losing the digest revokes the grant, and that is the correct direction: an
approval of text that no longer exists authorises nothing.

### Approval is explicit, specific, and unforgeable

**Explicit.** Approval is `POST /action-proposals/{id}/approve` and nothing
else. No GET route writes anything —
`test_listing_proposals_shows_the_draft_and_writes_nothing` asserts the event
count is unchanged across a listing — so approval cannot be a side effect of
reading, of rendering, or of a prefetch.

**Specific.** The request must carry `draft_digest`: the sha256 of the draft the
caller was shown, echoed back. A caller that has not read the draft cannot
produce it, and a draft whose underlying facts moved between the read and the
approval no longer matches, so the approval is refused (403) instead of binding
a human's "yes" to text they never saw. The rendered body therefore carries **no
clock** — a letter dated "today" would change its own digest overnight and
revoke every approval at midnight; a test asserts today's date is not in the
body.

**Unforgeable.** Four layers, none of them sufficient alone:

1. `verify.guard_capture` refuses `action_proposal` and `authority_receipt`
   from `POST /capture` **at all**. They join `verification_receipt` and
   `bill_extraction` in `UNWRITABLE_TYPES` for the same stated reason: they
   attest to something a specific in-process actor did, and a hand-written one
   is a forged attestation rather than a correction. For an authority receipt
   the consequence is direct — a caller who could author one could authorise
   themselves. For a proposal it is one hop further — a hand-written proposal
   could name any subjects, and approving it would mint authority over records
   nothing ever verified.
2. `proposal_key` is added to that guard's `OWNED_KEYS` map, per the C3 rule
   that the guard keys on **the record a capture would land on, not the type
   name it claims**: `ExactIdentityResolver` matches on identity field *name*
   across every type declaring it, so a foreign type carrying a real
   `proposal_key` would otherwise merge into the proposal. `authority_receipt`
   is absent from that map because it declares no identity field at all.
3. The type schema binds the state to the artifact: `state: "approved"` requires
   `authority_receipt_id` and `decided_at`, exactly as `status: "verified"`
   requires `verification_receipt_id` (ADR 017). "Approved" is never a one-word
   edit.
4. The gate re-checks the binding in the other direction —
   `authority.proposal_id` must equal the proposal being emitted. In-process
   code holding `bills:write` can point a second proposal at someone else's
   authority receipt (that is inside the trust boundary, ADR 003, and not
   something a domain can forbid), and
   `test_an_authority_for_a_different_proposal_does_not_authorize_this_one`
   builds exactly that state and asserts the emission is refused while the real
   grant still works.

**Who approved comes from the verified request — and the first version of this
ADR claimed that before it was true.** `ApproveIn` carries no `granted_by`, so a
caller cannot say who approved; but the route obtained it from
`api.auth.principal()`, which took no `Request`, read no claim, and returned
`settings().owner_user_id` — a constant from environment configuration. That is
the same *string* in the ordinary case and not the same *statement*: it says who
the owner is, never who acted. Since `_context_from` narrows on a `scopes` claim
— by auth.py's own docstring "the same path future agent tokens take" — a token
carrying `bills:read`+`bills:write` could have fetched the digest and posted the
approval, and the resulting receipt would have asserted that the owner
personally approved. Not reachable today, because no such token exists; but this
receipt is the system's only artifact distinguishing a human decision from an
automated one, and the digest echo proves one prior GET, not that a person read
prose.

Three changes, all inside the interface cell and the bills cell:

1. `authenticate` stashes the claims it verified on `request.state`, and
   `principal(request)` reads the `sub` from **those claims**, bounded by
   character class before it is returned. It fails closed: with auth enabled,
   absent claims mean this was called outside the authenticated dependency and
   there is no subject to record.
2. `principal` returns `(subject, verified)`, and the receipt records
   `granted_via` — `owner_session` or `local_dev`. With
   `LIFEOS_AUTH_MODE=disabled` the subject is the constant
   `local-dev-auth-disabled` and `granted_via` says so in a field a query can
   filter on, rather than only inside a string somebody has to recognise. Not a
   fallback pretending to be an owner: a permanent statement in the record that
   this approval was made on an unauthenticated box.
3. **`approve_proposal` refuses any scope-narrowed context outright.** Holding
   `bills:write` is necessary and deliberately not sufficient. A context that
   enumerates its own scopes is the shape a *credential* takes; the owner's own
   session is unrestricted (`AccessContext.all()`), and only that may mint the
   artifact claiming a human said yes. `test_a_scope_narrowed_context_may_not_
   mint_authority` approves under a context holding every scope this domain has
   and asserts the refusal.

The check is on `approve_proposal` alone. `reject_proposal` mints no evidence,
and refusing a scoped context there would only leave proposals hanging.

`granted_by` and `granted_via` are bounded and are the owner's own pseudonymous
identifiers, so neither is `x-pii`, for the same reason event actors are not.
The domain never imports `api.auth`; the route computes the principal and passes
it in, and `approve_proposal` validates the shape and the enum it is given.

If agent tokens should ever be able to approve, that is a third `GRANT_VIAS`
member plus a distinct grant those tokens are minted with — a decision, with an
ADR, not a loosening of this check.

**Write scope is checked before anything is minted.** `require(ctx,
"bills:write")` is the first statement in `approve_proposal`, `reject_proposal`
and `generate_proposals` — minting authority is the moment a draft becomes
something the rest of the system may act on, and the C1 HIGH finding was a scope
check that ran after an irreversible act. A `bills:read` credential is turned
away up front, and a test asserts no authority receipt exists afterwards.

### The gate, and why it was built with nothing behind it

`emit_draft` refuses in seven distinguishable ways, each of them explicit, each
of them recording nothing:

| refusal | cause |
| --- | --- |
| `ProposalStateError` (409) | the proposal is not `approved` |
| `AuthorityRefused` (403) | it cites no authority receipt |
| `AuthorityRefused` (403) | the authority was granted for a different proposal |
| `AuthorityRefused` (403) | the grant does not permit `display_draft` |
| `AuthorityRefused` (403) | the grant names a channel this system cannot serve |
| `AuthorityRefused` (403) | the authority is expired, or its expiry is unusable |
| `DraftChanged` (403) | the draft is not the text that was approved — **including** the case where the approved digest was erased |

That last clause is the C3 HIGH precedent applied where it bites hardest: "we
cannot check what was approved" must never read as "this was approved". An
unparseable `expires_at` fails closed for the same reason.

**Rows four and five exist because the first version never read the grant it was
enforcing.** It validated the proposal, the authority's identity, the expiry and
the digest — and then *echoed* `permits` and `channel` into the result,
filtering an unrecognised permit to `[]` rather than refusing. `permits` had no
`minItems`, so `permits: []` was schema-valid: a receipt authorising nothing,
which emitted a draft. The one-member enums are a **write-time** constraint, and
a gate that leans on them is a gate that silently stops working the moment
`CHANNELS` gains a member — which is precisely the change this ADR says must be
safe to make. The same standard was already being applied to `proposal_id`
against in-process `bills:write` code; it is now applied consistently.
`permits` gained `"minItems": 1`, and `emit_draft` returns the constants it
checked rather than the values it read.

One consequence to carry forward: `approve_proposal` still **hard-codes** the
channel, so today a human's approval does not record *which* channel they agreed
to — there is only one, and the gate asserts it. The day `CHANNELS` gains a
second member that stops being adequate: `ApproveIn` must carry the channel, the
approver must choose it, and the gate must compare the grant against the request
rather than against a constant. That is on the list under "what would have to
change", and it is a rule in the bills constitution so it cannot be forgotten.

`AUTHORITY_TTL` is seven days, and it is a constant rather than an operator
knob: the length of a grant is a decision, not configuration. An approval says
"yes, this text, now"; after a week the statement should be re-checked before
anyone acts on it, and re-approving is one request.

The gate is built although the only destination this system can express is a
screen, and it is deliberately built *where the draft is produced* rather than
at a (non-existent) transport. The question it answers — "did a human authorise
**this text**" — is only answerable where the text is, and a gate bolted on
beside a future transport would be a gate around the wrong thing. It is also
exercised end to end rather than mocked, because the far side of it is real.

### Invariant 8: the leg this component lacks is (b), external communication

Invariant 8 forbids one component combining (a) broad read access, (b) external
communication and (c) high-consequence writes. Named per component, as the
invariant requires:

- **The draft generator** (`generate_proposals`, `python -m
  domains.bills.dispute`) has (c) writes. It lacks (b) entirely, and its reads
  are the `bills` domain alone — not documents, not the person spine, not
  calendar, not wellbeing. Its context is `bills:read`/`write` +
  `ops:read`/`write` and a test asserts exactly that set.
- **The gate** (`emit_draft`) has neither (b) nor (c): it performs no write on
  any path, including every refusal path.
- **The approval** (`approve_proposal`) holds the consequential write, and lacks
  (b). It is also not autonomous in the sense that matters: it runs only on an
  authenticated owner request naming one proposal and echoing the digest of the
  text that was read.

So the leg the whole path lacks is **(b)**. Three things make that structural
rather than a promise:

1. **There is no transport.** No module in this path constructs an HTTP client,
   a mail client or a socket. The only outbound call in this repo is
   `extract.py`'s Anthropic request, and `extract.py` cannot see a proposal.
2. **The authority type cannot express a transmission.** `permits` and
   `channel` are one-member enums (`display_draft`, `on_screen`) — the same
   trick C2 used to make `"verified"` inexpressible until C3 could earn it.
   `test_the_authority_type_cannot_express_a_transmission` asserts that
   `channel: "email"` and `permits: ["transmit"]` fail validation. A grant to
   send is not a thing anyone can write down here.
3. **Generating and approving are different functions with different callers.**
   A single component that could draft *and* send would combine the legs; the
   generator writes only `proposed` records, which authorise nothing, and the
   thing that authorises is a human-driven route the generator cannot call.

**What would have to change before anything is ever actually sent** — stated so
that it cannot happen by accretion:

- a new ADR, because a second `channel` member is a new capability, not an
  extension;
- a migration rewriting `AUTHORITY_RECEIPT_SCHEMA` in place (`define_missing`
  only defines absent types, ADR 017's consequence), so the change is visible in
  an operator script and a `type.redefined` audit event;
- `ApproveIn` carrying the channel and `approve_proposal` recording the human's
  choice instead of hard-coding `on_screen`, so the gate compares the grant
  against what was actually agreed rather than against a constant;
- a new component holding the transport, which must name the leg *it* lacks
  before design review passes — and the honest answer is that a sender has (b)
  and (c), so it must be denied (a): it may read one proposal by id and its
  authority receipt, and nothing else. It must not be the same component that
  drafts;
- a decision about what a recipient address is, where it comes from, and how it
  is erased — none of which exists today, on purpose;
- the C3 rule survives unchanged: a check that could not run is never quoted at
  a third party.

### What a draft may say, and what it may not

A verification receipt fails for two different reasons, and only one of them is
an accusation. `DISPUTABLE_CHECKS` is the subset where the *document disagrees
with itself* — `line_items_sum`, the three EOB arithmetic checks,
`no_duplicate_lines`, and the bill/EOB cross-check. `dates_coherent`,
`currency_consistent` and `no_low_confidence_fields` are excluded: each can fail
because this system misread the document, and telling a provider they made an
error on that basis is a claim nobody can back.

Only `RESULT_FAIL` becomes a point; `unchecked` never does. Everything that did
not pass and is not stated is counted in `unresolved_count` and named in the
letter itself — *"A further N check(s) on this statement did not pass but are
not stated above: they may reflect what my own records could not read rather
than an error on your part."* A receipt that failed with nothing disputable
produces **no proposal**, and the run reports `undisputable=N` rather than
falling silent.

**A receipt whose verdicts are not all there produces no proposal either**, and
there are two ways for that to happen. `checks` erased (it is `x-pii`) was
handled from the start. `checks_truncated: true` was not: ADR 017 stores only
the first `MAX_CHECKS` verdicts and promotes nothing from such a run, and the
first version of this module read the surviving slice as if it were the whole
record. `unresolved_count` would then under-count, and the letter would state
some discrepancies to a provider and claim, *with a number*, to have accounted
for the rest — an outward-facing accusation assembled from a knowingly partial
record while asserting completeness. Narrow reachability (>500 non-passing
verdicts on one document), and exactly the silence-as-pass shape the C3 finding
is about, so it gets the same answer: counted as `unreadable`, printed, no
proposal.

### A date is now prose

`service_date` and `due_date` had a length bound and no character class, unlike
`issuer`/`account_ref`. That was survivable while a date was only ever compared
to another date. **This slice is what changed it**: `render_draft` composes
`service_date` verbatim into a letter addressed to a third party, so the field
became an output channel.

The only untrusted writer is `extract._date`, which requires
`date.fromisoformat` — so there is no path today. The cell's rule is that a
stored string is bounded in the type *as well as* in the coercion, precisely so
that a value does not reach an output on the strength of one library's current
behaviour. `DATE_PATTERN` (`^[0-9][0-9W-]{0,31}$`) is applied in both places.

It is deliberately a **strict superset** of what `date.fromisoformat` can emit —
digits, `-` and `W`, always leading with a digit — so no stored record can
become `invalid` on the next verifier run and no backfill is possible to need.
What it closes is the direct-`POST /capture` door, which was open:
`service_date: "see attached notice from ..."` validated, and would have been
addressed to a provider. `scripts/migrate_bill_date_charset.py` rewrites the two
schemas in place with a `type.redefined` audit event, the same idempotent
operator-script shape ADR 012 and ADR 017 used.

The bill/EOB cross-check verdict is recorded against both records (ADR 017),
which is one discrepancy wearing two verdicts. The EOB's side is dropped before
anything is counted, not merely before it is stated — otherwise the letter would
state the disagreement once and then claim a further unstated check on top of
it.

### The CLI and its receipt

`python -m domains.bills.dispute [document_id ...]` — with ids it rules on those
documents' verification receipts, without them on every one. It runs inside
`ops.receipts.run_job`, so every run leaves an `execution_receipt` and only `ok`
exits 0 (ADR 014). Passing receipts are swept too, because a document that now
reconciles must be able to **withdraw** the draft it used to justify — the
ADR 017 layer-3 analogue, and it withdraws an `approved` proposal as well as a
`proposed` one, since nothing may stay granted on the strength of an old ruling.

A run never rewrites a proposal that a human has decided: `approved`,
`rejected` and `withdrawn` are `held`. Refreshing an approved proposal's points
would change the draft under the approval, and resurrecting a rejected one would
overrule a person with a cron job.

**The execution receipt carries no count of medical records** (the C2/C3
precedent, unchanged): `ops` stays model-readable so the briefing works, which
makes it the wrong place for "1 disputed medical bill". The receipt carries its
name, its status and a constant pointer; the counts and ids live in the
`action_proposal` records inside the withheld `bills` domain, and the full line
still goes to stdout, which is the operator's own terminal. A test asserts the
summary contains no digit.

## Consequences

- Four new routes: `GET /action-proposals`, `POST
  /action-proposals/{id}/approve`, `POST /action-proposals/{id}/reject`, `GET
  /action-proposals/{id}/draft`. All owner-authenticated exactly like every
  other route; the behaviour lives in the domain module and the routes dispatch
  (interface constitution).
- Two new exception handlers: `AuthorityRefused` → 403 (a well-formed request
  that is simply not authorised) and `ProposalStateError` → 409. `DraftChanged`
  is a subclass of the first, so an approval that no longer covers the text is a
  403 rather than a 422.
- `POST /entities/{id}/forget` on a bill or EOB now redacts one more thing: the
  `draft_digest` of every authority receipt naming that record.
  `receipts_redacted` counts it.
- **No type outside this cell may declare `proposal_key`** — the C3 constraint
  on the shared identity-field namespace gains a fifth entry.
- **Existing environments need `scripts/migrate_bill_date_charset.py` once**,
  before the first `dispute` run. Without it the loose date bound survives and
  the direct-capture door stays open; nothing else depends on it.
- `api.auth.principal` is new and `authenticate` now stashes verified claims on
  `request.state`. Any future route that must record *who* acted reads them from
  there rather than from configuration.
- **A proposal's draft is not readable from the listing once it is decided.**
  A UI showing an approved draft calls `GET /action-proposals/{id}/draft`. That
  is the point — there is exactly one door.
- A rejected proposal stays rejected. There is no route to re-propose one, on
  purpose: re-proposing is a decision, and this slice does not offer a way to
  make it by accident. If it turns out to be needed it is a state transition
  with its own route and its own test, not a loosening of the sweep.
- Chat and MCP still see none of this: adding types to `bills` does not widen
  the withholding, because it was already domain-wide (ADR 016/017).
- The draft is rendered for every `proposed` proposal in a list, which is one
  `get_entity` per subject. Trivial at personal scale; it joins the revisit list
  if the queue ever gets long.
- No new dependency. No kernel change. One migration, named above.

## Revisit when

Anything is genuinely to be sent (then everything under "what would have to
change" applies, and it starts with an ADR), agent tokens should be able to
approve (a third `GRANT_VIAS` member and a grant they are minted with), a
second `kind` of proposal appears
that is not a dispute (the state machine and the gate are kind-agnostic; the
renderer is not), a rejected proposal needs re-proposing, the seven-day grant
proves wrong against how the owner actually works, or a real dispute needs to
quote something the candidates do not carry — at which point the answer is
almost certainly a field on `bill`/`eob` with a bound and an `x-pii` flag,
never a free-text body on the proposal.
