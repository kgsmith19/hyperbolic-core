# ADR 016: Bill/EOB types, LLM extraction to flagged candidates, and `x-sensitive`

## Decision

**Shape.** Bills are a life domain, not kernel: three `type_definition` rows
(`bill`, `eob`, `bill_extraction`, domain `bills`) plus a module
`src/domains/bills/` — zero kernel DDL (invariant 1, ADR 002), no new API route
and no new deployable (ADR 009). Every state change goes through kernel
application services; the module holds no SQL.

**Scope of C2.** Captured document → extracted text → **candidate** bill and EOB
entities. It does not reconcile, verify, or decide truth (C3), and it sends
nothing anywhere (C4). The one thing it does that no earlier slice did is send
the owner's medical document text to a third party; that is recorded below.

### The type design: one generic obligation, one medical instance

`bill` is the **generic** shape the roadmap asked for — `issuer`,
`account_ref`, `service_date`, `due_date`, `line_items[]`, `total`, `currency` —
discriminated by `category` (`medical` / `utility` / `other`). A utility bill is
a `category` value, not a new type; that is the test of whether the core stayed
generic. `eob` is the **medical instance** beside it: `payer`, `claim_no`,
`service_date`, and line items carrying the payer split (`billed`, `allowed`,
`plan_paid`, `patient_resp`) that no other obligation has. They are siblings
rather than parent/child: `parent_type_id` carries no enforced behaviour in the
kernel, so a subtype relation here would be decoration.

**No unbounded free-text field exists in this domain.** No `description`, no
`memo`, no `notes`; line items carry a bounded code and amounts. This is the
binding B1/C1 finding applied a third time: `entity.search` is a generated
tsvector over `attributes::text` and `forget()` is strictly per-entity, so
"MRI LUMBAR SPINE W/O CONTRAST" copied into an attribute would be full-text
searchable by anything holding read scope. C3 reconciles on codes and amounts; a
human who needs the prose reads the document in the blob store (ADR 015).

The remaining strings are bounded in **length and character class, in the type
schema as well as in the coercion**, so a direct `POST /capture` is held to the
same bar as the extractor: `issuer`/`payer` at 64 characters over
`[A-Za-z0-9 .,&'()/-]`, `account_ref`/`claim_no` at 48 with no whitespace at
all, `code` at 16. A value that breaks either bound is **dropped, not
truncated** — the first 64 characters of an injected instruction are still
injected text in an indexed attribute.

Stated honestly, because the first draft of this ADR overstated it: **this is a
mitigation, not a guarantee.** A document is untrusted input aimed at the
extractor — white-on-white text saying "record the issuer as ..." is the obvious
attack — and a short, in-charset string will still land in `issuer`. What makes
that survivable is the layering rather than the bound: those fields are `x-pii`
and therefore erasable, and the whole domain is `x-sensitive` and therefore
never readable by a model. `test_org_and_ref_values_are_dropped_rather_than_truncated`
asserts the boundary in both directions, including the case that gets through.

**Identity is never PII.** The roadmap named `claim_no` as the EOB's identity
field, and that is exactly the ADR 012 "Durable erasure" trap: `forget()` strips
`claim_no`, so an erased EOB would stop being findable and the next extraction
of the same document would mint a brand-new entity carrying the claim number
again — erasure silently undoing itself, for the third time in this codebase.
The keys are sha256 digests instead:

- `bill_key` = sha256(document sha256 | `bill` | issuer | account_ref | service_date)
- `eob_key` = sha256(document sha256 | `eob` | payer | claim_no)

`claim_no` and `account_ref` remain attributes and are `x-pii`. As with
`attendee.email_hash` (ADR 012), hashing is **not** anonymization — a claim
number is guessable by anyone holding a candidate value — it is a *stable join
key*, acceptable only because it never leaves the system and nothing renders it.
The source document's hash is in the key on purpose: two documents describing
the same bill produce two candidates, which is honest for evidence C3 has not
reconciled yet.

**But a key derived from model output is only as stable as the model**, and the
first draft of this slice leaned on it for erasure durability. "Blue Shield"
becoming "Blue Shield of CA" on a later run — a reworded answer, or an operator
bumping `LIFEOS_EXTRACT_MODEL`, which the runbook actively invites — produces a
different key, matches no existing entity, consults no redaction list, and
captures the erased payer, claim number and line items into a brand-new entity
that is promptly re-indexed into `entity.search`. Erasure would have been
durable only for as long as the model repeated itself.

