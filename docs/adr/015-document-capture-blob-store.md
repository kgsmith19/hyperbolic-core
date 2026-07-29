# ADR 015: Document capture — a filesystem blob store beside the graph

## Decision

**Shape.** Documents are a life domain, not kernel: one `type_definition` row
(`document`, domain `documents`) plus a module `src/domains/documents/` — zero
kernel DDL (invariant 1, ADR 002), no new deployable and no new repo (ADR 009).
The whole slice is that module plus one API route (`POST /documents`) and one
line of dispatch on the existing forget route. Every state change goes through
kernel application services (`capture`/`find`/`get_entity`/`forget`); the module
holds no SQL, so untrusted document metadata only ever reaches the database
parameterized (invariant 7).

**Scope of C1.** Upload → stored bytes → extracted text → a `document` entity
carrying sha256 identity and refs. It does **not** parse bills, does not call a
model, and creates no bill/EOB entities: that is C2.

**Bytes and text live on the filesystem, not in `entity.attributes`.** This is
the binding B1 finding applied to a much worse payload. `entity.search` is a
generated tsvector over `attributes::text` and `forget()` is strictly
per-entity, so a medical bill's text placed in an attribute would be (a)
full-text searchable by anything holding `documents:read` — including chat,
whose context reads every active domain — and (b) un-erasable in practice
wherever it had been copied. ADR 012, 013 and 014 each hit the same edge and
each answered it the same way: store hashes and IDs, never third-party text.
C1 needs the text itself, so the answer is a different store, not a different
attribute.

The store is `src/domains/documents/storage.py`: a content-addressed directory
tree rooted at `LIFEOS_BLOB_ROOT` (default `var/blobs`, mounted as the
`lifeos-blobs` compose volume). Keys are `<first two hex>/<sha256>.<bin|txt>`
and nothing else — the original filename never becomes a path (it is untrusted,
PII-bearing text), the suffix is deliberately not the real extension so nothing
on the box is tempted to open a stored file by type, and every ref is re-matched
against that pattern *and* re-checked for containment before it becomes a path,
because refs come back out of the database.

**Why not Supabase Storage.** It is available and it was the obvious candidate,
and it loses on the one axis that matters here. Erasure would become a network
call to a service whose delete we cannot exercise in CI (no bucket, no
credential, no network), so the invariant-9 regression test — the thing that
actually keeps erasure honest — would become a mock. It would also need a new
service-role credential on the box, which is exactly the "another component
holding another component's credentials" smell ADR 009 says to refuse. A local
`unlink` is verifiable, testable, needs no secret, and the trust boundary does
not change (ADR 003: the box and the database are both already inside it).
A third option — a dedicated Postgres table — is kernel DDL, which invariant 1
forbids outright.

The cost is stated plainly: **the nightly `pg_dump` (ADR 008) does not cover
blobs.** The event log restores every `document` entity, but a restored database
points at files a lost box no longer has. The owner's own copies are the source
of truth for the bytes. Backing up blobs is a future decision, not an oversight;
it is in the revisit list.

**Erasure removes the bytes, and `POST /entities/{id}/forget` is still the one
endpoint.** `forget()` is a kernel service over attributes and event payloads; it
knows nothing about a file on disk, so redacting a document's attributes alone
would report an erasure that left the bill sitting in the volume. Three parts:

