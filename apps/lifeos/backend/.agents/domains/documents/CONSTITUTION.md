# Documents cell

Owns: `src/domains/documents/**`, `tests/documents/**`.

- A life domain, not kernel: `document` is registry data (invariant 1) and
  every state change goes through kernel application services —
  capture/find/get_entity/forget, never raw tables or SQL (invariant 7).
- **File content never enters `entity.attributes`.** Bytes and extracted text
  live in the blob store; the entity holds identity plus refs, metadata and
  counts. `entity.search` is a generated tsvector over `attributes::text` and
  `forget()` is per-entity, so text in an attribute is searchable by anything
  with read scope (chat included) and un-erasable in practice (invariant 9,
  ADR 012/015).
- **`document` is `x-sensitive` (ADR 016), so this whole domain is withheld
  from the shared agent-tool surface.** C1 reasoned that exposing documents to
  chat was safe because the bytes and the extracted text are not in the graph.
  That was incomplete: `original_filename` is, and it routinely reads
  `EOB_Jane_Doe_2026-03.pdf`. Anything added to this domain's attributes is
  reachable by whatever can read the domain, so assume a filename is PHI.
- An identity field is never a PII field. `sha256` keys a document because it
  survives `forget()`; a filename does not, and keying on one would let the
  next upload of the same content mint a fresh entity carrying it (ADR 012
  "Durable erasure").
- **Erasing a document means `forget_document`, never `forget()` alone**: write
  scope is required first, every ref is confirmed to name a real file, the
  tombstone is captured, the blobs are unlinked and confirmed gone, and only
  then does the kernel redaction run — in that order, so the tombstone's own
  event is scrubbed too. Erasure is all-or-nothing; a partial field redaction
  that leaves the file on disk is refused. Re-uploading tombstoned bytes is
  refused as well: erasure does not reach the owner's own copy, so silence
  there would undo it.
- **Check the scope before the filesystem, and check the filesystem after.**
  `BlobStore` takes no AccessContext and its deletes are irreversible (blobs
  are not in the nightly `pg_dump`), so a read-scoped context must be turned
  away before any path is touched — never by a scope check that happens to run
  later. And an erasure that deleted nothing is never reported as a success:
  refuse loudly instead, and surface the blob count so the claim is checkable.
- Uploads are untrusted input: cap the bytes before the body is read, sniff the
  MIME from magic bytes instead of believing the client, bound pages and
  extracted characters, sanitize the filename to display text (it is never a
  path), and never shell out.
- A parser that refuses is a recorded fact, not a crash: `extract_text` never
  raises, and a total failure still yields a captured document with
  `extraction_status: "failed"`. The exception *class* goes to the log and the
  status to the entity — never the message, which is built from the tokens
  being parsed and so can quote the document. **The log counts as a store
  here**: no erasure path reaches it, so nothing derived from document content
  may be written there (invariant 9, ADR 012/014/015).
- Blob refs are re-validated against the store's key space before they become
  a path, every time. They come out of the database, which is not a reason to
  trust them.
- **The store is this cell's private business.** Another domain that needs a
  document's text asks `read_document_text` (read scope required, erased
  documents refused) and never constructs a `BlobStore` of its own — otherwise
  the ref validation, the scope check and the tombstone check all become
  optional (ADR 015/016).
- No outbound requests from this domain. If one is ever added, the B1 SSRF rule
  (no cross-host redirects) applies to it.
- Behavior changes land with tests in `tests/documents/` (unit for the store
  and for extraction, integration for capture and erasure). Test documents are
  generated in-process; no binary fixtures, and never a real medical document.
