# ADR 017: Deterministic reconciliation, verification receipts, and earning `verified`

## Decision

**Shape.** One new `type_definition` row (`verification_receipt`, domain `bills`),
two amended ones (`bill`, `eob`), and one module `src/domains/bills/verify.py` —
zero kernel DDL (invariant 1, ADR 002), no new deployable and no new repo
(ADR 009). Every state change goes through kernel application services. **No
kernel change**, contrary to C2, which needed one; this slice's zero-DDL
expectation held.

**Scope of C3.** C2's extractor proposes; this disposes. The verifier reads the
`bill` and `eob` candidates derived from one document, runs arithmetic over
them, records what it found, and promotes only what every check agreed on. It
sends nothing anywhere and drafts nothing (C4).

**There is no model anywhere in this path.** No Anthropic client, no prompt, no
outbound request of any kind — `verify.py` constructs no HTTP client, and its
tests inject no fake one because there is nothing to fake. That is the point of
the slice: the model proposes, arithmetic disposes.

### The checks, and the tolerance

Money is `Decimal`, never float. A stored amount goes through `str()` before it
becomes a `Decimal`, so the shortest round-tripping literal is what is compared
rather than a float's binary expansion, and each value is quantized to two
decimal places. `0.1 + 0.2 != 0.3` in binary, and a reconciliation check that is
wrong by a machine epsilon reports noise.

**Tolerance: one cent (`Decimal("0.01")`), per comparison, two-sided.** Justified
rather than picked: every amount in this domain is already quantized to two
decimal places before it is stored (`extract._amount` rounds), so an *exact*
match is the expectation, and the cent only absorbs a statement that rounds its
own subtotal. Anything larger would start absorbing real discrepancies, which is
the one thing a reconciliation check must not do. `allowed <= billed` uses the
same cent, one-sided.

Each check is reported independently, so a receipt says *which* arithmetic
failed and by how much rather than "verification failed":

| check | subject | assertion |
| --- | --- | --- |
| `line_items_sum` | `bill` | `sum(line_items[].amount) == total` (±0.01) |
| `eob_line_split` | `eob`, per line | `plan_paid + patient_resp == allowed` (±0.01) |
| `eob_allowed_within_billed` | `eob`, per line | `allowed <= billed` (+0.01) |
| `eob_amounts_non_negative` | `eob` | no negative `billed`/`allowed`/`plan_paid`/`patient_resp` |
| `dates_coherent` | both | `service_date <= due_date`, and every present date within `[2000-01-01, today + 730d]` |
| `no_duplicate_lines` | both | no line item appears twice among this document's candidates of that type |
| `currency_consistent` | both | one document, one currency; money with no stated unit is `unchecked` |
| `no_low_confidence_fields` | both | `low_confidence_fields` is empty |
| `bill_eob_patient_resp` | both | `sum(eob.patient_resp) == bill.total` (±0.01), for a bill and an EOB sharing a service date |

**The EOB identity, stated exactly**, because `EOB_SCHEMA` carries four amounts
and only some of their relationships are real. `billed` is what the provider
charged; `allowed` is what the plan permits for that service; the plan then
splits `allowed` between itself and the patient. So:

```
plan_paid + patient_resp == allowed      (the split is complete)
allowed <= billed                        (the rest is the write-off)
every amount >= 0
```

`billed - allowed` is deliberately **not** asserted to equal anything. That
difference is the contractual adjustment and it is whatever the contract says;
asserting it would fail every real EOB.

**Three results, and `unchecked` is not a pass.** A check whose inputs the
extractor never captured — a bill with no total, an EOB line missing an amount —
is `unchecked`, and it blocks promotion exactly as a failure does. "We could not
check this" must never read as "this is true". Checks that do not *apply* are
never created at all: a `bill` gets no EOB split check, and a document holding
only bills (or only EOBs) gets no cross-check, because one obligation per
document is the normal case and an absent counterpart is not a discrepancy.

**But an unpaired record inside a document that holds both is `unchecked`, never
silent.** The first version emitted nothing when a bill had no parseable
`service_date`, and nothing again when a bill and an EOB simply carried
different dates. Since `verdicts` promotes on "every check naming it passed",
both records then sailed through on internal self-consistency: a bill claiming
5000.00 with one matching line item, beside an EOB saying the patient owes 30.00,
promoted *both* — and the system asserted as checked fact that the owner owed
5000.00 while its own EOB said 30.00. No attacker is required, because
`extract._date` drops anything `date.fromisoformat` refuses and a page printing
"March 4, 2026" is enough; an attacker can also just perturb one date by a day.
Silence was the bug, not the pairing rule: once a document yields both kinds,
every bill and every EOB that found no partner now gets
`bill_eob_patient_resp: unchecked`, which blocks promotion.