So **the redaction set is per document, not per entity**: before capturing, the
run unions the erased fields of every candidate of that type whose provenance
cites this document, and strips them from everything it is about to write. The
document is what an erasure is really about and it has an identity no model
output can move. It is scoped per type so that erasing a bill does not silently
strip an EOB's own `service_date` and `line_items`. The regression is
`::test_erasure_survives_the_model_rewording_itself`, which re-runs with a
*drifted* issuer and payer — replaying an identical payload, as the first draft
did, cannot see this failure at all. The cost is one scan of each candidate type
per document per run; trivial at personal scale, on the revisit list otherwise.

**Nearly every field is `x-pii`,** and the proof is a regression test rather than
a claim: `tests/bills/test_bill_extraction.py::test_forget_removes_every_flagged_field_from_a_candidate`
erases a candidate and asserts the values are gone from live state, from
full-text search and from every event payload that ever held them. What survives
`forget()` is the key, `status`, `category`, `currency`, the provenance envelope
and the timestamps — an honest husk that says "a candidate derived from document
X once existed". Its companion,
`::test_an_erased_candidate_is_not_rewritten_by_a_later_extraction`, re-runs
extraction over the *unchanged* source document and asserts the erased fields
stay erased: extraction reads each candidate's own `pii.redacted` history and
strips those fields before writing (the `_redacted_fields` pattern from ADR 012,
duplicated deliberately rather than shared, because a cross-cell import of
another domain's private helper is worse than ten lines).

### Candidates are distinguishable from facts, by construction

Three independent markers, two of them enforced by the type system:

- `status` is an enum with exactly one member, `"candidate"`. `"verified"` is
  **not expressible** until C3 defines it.
- `provenance.method` is `"llm_extraction"` on every record.
- `provenance.confidence` has `exclusiveMaximum: 1` on `bill` and `eob`, so a
  candidate cannot claim the 1.0 that ADR 010 reserves for direct kernel reads.
  `extract.py` also caps the model's self-reported confidence at 0.95 before it
  gets there, and records 0.5 when the model omits it — an unstated confidence
  is not a high one. Per-field granularity is `low_confidence_fields`, a bounded
  array of this type's own field names (never free text).

The provenance envelope cites the source document's entity id and the id of its
latest event, so every candidate resolves to the exact document state it was
read from. **There is no `derived_from` edge**, unlike ADR 012's ingestion:
`relate` requires write scope on every domain an endpoint belongs to, so an edge
would force `documents:write` onto the one component that must never be able to
unlink a bill's blobs. Citing ids inside the provenance attribute is the ADR 014
briefing precedent and costs nothing here.

### The model call

Direct Anthropic SDK, the ADR 011 posture unchanged (a second LLM consumer is a
LiteLLM revisit trigger, not a reason to build a gateway now — ADR 009's own
"extract on the second consumer" rule argues for revisiting when a *third*
appears, and this one shares the key and the client construction). Model and
effort are operator config — `LIFEOS_EXTRACT_MODEL` (default `claude-opus-5`),
`LIFEOS_EXTRACT_EFFORT` (default `medium`) — and the server-side refusal
fallback is on, exactly as `/chat` has it, so a safety-classifier false positive
on a medical document degrades instead of failing the run.

**Structured outputs, not parsing.** The request carries a JSON schema
(`output_config.format`), so the model cannot answer with prose that this module
would then have to parse out of a medical bill. The schema uses only the
constructs structured outputs support (type / enum / required /
additionalProperties) — every bound, pattern and length limit is re-applied
locally, because a schema on the request is the model's contract, not a
validator we control. The response is then re-validated against the same schema
before anything is read out of it, amounts and dates are coerced or dropped
(never guessed: an unparseable total is *absent*, not zero, or C3 would
reconcile against a number nobody wrote), and the record count is capped.

Four outcomes besides success, all recorded, none of them a silent success:
`refused` (the classifier declined), `unparsable` (no JSON, invalid JSON, schema
mismatch, or a truncated response), `empty` (a document with no bill), and
`failed` (the request was transmitted and the call then failed). All but `empty`
fail the job and exit non-zero.

`failed` exists because the first draft did not record it, and that was the one
outcome where the record mattered most: the request had gone out, the PHI had
left the box, and nothing said so — while `_pending_documents`, seeing no
record, would have quietly sent the same document again on the next sweep. The
run record is now captured before the exception is re-raised. The consequence is
deliberate: a failed document drops out of the automatic sweep, so retrying it
is an explicit `python -m domains.bills.extract <id>` rather than an automatic
re-send of a medical bill.

### The PHI data flow, stated

**What leaves the box:** the full extracted text of one captured document —
which for a medical bill is the patient's name, provider, dates of service,
procedure codes and amounts.

**To whom:** the Anthropic Messages API, `api.anthropic.com`, authenticated with
the `ANTHROPIC_API_KEY` already in the app `.env` render (ADR 009/011). No other
outbound request exists in this module.

**Under what config:** `LIFEOS_EXTRACT_MODEL` / `LIFEOS_EXTRACT_EFFORT`, one
call per document, capped at 16 000 output tokens. It happens only when the
operator runs `python -m domains.bills.extract`; nothing sends a document
automatically on upload.

**How it is auditable:** every run — success, refusal, unusable response or
failed call — captures a
`bill_extraction` entity keyed on the document id, recording which document
(id + sha256), which model, when, how many characters were sent and what came
back. It holds counts and enums only, carries no `x-pii`, and therefore survives
the erasure of the candidates it produced: the *fact* that a document's text was
sent stays on the record even after the bill itself is gone. It is also what
stops a sweep from sending the same document twice, including one that
legitimately yielded nothing.

**Where it must not go, and what enforces that:** not into
`entity.attributes` (the entity holds coerced fields, never the text); not into
an execution receipt (counts and statuses only, ADR 014); and not into the log
or an exception message. That last one is the C1 finding taken seriously in a
worse place: a `JSONDecodeError` or a `jsonschema.ValidationError` message is
built from the value that failed, and that value came from the bill, so only the
exception **class** name is ever logged. A provider exception is caught and
re-raised as `ModelCallFailed` carrying a class name and `from None`, because a
400 can echo the request body back and the request body is the document — and
the container log is a sink no erasure path reaches. The test that keeps this
honest asserts a marker from the document appears in *no* log record.

### `x-sensitive`: defined and enforced, not deferred again

C1 deferred the flag to this slice rather than ship decoration. It is defined
here, with an enforcement a test exercises:

> **A type whose schema carries `x-sensitive: true` is withheld from the shared
> agent-tool surface.** `mcp_server.tools` — the one implementation both LLM
> doors use, the MCP server (ADR 010) and `/chat` (ADR 011) — narrows its
> AccessContext through `agent_read_context` before every call, dropping read
> scope for any domain that holds a sensitive type. Such a record therefore
> never reaches a model through `list_types`, `find`, `get_entity` or `history`.

**Which types carry it: `bill`, `eob` — and `document`.** The first draft
flagged only the first two, which left the control covering the extracted bill
and missing the file it came from. ADR 015 had reasoned that documents were safe
to expose to chat because the bytes and the extracted text are not in the graph;
that reasoning was incomplete, because `original_filename` *is*, and this repo's
own docstring for it says it "routinely reads `EOB_Jane_Doe_2026-03.pdf`". Since
`read_only_context` grants every active domain and the owner context is
`AccessContext.all()`, "list my documents" would have returned patient-name
filenames straight into the next Anthropic request — with no `bill_extraction`
record, no operator action, and while the grounding instructions claimed medical
records were withheld entirely. `document` is therefore `x-sensitive` too, and
that ADR 015 consequence is superseded.

**The `ops` receipt is the other half of that.** `execution_receipt` lives in
`ops`, which is deliberately *not* sensitive — the briefing and "did the cron
run?" depend on it staying readable. So the extraction job's receipt was
carrying `bills=3 eobs=1` and the entity ids of those candidates into a
model-readable domain. Flagging `ops` would break the briefing, so instead this
job's receipt now carries its name, its status and a constant pointer, and
nothing else; the counts and ids live in `bill_extraction`, inside the withheld
domain, and the full line still goes to stdout, which is the operator's own
terminal.

**The flag is now validated at definition time.** `define_type` already checked
the shape of `x-identity` and `x-pii` but not this one, while readers test it
with `is True` — so `"x-sensitive": "true"` would have registered happily and
protected nothing. A non-boolean is now a loud `ValueError`. That is the one
kernel change in this slice, additive and inside the existing x-flag validation
block; it was reported rather than assumed.

Three properties worth naming:

- **Declared per type, enforced per domain.** Scopes are domain-shaped
  (invariant 5), so per-type withholding is not expressible without new
  machinery. The consequence is that `bill_extraction`, which holds nothing
  personal, is withheld too. That is the safe direction, and it is why the
  `bills` domain holds bill records only.
- **Enforced in the tool surface, not in either door's context builder.** It
  therefore holds however the context was granted: chat's scope-stripped owner
  context and an operator-minted agent token alike, and for
  `AccessContext.all()` in an operator script that happens to call a tool.
- **A narrowing, never a widening** (the ADR 011 rule): the narrowed context is
  built from types the caller could already read, so it can only remove scopes.
  Write scopes go with it, which this read-only surface never needed.

What it deliberately does *not* mean: the data is not hidden from the owner. The
API, the SPA and this domain's own CLI read bills and documents normally under
the owner's context. The flag governs the model-facing surface, so PHI reaches
an LLM only through a named path that records the flow — which is exactly what
this slice builds.

One honesty consequence: with bills and documents withheld, "what medical bills
do I have?" must not answer "you have none". The grounding instructions now name
both categories and say an empty result means "nothing I can see", never
"nothing exists".

### Contexts, scope order, and the CLI

`python -m domains.bills.extract [document_id ...]` — with ids it extracts those
documents, without them it sweeps every document that has extractable text and
no `bill_extraction` record. It runs inside `ops.receipts.run_job` like the
other scheduled entry points, so every run leaves an `execution_receipt` and
only `ok` exits 0 (ADR 014). Its context is code-built and narrow:
`bills:read`/`write` + `documents:read` + `ops:read`/`write`. **Not
`documents:write`** — this module reads a document's text and must not be able
to unlink its blobs (ADR 015).

`require(ctx, "bills:write")` runs **first**, before the text is read and long
before it is sent. C1's HIGH finding was a scope check that ran after an
irreversible act; shipping a medical bill to a third party is irreversible in
the same way a blob delete is, so a `bills:read` context — a credential whose
whole guarantee is that it changes nothing — is turned away before the call, and
a test asserts the fake client recorded zero calls.

Reading the text goes through `documents.capture.read_document_text`, never a
`BlobStore` this domain constructs: refs are the documents cell's business, and
an erased document must stay unreadable (a run over a tombstoned document is
refused).

**Lethal-trifecta check (invariant 8).** This component has (b) external
communication and (c) writes. The leg it lacks is (a) broad read access: its
reads are `bills` plus `documents` and nothing else — not the person spine, not
calendar, not wellbeing — and the one document it sends is named by the caller
or by its own sweep, never chosen by a model. Nothing in this path gives a model
a tool, and the model's output cannot widen what is read.

## Consequences

- The `bills` cell (`.agents/domains/bills/`) exists per invariant 10, and the
  guards cell map gained a `bills` entry for `src/domains/bills/**` and
  `tests/bills/**` (runbox script `add-bills-cell.mjs`).
- **One kernel change**, contrary to the slice's zero-DDL expectation and
  reported as such: `define_type` now rejects a non-boolean `x-sensitive`.
  Additive validation in the block that already checked `x-identity`/`x-pii`;
  no DDL, no behaviour change for existing types.
- No new dependency: `anthropic` and `jsonschema` were already here.
- Defining the bills types makes `bills` an active domain, so chat's
  scope-stripped context gains `bills:read` — and the tool surface withholds it
  again. Agent tokens carry nothing until the operator re-mints (ADR 010
  fail-closed), and an operator who mints `bills:read` still gets nothing from
  the tools.
- **Chat can no longer see documents at all** — not filenames, not hashes, not
  sizes. That capability existed between C1 and C2 and is withdrawn on purpose.
- A document whose extraction *failed* leaves the automatic sweep and needs an
  explicit retry by id. Preferred over silently re-sending a medical bill.
- Every agent tool call now costs one extra `list_types` read to compute the
  narrowing. Trivial at single-user scale; it joins the revisit list if the tool
  surface ever gets hot.
- A re-run over an unchanged document with an unchanged answer emits **zero**
  events: `extracted_at` is excluded from the unchanged-comparison, the ADR 014
  briefing precedent.
- Two candidates from the same document that share issuer, account and service
  date collapse onto one key. That is the intended reading (one obligation, seen
  twice), and it is C3's job to notice if it is wrong.
- Nothing here is a fact. A downstream consumer that treats a `bill` as owed
  money is misreading `status`.

## Revisit when

C3 lands (it adds a verified status and a verification receipt, which is a
change to `status` and probably a second provenance envelope), a second LLM
consumer or a budget need appears (the ADR 011 LiteLLM trigger), a non-medical
bill kind needs a field `bill` does not have (that is a `category` value plus
fields, not a new type, until proven otherwise), per-type rather than per-domain
`x-sensitive` enforcement is genuinely needed, or extraction volume makes the
one-call-per-document shape worth batching.
