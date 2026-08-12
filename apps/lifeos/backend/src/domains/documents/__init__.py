"""Documents domain (ADR 015): upload capture with the bytes kept out of the
entity graph.

Types are registry data (zero kernel DDL, invariant 1) and every state change
goes through kernel application services (invariant 7). A `document` entity is
identity plus pointers — `sha256`, a `storage_ref`, an optional `text_ref` —
while the file and its extracted text live in the blob store
(`storage.py`), because attributes are tsvector-indexed and erased only per
entity (ADR 012/015). Erasing a document therefore means
`capture.forget_document`, not `forget()` alone.
"""