**Duplicates are counted across the document, not within one record.** The same
line item landing on two candidates extracted from the same page is the failure
worth catching, and counting occurrences across every candidate of that type
catches the within-record case for free. Two genuinely identical charges on one
day are indistinguishable from a double capture — and that is the intended
behaviour: the ambiguity is surfaced for a human instead of promoted.

**Dates are the one place the clock enters.** The forward bound is `today + 730
days`; everything else is pure. A date can therefore move from `fail` to `pass`
as time passes, which is correct — it was implausible when it was checked.

### `verification_receipt`

One receipt per document, keyed on the document id, so re-verifying supersedes
rather than piling up and the earlier ruling stays in history (invariant 3). It
carries the subject entity ids, the ids it promoted, `passed`, and one entry per
check: `{check, subject_id, result, line_index?, delta?, fields?}`.

**It lives in the `bills` domain, and that is what withholds it from models.**
`x-sensitive` is *declared per type* and *enforced per domain*, because scopes
are domain-shaped (invariant 5): `mcp_server.tools.agent_read_context` computes
`withheld` from the **domains** of flagged types and drops read scope for all of
them. `bill` and `eob` carry the flag, so the whole `bills` domain — this type
included — is already withheld from both LLM doors. `verification_receipt`
therefore does **not** carry `x-sensitive` itself, exactly as `bill_extraction`
does not (ADR 016). Confirmed against the code rather than assumed.

**Confidence 1.0 is honest here and still refused on a candidate.** ADR 010
reserves 1.0 for direct kernel reads, and the reservation is about *derivation*,
not about who wrote the row: a receipt reports arithmetic this process performed
over kernel state it read directly, with no inference and no model anywhere in
the path. Re-running it over the same state produces the same answer, which is
precisely the property a confidence below 1.0 exists to deny. `bill` and `eob`
keep `exclusiveMaximum: 1` on their own provenance, so a candidate still cannot
claim it.

