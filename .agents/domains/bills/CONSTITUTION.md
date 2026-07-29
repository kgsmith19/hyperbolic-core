# Bills cell

Owns: `src/domains/bills/**`, `tests/bills/**`.

- A life domain, not kernel: `bill`, `eob`, `bill_extraction`,
  `verification_receipt`, `action_proposal` and `authority_receipt` are registry
  data (invariant 1) and every state change goes through kernel application
  services — capture/find/get_entity/history, never raw tables or SQL
  (invariant 7).
- **Everything the EXTRACTOR writes is a candidate, never a fact.** `status` is
  `"candidate"` there, provenance carries `method: "llm_extraction"`, and the
  schema refuses confidence 1.0 — reserved for what was not inferred (ADR 010).
  Nothing in `extract.py` reconciles, decides truth, or sends anything anywhere.
- **`verify.py` is the one thing allowed to say otherwise, and only by
  arithmetic** (ADR 017). No model, no network, no prompt — if a verification
  path ever needs one, that is a new ADR, not an addition. `Decimal` for money,
  never float; an explicit tolerance, defined and justified in the ADR; each
  check reported independently; and `unchecked` is not a pass, because "we could
  not check this" must never read as "this is true".
- **A check that cannot run says so. Silence is a defect.** Every subject gets a
  verdict from every check that applies to it — `unchecked` when the inputs are
  absent, including a bill or EOB that found no partner in a document holding
  both. A check that emits nothing is indistinguishable from a check that
  passed, and `verdicts` promotes on "every check naming it passed".
- **A promotion is granted, never taken.** A candidate becomes `verified` only
  when every check naming it passes. The value is bound to its receipt by the
  type schema, `POST /capture` is dispatched through `verify.guard_capture`, and
  every run re-judges what it promoted so nothing stays verified on an old
  ruling. Weakening any one of those three is a change to this file first.
- **Guard on the record a capture would LAND on, never on the type name it
  claims.** Entity resolution matches on the identity field *name* across every
  type declaring it, and `capture` validates the incoming payload against the
  incoming type and then merges — so a payload carrying `bill_key`, `eob_key`,
  `verification_key`, `extraction_key` or `proposal_key` must be a capture of
  the type that owns it, whatever it calls itself. **Any new identity key in
  this cell is added to `verify.OWNED_KEYS` in the same commit that defines
  it.** `verification_receipt`, `bill_extraction`, `action_proposal` and
  `authority_receipt` are not route-writable at all: they attest to work a job
  or a human did, and a hand-written one is a forgery, not a correction.

- **Nothing leaves this system, and nothing here could make it.** `dispute.py`
  drafts; only an explicit human approval mints an `authority_receipt`; only
  `emit_draft` hands a draft out, and only against a valid, matching, unexpired
  receipt for *that* proposal (ADR 018). The leg this whole path lacks is
  invariant 8's (b) external communication, and it is structural: no module here
  constructs an HTTP, mail or socket client, and `authority_receipt.permits` /
  `.channel` are one-member enums, so "send this" is not expressible. A second
  member is a schema change, a migration and a new ADR — never an edit.

- **"`emit_draft` is the one function that hands a draft out" is a claim, and
  every renderer is a candidate to break it.** `proposal_view` renders the same
  bytes, so it does so only for a `proposed` proposal — the state where reading
  is a prerequisite to deciding, and a state nothing ever returns to. **Any new
  caller of `render_draft` either restricts itself to `proposed` or goes through
  the gate.** A second ungated reader is the whole control defeated from the
  next route along, and it will look like a convenience.

- **A gate checks the grant, it does not echo it.** `emit_draft` asserts the
  permit is present and the channel is one it can serve, and returns the
  constants it checked rather than the values it read. That the enums have one
  member each is a WRITE-time constraint and must never be the reason a
  read-time check is skipped — `permits: []` was schema-valid once and emitted a
  draft. When `CHANNELS` gains a second member, `approve_proposal` must stop
  hard-coding the channel: the approver chooses it, the receipt records the
  choice, and the gate compares the grant to the request.

