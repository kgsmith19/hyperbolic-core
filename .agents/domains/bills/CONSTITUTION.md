# Bills cell

Owns: `src/domains/bills/**`, `tests/bills/**`.

- A life domain, not kernel: `bill`, `eob` and `bill_extraction` are registry
  data (invariant 1) and every state change goes through kernel application
  services — capture/find/get_entity/history, never raw tables or SQL
  (invariant 7).
- **Everything this cell writes is a CANDIDATE, never a fact.** `status` is a
  single-value enum (`"candidate"`), provenance carries
  `method: "llm_extraction"`, and no record may claim confidence 1.0 — that is
  reserved for direct kernel reads (ADR 010). Turning a candidate into a
  verified fact is C3's deterministic verifier, not this cell's job; nothing
  here reconciles, decides truth, or sends anything anywhere.
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
- **The execution receipt is not a place for counts of medical records.** It
  lives in `ops`, which stays model-readable so the briefing works. This job's
  receipt carries its name and status only; counts and produced ids belong in
  `bill_extraction`, inside the withheld domain, and on stdout.
- Runs under a narrow code-built AccessContext, never `AccessContext.all()`:
  `bills:read`/`write` for its own records, `documents:read` (never
  `documents:write` — this cell must not be able to unlink a bill's blobs),
  and `ops:read`/`write` for the run's own execution receipt.
- The CLI is a scheduled entry point: it runs inside `ops.receipts.run_job`, so
  every run leaves a receipt and only `ok` exits 0 (ADR 014).
- Behavior changes land with tests in `tests/bills/` (unit for parsing and
  bounds, integration for extraction and erasure). Tests never call the real
  Anthropic API — inject a fake client. Fixtures are synthetic; no real medical
  document and no real PHI ever enters this repo.