**What a receipt does not carry: any value from the document.** No issuer, no
payer, no claim number, no line amount — there is no field to put one in. The one
number it does carry is `delta`, the signed amount by which an arithmetic check
missed: a *difference* between two amounts, never an operand. The receipt cites
the candidate's entity id and the failing line index; an operator who wants the
amounts resolves the id, which is where `forget()` reaches them (the ADR 014
briefing precedent, and B2's `link_review`, which carries ids and a reason code
and never the attendee's email).

One residual, stated rather than glossed: a delta can coincide with an operand
when the other operand is zero — a fully denied EOB line makes `plan_paid +
patient_resp - allowed` equal `patient_resp`. That is why the next paragraph
exists instead of a claim that deltas are safe by construction.

**`checks` is `x-pii`.** A delta is arithmetic over amounts that are themselves
`x-pii` on the candidate, so the array holding it has a working erasure path
(invariant 9) and is deliberately not `required` — an erased receipt is an honest
husk saying "this document was verified at this time and did not pass", the same
shape an erased candidate keeps. Coarse in the safe direction: erasing a receipt
also drops the pass/fail detail, which is a smaller loss than keeping a number
the owner asked us to destroy.

**Every run also rewrites `checks` in full, even when it is empty.** `capture`
merges, so a key a run omits keeps the previous run's value; without the explicit
rewrite a re-verification after an erasure would carry the old deltas forward.

**And that rewrite is not enough on its own, so erasure cascades.** The first
version of this ADR claimed a re-run was the answer and claimed a regression test
proved it. Both were wrong. `forget()` is strictly per-entity and redacts only
the fields flagged on the entity it is handed, so erasing a candidate left its
deltas in the receipt's live state until somebody happened to run `verify` — and
`verify` is operator-run, nothing schedules it, so that window is unbounded —
while the receipt's *earlier event payloads* kept the original deltas forever,
which no re-run can reach. The old test searched for a marker planted in
`issuer`/`account_ref`, which `forget()` genuinely strips, and never asserted on
a delta at all.

It matters because a delta is only *usually* a difference: when one operand is
zero it equals the other. A bill with `total: 1284.37` and a single `0.00` line
yields `delta == -1284.37` — the bill's own amount, sitting in a second entity.

So `domains.bills.verify.forget_bill` is the whole erasure for a candidate:
write scope first, then redact `checks` on every `verification_receipt` naming
the entity (live state *and* every event payload, which is what the kernel's
`forget` does), then the candidate's own redaction. Receipts first, because
over-erasing a receipt is the safe direction and a part-way failure must not
leave the derived numbers as the only survivors. `POST /entities/{id}/forget`
dispatches to it, exactly as it dispatches documents to `forget_document`
(ADR 015) — one erasure endpoint, no under-erasing trap — and the response
carries `receipts_redacted` so the claim is checkable. It is deliberately not
conditional on *which* fields are being erased: working out which delta came from
which attribute is exactly the cleverness an erasure path must not have.

The regression is `test_erasing_a_candidate_takes_the_receipt_numbers_with_it`,
which builds the zero-operand shape on purpose and asserts the **delta value**
is absent from every event payload in the database afterwards.

### Promotion: earning `"verified"`, and protecting it

C2 shipped `status` as a one-member enum so "verified" was inexpressible. C3 adds
the second member, and the promotion rule is one line:

> A candidate is `verified` when it has at least one check and **every** check
> naming it passed. Anything else leaves it a `candidate`, with a receipt saying
> what failed.

A candidate nothing checked is never promoted. A cross-check verdict is recorded
against **both** records, so a bill and an EOB that disagree block each other.

The obvious hole is that `"verified"` now has to be a real value of `status`, so
`POST /capture` can express it too — and the owner context holds every scope.
Three layers, none of which is the whole answer alone:

1. **The type refuses a promotion that cites no receipt.** `bill` and `eob` carry
   `allOf: [{if: status == "verified", then: required
   ["verification_receipt_id"]}]`. `"verified"` is never a one-word edit, and
   every verified record resolves to the checks behind it.
2. **The route refuses a hand-written promotion, keyed on the record it would
   land on rather than the type name it claims.** `POST /capture` dispatches to
   `domains.bills.verify.guard_capture` — one `if` in the route, all the
   behaviour in the domain, exactly the shape ADR 015 used for document erasure.

   The first version keyed on `type_name` and was bypassable in a single call.
   `ExactIdentityResolver` matches on the identity field **name** across every
   type that declares it, and `capture` validates the *incoming* payload against
   the *incoming* type's schema and only then merges into the matched entity.
   So `POST /types` for any type in `bills` carrying
   `x-identity: ["bill_key"]`, then `POST /capture` of that type with a real
   bill's key and `status: "verified"`, walked past the name check, never met
   `BILL_SCHEMA`'s `if/then`, and wrote `verified` onto the real bill with no
   `verification_receipt_id` at all — layers 1 and 2 defeated together. Layer 3
   went with them: the merged entity then carried a foreign field, so
   `_apply_status` could no longer re-validate it, and a bare `except Exception`
   in `run_verification` counted that as an error and skipped the document,
   leaving the forged status standing forever.

   Resolution can only reach a record through an identity field that record's
   *own* type declares, so the complete rule is: **a payload carrying one of this
   cell's identity keys (`bill_key`, `eob_key`, `verification_key`,
   `extraction_key`) must be a capture of the type that owns it.** No extra
   reads, and it covers every foreign type that could merge into a bill, an EOB,
   a receipt or an extraction record. On top of that, the guard still refuses
   `status: "verified"` on a `bill`/`eob`, and refuses *any* direct capture
   against a record that already is one, because `capture` merges and an edit
   that mentions no status would otherwise change the numbers under a verified
   record and leave the status standing.

   **`verification_receipt` and `bill_extraction` are not route-writable at
   all.** A receipt is the evidence a promotion rests on and the thing C4 is
   documented to read; every one of its required fields is caller-suppliable,
   including `provenance.confidence: 1.0`, so a direct capture keyed on the
   document id could flip `passed` to true with no failing checks. A
   `bill_extraction` is the audit record of PHI leaving the box. Both are
   written in-process by the job that performed the thing they attest to; a
   hand-written one is a forged attestation, not a correction.

   This closes the external door — the API is the only write door, since MCP and
   chat are read-only (ADR 010/011).
3. **Every run re-judges what it already promoted.** A record that stops passing
   is demoted to `candidate` and gets a receipt naming what failed. This is the
   layer covering what the first two cannot: in-process code holding
   `bills:write` can call `services.capture` directly, which is inside the trust
   boundary (ADR 003) and not something a domain can forbid — so nothing stays
   verified on the strength of an old ruling.

`verification_receipt_id` is written on **every** run, promoted or not: it names
the receipt that last ruled on the record. That is deliberate, because `capture`
merges and cannot remove a key, so a field written only on promotion would linger
as a stale pointer after a demotion.

One consequence worth naming: **erasing a verified candidate demotes it.** A husk
has nothing left to check, and a `verified` status over values nobody can inspect
is a claim the system cannot back. The receipt history still records that it once
passed.

### Contexts, the CLI, and the execution receipt

`python -m domains.bills.verify [document_id ...]` — with ids it verifies those
documents' candidates, without them it sweeps every document some candidate
cites. It runs inside `ops.receipts.run_job`, so every run leaves an
`execution_receipt` and only `ok` exits 0 (ADR 014).

