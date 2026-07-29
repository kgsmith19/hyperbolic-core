"""Thin FastAPI passthrough to kernel services (interface constitution).

The AccessContext is built here from the verified request identity — this is
the seam where scoped agent contexts bolt on later (invariant 5) without
touching the kernel. Token verification lives in api.auth (ADR 008).
"""

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import UUID

import jsonschema
from fastapi import Depends, FastAPI, File, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.auth import AuthError, AuthUnavailableError, authenticate, principal
from api.auth import settings as auth_settings
from api.chat import router as chat_router
from api.dtos import ApproveIn, CaptureIn, DecideIn, DefineTypeIn, ForgetIn, RelateIn
from domains.bills.dispute import (
    AuthorityRefused,
    DecisionResult,
    EmittedDraft,
    ProposalStateError,
    ProposalView,
    approve_proposal,
    emit_draft,
    list_proposals,
    reject_proposal,
)
from domains.bills.types import GRANT_VIA_LOCAL_DEV, GRANT_VIA_OWNER_SESSION
from domains.bills.verify import BillForgetResult, forget_bill, guard_capture, is_bill_record
from domains.documents.capture import (
    MAX_UPLOAD_BYTES,
    DocumentErased,
    DocumentForgetResult,
    DocumentTooLarge,
    ErasureUnverified,
    UnsupportedMedia,
    capture_document,
    forget_document,
    is_document,
)
from kernel.access import AccessContext, ScopeError
from kernel.env import read_env
from kernel.models import Edge, Entity, EntityView, Event, TypeDefinition
from kernel.services import (
    CaptureResult,
    ForgetResult,
    capture,
    define_type,
    find,
    forget,
    get_entity,
    history,
    list_types,
    ping,
    relate,
)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    auth_settings()  # fail fast on misconfigured auth before serving traffic
    yield


app = FastAPI(title="lifeos", lifespan=lifespan)

# Multipart boundary + part headers around the file itself.
_MULTIPART_SLACK = 8 * 1024
_UPLOAD_CHUNK = 64 * 1024