- **An authority receipt may be minted only under the owner's own unrestricted
  session.** `bills:write` is necessary and not sufficient: a context that
  enumerates its own scopes is the shape a token takes (`api.auth._context_from`
  narrows on a `scopes` claim), and a credential is not a person. `granted_by`
  comes from the claims verified for THAT request — never from a request body,
  never from environment configuration, which says who the owner is rather than
  who acted — and `granted_via` records which it was. Letting an agent token
  approve is a new `GRANT_VIAS` member and an ADR.

- **A draft is rendered, never stored.** A dispute letter names the provider and
  the amounts, so storing one would put exactly the free text this cell forbids
  into a tsvector-indexed attribute. `action_proposal` holds ids, check enum
  names and counts; `render_draft` composes the letter from the candidates it
  cites at read time, so erasing a candidate empties the draft by construction.
  The one derived value that must be erased is `authority_receipt.draft_digest`
  — a digest over guessable content is a confirmation oracle — and
  `verify.forget_bill` cascades to it through `DERIVED_PII`. **A new derived
  record that carries anything computed from a candidate's amounts joins that
  table in the same commit.**

- **A check that could not run is never quoted at a third party.** Only
  `DISPUTABLE_CHECKS` failures — where the document disagrees with itself —
  become points. `unchecked`, `dates_coherent`, `currency_consistent` and
  `no_low_confidence_fields` are about what THIS system could not read, and
  presenting one as an accusation is a claim nobody can back. Everything not
  stated is counted in `unresolved_count` and named in the letter, and a receipt
  with nothing disputable produces no proposal and a counted, printed
  `undisputable`.

- **A partial record is never the basis of an accusation.** A
  `verification_receipt` whose `checks` were erased, or that is flagged
  `checks_truncated`, cannot say why the document failed, so no letter follows
  it: counted as `unreadable`, printed, no proposal. Stating some discrepancies
  and then claiming *with a number* to have accounted for the rest is worse than
  saying nothing.

- **An approval is granted by a human, to one exact text.** `approve_proposal`
  refuses unless the caller echoes the sha256 of the draft it read, so approving
  cannot happen without reading and the facts cannot move underneath it;
  `granted_by` comes from the verified request, never from a request body; write
  scope is checked first; and no GET route writes anything, so approval is never
  a side effect of reading. A job never rewrites a proposal a human decided — an
  approved one is held, a rejected one is not resurrected — and a proposal whose
  basis stops failing is withdrawn, approved or not.
- **A receipt names ids, verdicts, line indices and differences — never a value
  from the document.** `checks` carries a `delta` and is `x-pii`, because a
  difference equals an amount whenever the other operand is zero.
- **Erasing a candidate goes through `verify.forget_bill`, never `forget()`
  alone.** `forget()` is per-entity; the receipts that derived numbers from this
  record are different entities, and their event payloads are beyond the reach
  of any later re-run. Receipts first, then the record. "The next scheduled run
  will clean it up" is not an erasure story, and there is no scheduled run.
- A record whose stored state stops validating against its own type is
  `invalid`: counted on its own, logged, and it fails the run. Never folded into
  a generic error counter — a record nothing can rewrite is a record nothing can
  demote.
- **The generic obligation shape is `bill`; `eob` is the medical instance.**
  A new bill kind is a new `category` value, not a new type. Adding a field
  that only one kind of bill has means asking whether it belongs on `eob`-like
  sibling instead.
- **No unbounded free-text field, anywhere.** Line items carry a bounded code
  and amounts; there is no `description`, no `memo`, no `notes`. Every
  remaining string is bounded by length *and* character class in the schema as
  well as in the coercion, and a value that breaks either is dropped rather
  than truncated — half an injected instruction is still injected text.
  `entity.search` is a generated tsvector over `attributes::text`, so a
  procedure description copied here would be full-text searchable
  (ADR 012/015, invariant 9). Say what this does and does not buy: a short,
  in-charset string still lands. The layering — `x-pii` so it is erasable,
  `x-sensitive` so no model reads it — is what makes that survivable, and no
  document from this cell may claim more.
  **Dates are strings too.** `service_date`/`due_date` carry `DATE_PATTERN` as
  well as a length, because C4 made a date something composed verbatim into a
  letter for a third party. A field that a parser happens to constrain is not a
  bounded field — the bound goes in the schema and in the coercion, both.