Its context is code-built and **narrower than extraction's**: `bills:read`/
`write` + `ops:read`/`write`, and notably **no `documents:read`** — this job
judges candidates already in the graph and never opens the document they came
from. `require(ctx, "bills:write")` runs **first**, before anything is read or
judged: promotion is the moment a guess becomes something the rest of the system
may act on, so a `bills:read` credential is turned away up front rather than by a
scope check that happens to run later inside `capture` (the C1 HIGH finding).

**A candidate that fails its checks is a result, not a job failure.** Finding a
discrepancy is the job working, so a failing check does not make the run
non-`ok`. This differs from extraction, where a refusal means the work did not
happen.

Two things do fail the run, and they are counted separately on purpose. A
document the run could not judge at all is an `error`. A record whose own stored
state no longer validates against its own type — so the verdict could not be
written back — is `invalid`, and gets its own counter, its own place in the
report line and its own `log.error`. Folding it into a generic error count was
part of the bypass above: a record nothing can rewrite is a record nothing can
demote, which is exactly the state an attacker wants it left in.

**The execution receipt carries no count of medical records** (the C2 precedent,
applied unchanged): `ops` stays model-readable so the briefing and "did the cron
run?" keep working, which makes it the wrong place for "2 verified medical
bills". The receipt carries its name, its status and a constant pointer; the
counts and ids live in the `verification_receipt` records inside the withheld
`bills` domain, and the full line still goes to stdout, which is the operator's
own terminal.

**Lethal-trifecta check (invariant 8).** This component has (c) writes and
neither of the other two legs: its reads are the `bills` domain alone — not
documents, not the person spine, not calendar — and it makes **no external
communication at all**. It is the least-privileged component in the bills path,
which is the right shape for the one that decides what is true.

## Consequences

- **Existing environments need a migration.** `define_missing` only defines
  *absent* types and the registry has no redefinition path, so a database that
  already ran C2 keeps the one-member enum and would refuse every promotion.
  `scripts/migrate_bill_status_verified.py` rewrites the `bill` and `eob` schemas
  in place with a `type.redefined` audit event — the same idempotent
  operator-script shape ADR 012 used. No data backfill: every existing record is
  a `candidate`, which both the old and the new schema accept, and
  `verification_receipt` is a new type `define_missing` will create on the first
  run.
- The bills cell constitution's "everything this cell writes is a candidate" rule
  is amended rather than deleted: everything the *extractor* writes is still a
  candidate, and the verifier is the one thing allowed to say otherwise.
- No new dependency. `Decimal` is stdlib.
- A verified record is no longer editable through `POST /capture`. Correcting one
  by hand means erasing it, or re-extracting and re-verifying.
- **No type outside this cell may declare `bill_key`, `eob_key`,
  `verification_key` or `extraction_key` as an attribute** — the guard refuses
  the capture outright rather than letting entity resolution merge it into a
  bills record. That is a real constraint on the shared identity-field namespace
  and it is the price of the kernel resolver matching on field name across
  types.
- `POST /entities/{id}/forget` on a bill or EOB now returns
  `receipts_redacted` alongside the usual fields, and erases more than it used
  to: every verification receipt naming that record loses its `checks`.
- **Re-extracting a document resets its verified candidates to `candidate`**, by
  construction: `extract._bill_attributes` writes `status: "candidate"` and
  `_capture_record` writes whenever anything differs. That is the safe direction
  — fresh model output means the old ruling no longer applies — and it only
  happens on a deliberate `python -m domains.bills.extract <doc-id>`, since a
  document with a `bill_extraction` record has already left the sweep. The next
  verifier run re-promotes it if it still passes.
- `bill_eob_patient_resp` pairs on `service_date` alone, because it is the only
  field both types state about the same event. Two unrelated services on the same
  day in one document would be cross-checked against each other and would fail.
  That is the safe direction — they stay candidates — and it is the first thing
  to revisit if it fires on real bills.
- Chat still cannot see any of this: adding a type to `bills` does not widen the
  withholding, because it was already domain-wide.
- Above `MAX_CHECKS` (500) a receipt stores failures and unchecked results first,
  sets `checks_truncated`, and promotes **nothing** from that document — a run
  that cannot report in full does not get to grant anything.

## Revisit when

C4 lands (an approval-gated dispute draft will want to read `passed` and cite a
receipt), a real bill trips `bill_eob_patient_resp` on the service-date pairing
(then the pairing needs a claim reference, which means C2 must capture one that
survives erasure), the one-cent tolerance proves wrong against real statements, a
candidate legitimately carries a `low_confidence_fields` entry that should not
block promotion, or the kernel gains a resolver that scopes identity fields per
type — at which point the guard's identity-key rule can shrink back to something
narrower.