@app.middleware("http")
async def cap_upload_size(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Refuse an oversized upload from its declared length, before the body is
    parsed at all — a route-level check runs only after FastAPI has already
    consumed the multipart body. A client that lies or streams chunked still
    meets the counted read in `post_documents`; this is the first gate, not
    the only one. Registered before CORS so the 413 still carries CORS headers.
    """
    if request.method == "POST" and request.url.path == "/documents":
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES + _MULTIPART_SLACK:
            return JSONResponse(
                status_code=413,
                content={
                    "detail": f"declared body exceeds the {MAX_UPLOAD_BYTES} byte cap",
                },
            )
    return await call_next(request)


# Browser clients (the lifeos-ui SPA). Bearer tokens, no cookies, tailnet-only
# exposure — so a static allowlist is enough; LIFEOS_CORS_ORIGINS overrides.
_UI_ORIGINS = "http://localhost:5173,https://lifeos-prod.taile48c9b.ts.net:8443"
app.add_middleware(
    CORSMiddleware,
    allow_origins=(read_env("LIFEOS_CORS_ORIGINS") or _UI_ORIGINS).split(","),
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)


app.include_router(chat_router)

Ctx = Annotated[AccessContext, Depends(authenticate)]


@app.exception_handler(AuthError)
def auth_error(request: Request, exc: AuthError) -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"detail": str(exc)},
        headers={"WWW-Authenticate": "Bearer"},
    )


@app.exception_handler(AuthUnavailableError)
def auth_unavailable(request: Request, exc: AuthUnavailableError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(ScopeError)
def scope_error(request: Request, exc: ScopeError) -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": str(exc)})


@app.exception_handler(LookupError)
def lookup_error(request: Request, exc: LookupError) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(jsonschema.ValidationError)
def schema_validation_error(request: Request, exc: jsonschema.ValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": exc.message})


@app.exception_handler(jsonschema.SchemaError)
def schema_error(request: Request, exc: jsonschema.SchemaError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": exc.message})


# CONTRACT: ValueError is client input the kernel refused (bad x-flags,
# duplicate type, double supersede, forget on unflagged fields).
@app.exception_handler(ValueError)
def value_error(request: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": str(exc)})


# Upload refusals are ValueErrors too, but they have their own HTTP meanings.
@app.exception_handler(DocumentTooLarge)
def document_too_large(request: Request, exc: DocumentTooLarge) -> JSONResponse:
    return JSONResponse(status_code=413, content={"detail": str(exc)})


@app.exception_handler(UnsupportedMedia)
def unsupported_media(request: Request, exc: UnsupportedMedia) -> JSONResponse:
    return JSONResponse(status_code=415, content={"detail": str(exc)})


@app.exception_handler(DocumentErased)
def document_erased(request: Request, exc: DocumentErased) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


# Not client input: the document's pointers and the blob store disagree, so the
# erasure could not be verified. 500 is the honest answer — refusing loudly is
# the point, since a 200 here would claim a file was destroyed that was not.
@app.exception_handler(ErasureUnverified)
def erasure_unverified(request: Request, exc: ErasureUnverified) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": str(exc)})


# Nothing leaves this system without a valid, matching, unexpired authority
# receipt (ADR 018). A refusal is a 403 rather than a 422: the request is
# well-formed, it is simply not authorised — including the case where the draft
# has changed since a human approved it, which is an authority that no longer
# covers this text.
@app.exception_handler(AuthorityRefused)
def authority_refused(request: Request, exc: AuthorityRefused) -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": str(exc)})


# Approving something already decided, or emitting something not approved.
@app.exception_handler(ProposalStateError)
def proposal_state_error(request: Request, exc: ProposalStateError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.get("/healthz")
def get_healthz() -> dict[str, str]:
    """Liveness for deploys and the compose healthcheck. Touches no data."""
    ping()
    return {"status": "ok"}


@app.post("/types")
def post_types(body: DefineTypeIn, context: Ctx) -> TypeDefinition:
    return define_type(context, body.name, body.domain, body.json_schema, parent=body.parent)


@app.get("/types")
def get_types(context: Ctx) -> list[TypeDefinition]:
    return list_types(context)


@app.post("/capture")
def post_capture(body: CaptureIn, context: Ctx) -> CaptureResult:
    """Generic capture. Bills take one extra check on the way in (ADR 017):
    `status: "verified"` is the reconciliation verifier's to write, and a
    verified record is not editable by hand, because `capture` merges and the
    verified status would survive an edit to the numbers under it. The decision
    lives in the domain; this is the dispatch."""
    guard_capture(context, body.type_name, body.attributes)
    return capture(
        context,
        body.type_name,
        body.attributes,
        valid_time=body.valid_time,
        actor=body.actor,
    )


async def _read_capped(upload: UploadFile) -> bytes:
    """Read the part with a running total, so a client that under-declares its
    Content-Length still cannot push past the cap."""
    chunks: list[bytes] = []
    total = 0
    while chunk := await upload.read(_UPLOAD_CHUNK):
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise DocumentTooLarge(f"document exceeds the {MAX_UPLOAD_BYTES} byte cap")
        chunks.append(chunk)
    return b"".join(chunks)


@app.post("/documents")
async def post_documents(context: Ctx, file: Annotated[UploadFile, File()]) -> EntityView:
    """Capture one uploaded document (ADR 015): the bytes and the extracted
    text go to the blob store, the entity keeps identity plus pointers. The
    same bytes uploaded twice resolve to the same document."""
    entity_id = capture_document(
        context,
        await _read_capped(file),
        filename=file.filename,
        declared_mime=file.content_type,
    )
    return get_entity(context, entity_id)


@app.get("/action-proposals")
def get_action_proposals(context: Ctx, state: str | None = None) -> list[ProposalView]:
    """Drafts this system is proposing, with the letter rendered from live
    records (ADR 018). Reading is only reading: no route below GET writes
    anything, so nothing here can approve a proposal as a side effect. Each view
    carries the `draft_digest` an approval must echo back."""
    return list_proposals(context, state=state)


@app.post("/action-proposals/{proposal_id}/approve")
def post_approve_proposal(
    proposal_id: UUID, body: ApproveIn, request: Request, context: Ctx
) -> DecisionResult:
    """The one action that mints an authority receipt (ADR 018).

    Deliberately explicit in three ways: it is its own POST, it refuses unless
    the caller echoes the digest of the draft it read, and who approved comes
    from the claims verified for *this request* rather than from the body or
    from configuration — a caller cannot say who approved, and neither can the
    environment. `granted_via` records which of those two it was; the domain
    refuses a scope-narrowed context outright.
    """
    subject, verified = principal(request)
    return approve_proposal(
        context,
        proposal_id,
        body.draft_digest,
        subject,
        GRANT_VIA_OWNER_SESSION if verified else GRANT_VIA_LOCAL_DEV,
        actor=body.actor,
    )


@app.post("/action-proposals/{proposal_id}/reject")
def post_reject_proposal(proposal_id: UUID, body: DecideIn, context: Ctx) -> DecisionResult:
    """Say no. Mints nothing — there is no authority in a refusal."""
    return reject_proposal(context, proposal_id, actor=body.actor)


@app.get("/action-proposals/{proposal_id}/draft")
def get_approved_draft(proposal_id: UUID, context: Ctx) -> EmittedDraft:
    """The approved draft, on screen — the terminal state of C4.

    This is the gate: it refuses unless a valid, matching, unexpired authority
    receipt covers this exact text. There is no send here and no transport
    anywhere in this system, so the far side of the gate is the screen; the gate
    is built and exercised anyway, because the check that matters is "did a
    human authorise *this text*" and that is not something to add later.
    """
    return emit_draft(context, proposal_id)


@app.post("/edges")
def post_edges(body: RelateIn, context: Ctx) -> Edge:
    return relate(
        context,
        body.from_id,
        body.relation,
        body.to_id,
        body.valid_from,
        attributes=body.attributes,
    )


@app.get("/entities/{entity_id}")
def get_entity_route(entity_id: UUID, context: Ctx) -> EntityView:
    return get_entity(context, entity_id)


@app.post("/entities/{entity_id}/forget")
def post_forget(
    entity_id: UUID, body: ForgetIn, context: Ctx
) -> DocumentForgetResult | BillForgetResult | ForgetResult:
    """Erasure by redaction (ADR 007). Send `{}` to erase every flagged field.

    Two domains own more of an entity's personal data than `forget()` can see,
    and both dispatch here so there is one erasure endpoint and no under-erasing
    trap; the behavior lives in the domain module either way.

    Documents: most of a document's personal data is in the stored file, which
    `forget()` cannot reach, so redacting attributes alone would report an
    erasure that left the bill on disk (ADR 015). The response carries
    `blobs_deleted`, so the claim is checkable.

    Bills and EOBs: a candidate's verification receipts hold numbers derived
    from its amounts, in a different entity that `forget()` — which is strictly
    per-entity — never touches (ADR 017). The response carries
    `receipts_redacted` for the same reason.
    """
    if is_document(context, entity_id):
        return forget_document(context, entity_id, fields=body.fields, actor=body.actor)
    if is_bill_record(context, entity_id):
        return forget_bill(context, entity_id, fields=body.fields, actor=body.actor)
    return forget(context, entity_id, fields=body.fields, actor=body.actor)


@app.get("/entities/{entity_id}/history")
def get_history(entity_id: UUID, context: Ctx) -> list[Event]:
    return history(context, entity_id)


@app.get("/search")
def get_search(
    context: Ctx,
    type_name: str | None = None,
    text: str | None = None,
    filters: str | None = None,
) -> list[Entity]:
    parsed: Any = json.loads(filters) if filters else None
    if parsed is not None and not isinstance(parsed, dict):
        raise ValueError("filters must be a JSON object")
    return find(context, type_name=type_name, filters=parsed, text=text)