- `domains.documents.capture.forget_document` is the whole erasure, and every
  step of it is *checked* rather than attempted:
  1. `require(ctx, "documents:write")` **first**, before the function touches
     the filesystem at all. `BlobStore` takes no AccessContext and cannot check
     anything, and deleting a blob is irreversible (blobs are not in the
     nightly `pg_dump`), so leaning on the scope check inside a later `capture`
     would let a `documents:read` token — a credential whose entire guarantee
     is that it mutates nothing — destroy the bill and only then be refused.
  2. Confirm every ref the entity holds names a file that is actually in the
     store, before anything is written or unlinked. A document whose pointers
     have drifted is left exactly as it was.
  3. Capture the durable `erased_at` tombstone.
  4. Unlink the blobs, confirming after each unlink that the file is gone.
  5. Run the kernel redaction over every event that ever mentioned the entity —
     last, so the tombstone's own event is redacted too.

  Steps 2 and 4 exist because an erasure that deleted nothing must never return
  200. `POST /capture` accepts `type_name: "document"` and the resolver merges
  on `sha256`, so a well-formed-but-dangling `storage_ref` can replace the real
  one; without the check, the erasure would report success, leave the bill in
  the volume with no pointer to it, and set a 409 blocking the re-upload that
  might have re-associated it. That is the B1 failure — erasure silently
  undoing itself — in a new costume. The result carries `blobs_deleted`, so the
  API response backs its own claim instead of asking the caller to trust it.

  Three outcomes, three answers, none of them a false success: an
  already-erased document (every ref absent *and* `erased_at` set) is a 409;
  drifted or partially-absent pointers are a 500, because the system is
  inconsistent and an operator needs to look; only a verified deletion returns
  200. A partially-absent set is deliberately not read as "already erased" —
  that would strand the surviving blob, and a retry after a mid-erasure failure
  must still be able to finish the job.
- The API route dispatches to it when the entity is a document. A separate
  `/documents/{id}/forget` was rejected: the generic route would still exist and
  would still silently under-erase, which is a trap, and the trap is precisely
  the failure invariant 9 exists to prevent. The dispatch is one `if`; all the
  behavior lives in the domain module.
- Document erasure is all-or-nothing. A partial field redaction is refused,
  because most of a document's personal data is in the file rather than in the
  entity, and "erased the filename, kept the bill" is not a thing to offer.

**Identity is the content hash, and erasure is durable.** `sha256` is the
`x-identity` field and is deliberately **not** `x-pii`: `forget()` strips PII,
so keying on an erasable field makes an erased entity unfindable and the next
arrival of the same content mints a brand-new entity carrying it — the ADR 012
"Durable erasure" failure. `original_filename` (routinely
`EOB_Jane_Doe_2026-03.pdf`) is the one `x-pii` field and is therefore not
`required`, so an erased document is still a valid document.

The upload form of that failure needed one more control. Erasure does not reach
the owner's own copy of the file, so re-uploading the same bytes afterwards
would quietly re-store what they asked us to destroy. The `erased_at` tombstone
survives `forget()` (not PII, by design) and a re-upload of tombstoned bytes is
**refused with 409**, loudly, rather than silently reinstated. Reinstating an
erased document is a decision nobody has made yet, so this slice does not offer
a way to make it accidentally.

**Idempotency falls out of the identity field.** The same bytes hash to the same
`sha256`, so a re-upload resolves to the existing entity and emits **zero** new
events — not even an `entity.updated`, since capture is skipped entirely. Blob
writes are idempotent by digest for the same reason.

**Uploads are untrusted input.** 10 MiB cap, enforced twice: an HTTP middleware
refuses on the declared `Content-Length` before the multipart body is parsed at
all (a route-level check runs only after FastAPI has already consumed it), and
the route then reads the part with a running total, so a client that
under-declares still cannot get past the cap. MIME comes from **magic bytes**,
never the client's word, and a declared type that contradicts the content is
refused (415) rather than ignored — C2 must not inherit a mislabelled document.
Accepted: PDF, PNG, JPEG. Extraction is bounded at 200 pages and 200 000
characters, with `text_truncated` recorded rather than silently dropping the
rest. Filenames are sanitized to display text (basename, no control characters,
255 chars) and are used for nothing else. Nothing shells out: both parsers run
in-process on bytes already in memory.