- An identity field is never a PII field. `bill_key` and `eob_key` are sha256
  digests over the source document's hash plus the identifying values, so they
  survive `forget()` — keying on `claim_no` or `account_ref` directly would let
  the next extraction of the same document mint a fresh entity carrying the
  values that were just erased (ADR 012 "Durable erasure").
- **Never write back a redacted field, and scope that per DOCUMENT.** The keys
  hash model output, so a reworded answer or a new `LIFEOS_EXTRACT_MODEL` lands
  on a different key, matches no entity, and would consult no redaction list.
  Before capturing, union the erased fields of every candidate of that type
  whose provenance cites this document (`_document_redactions`). A regression
  test that replays an identical payload cannot see this failure — drift the
  issuer.
- **Write scope is checked before the document text leaves the box.** Sending
  a bill to Anthropic is irreversible; a `bills:read` context must be turned
  away before the model call, never by a check that happens to run later inside
  `capture` (C1 precedent).
- **The document text is PHI and goes to exactly one place: the Anthropic
  Messages API** (ADR 016). It must reach nothing else — not the log, not an
  exception message, not `entity.attributes`, not an execution receipt. Model
  and parser errors are recorded by exception *class* name only; their messages
  are built from the tokens being parsed and can quote the bill, and no erasure
  path reaches the container log.
- Every model response is treated as untrusted input, and so is the document
  behind it: a JSON schema on the request, a local re-validation of the result,
  per-field bounds and coercion before capture, and a cap on the number of
  records. A document can carry instructions aimed at this extractor; a value
  that is not shaped like the field it claims to be is dropped. A response that
  cannot be parsed is a recorded `bill_extraction` status and a non-zero exit,
  never a crash and never a silent success.
- **A run that sent the text is recorded even when it then failed.** The audit
  question is "did this document's text leave the box", and a transmitted call
  that errored answers yes. Capture the `bill_extraction` record before
  re-raising; the document then leaves the automatic sweep, and retrying it is
  an explicit operator act rather than a second send.
- `bill` and `eob` are `x-sensitive` (ADR 016) — and so is `document`, one hop
  upstream, because `original_filename` is the same PHI in the graph. The
  shared agent-tool surface withholds every domain holding a sensitive type, so
  bills never reach a model through a generic read tool. Adding a
  non-sensitive type to this domain does not widen that — enforcement is
  domain-shaped because scopes are (invariant 5).
- **An execution receipt is not a place for counts of medical records.** It
  lives in `ops`, which stays model-readable so the briefing works. Every job in
  this cell puts its name and status there and nothing else; counts and produced
  ids belong in `bill_extraction` / `verification_receipt` / `action_proposal`,
  inside the withheld domain, and on stdout.
- Every job runs under a narrow code-built AccessContext, never
  `AccessContext.all()`, and asks for the least it can: extraction takes
  `bills:read`/`write` + `documents:read` (never `documents:write` — this cell
  must not be able to unlink a bill's blobs) + `ops:read`/`write`; verification
  drops `documents:read` too, because it judges candidates already in the graph
  and never opens the document, and proposing takes the same narrow set.
- Each CLI is a scheduled entry point: it runs inside `ops.receipts.run_job`, so
  every run leaves a receipt and only `ok` exits 0 (ADR 014). A candidate that
  fails verification is a RESULT, not a failed run — finding the discrepancy is
  the job working.
- Behavior changes land with tests in `tests/bills/` (unit for parsing, bounds
  and arithmetic, integration for extraction, verification, proposals and
  erasure). Tests never call the real Anthropic API — inject a fake client, and
  for verification and proposals there is nothing to inject. Fixtures are synthetic; no real medical document
  and no real PHI ever enters this repo.