A corrupt, encrypted or adversarial PDF must **fail cleanly**: `extract_text`
never raises. `pymupdf` is the primary parser and `pdfplumber` the fallback —
independent implementations (MuPDF vs pdfminer.six), so a file that trips one
often survives the other — and if both refuse, the document is still captured
with `extraction_status: "failed"`. The broad `except` there is deliberate and
is the one place this repo wants it.

Nothing derived from the document's *content* leaves that function. The entity
records a status and a parser name; the log records the exception **class**
name; the exception *message* is recorded nowhere, because parser errors are
built from the tokens being parsed and would quote the bill. The log matters
here as much as the database does: the container log is a sink that **no
erasure path reaches** — not `forget()`, which covers attributes and event
payloads, and not `forget_document`, which covers blobs — so anything written
there is un-erasable by construction (invariant 9, ADR 012/014).
Residual risk, stated: MuPDF is a large C library and the process is not a
sandbox, so a memory-safety bug in it is not something a `try` can catch. That
is accepted for a single-user, tailnet-only box processing the owner's own bills
(ADR 003/008), and it is a revisit trigger if documents ever arrive from
elsewhere.

**Images are stored but not read.** OCR needs either a shell-out (forbidden
here) or a model call (C2's job), so an image gets
`extraction_status: "unsupported"` — which is what happened. Calling it
`"failed"` would be a lie.

**No outbound fetch exists in this slice**, so the B1 SSRF finding (refuse
cross-host redirects) has nothing to apply to. Saying so is the point: the rule
is not skipped, there is simply no fetch.

**Lethal-trifecta check (invariant 8).** The upload path has (c) writes and
neither of the other legs: its reads are limited to the `documents` domain (not
broad), and it makes **no external communication at all**. The leg it lacks is
(b). One consequence worth naming: `documents` becoming an active domain means
chat's scope-stripped context gains `documents:read`, so the model can list
document entities — hashes, sizes, MIME types, and the owner's own filenames.
It cannot reach the bytes or the extracted text, because those are not in the
graph and no tool reads the blob store. That is the storage decision paying for
itself a second time.

**Contexts stay code-built and narrow** (B1/B3 precedent). The API route runs
under the verified owner context, exactly as every other route does; the domain
functions need `documents:read` + `documents:write` and are tested under exactly
those and nothing more. `AccessContext.all()` appears nowhere new.

**`x-sensitive` is deferred to C2, explicitly.** The roadmap raises it for
medical types. `document` is a generic container — the same type holds a
recipe and an EOB — so the flag has no honest meaning at this level, and this
slice can build no enforcement for it that a test could exercise. Rather than
ship a decorative flag, C1 ships none: C2 defines `x-sensitive` on the medical
bill/EOB types, where it can carry a specific meaning and a specific
enforcement.

## Consequences

- The `documents` cell (`.agents/domains/documents/`) exists per invariant 10,
  and the guards cell map needs a `documents` entry for `src/domains/documents/**`
  and `tests/documents/**`.
- Two new dependencies (`pymupdf`, `pdfplumber`) and `python-multipart`, which
  FastAPI needs for multipart form parsing.
- Agent tokens carry no `documents:read` until the operator re-mints, so
  documents stay dark to MCP by default (ADR 010 fail-closed). Chat is the
  exception noted above, because it derives its scopes from active domains.
- Restoring an old blob-volume snapshot over a live one would resurrect erased
  files. That is now a runbook rule, not a thing anyone should have to infer.
- A document that fails extraction is still a first-class document: C2 can
  re-run extraction against the stored bytes without a re-upload.

## Revisit when

Blobs become worth backing up (a second copy of a bill the owner no longer has),
images need OCR (that is a model call, so it lands with C2's LLM decision),
documents start arriving from somewhere other than the owner's own upload (then
the MuPDF residual risk needs a sandbox, and the SSRF rule acquires something to
apply to), a second consumer needs to read blobs (today only this module does),
or reinstating an erased document becomes a real need rather than an accident
waiting to happen.
