"""Thin FastAPI passthrough to kernel services (interface constitution).

The AccessContext is built here from the verified request identity — this is
the seam where scoped agent contexts bolt on later (invariant 5) without
touching the kernel. Token verification lives in api.auth (ADR 008).
"""

import hmac
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import UUID

import jsonschema
from fastapi import Depends, FastAPI, File, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

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
from domains.bills.types import GRANT_VIA_LOCAL_DEV, GRANT_VIA_OWNER_SESSION, TYPE_BILL, TYPE_EOB
from domains.bills.verify import BillForgetResult, forget_bill, is_bill_record
from domains.bills.verify import guard_capture as guard_bill_capture
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
from domains.documents.capture import guard_capture as guard_document_capture
from domains.episodes.capture import guard_capture as guard_episode_capture
from domains.health_connect.ingest import IngestResult, process_payload
from domains.intentions.focus import guard_capture as guard_intention_capture
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


class _StripRootPathMiddleware:
    """Base-path mechanics for the one-origin route table (m2-08;
    docs/planning/05-a-hyperbolic-core.md section 4; 10-cicd-deployment.md
    section 4: "LifeOS API; FastAPI `root_path` handles the prefix").

    `tailscale serve --set-path=/life/api/ http://127.0.0.1:8000` forwards
    the FULL incoming path to this upstream — it does not strip the mount
    prefix itself (that is standard `tailscale serve` behavior for an HTTP
    backend, not something this app controls) — so a browser request for
    `/life/api/types` arrives here with `scope["path"] == "/life/api/types"`,
    not `/types`. FastAPI's `root_path` constructor argument alone does NOT
    make the router strip a prefix from the incoming path: Starlette only
    uses it for URL generation (OpenAPI/docs links), never for route
    matching. Actually stripping the prefix from `scope["path"]` before
    routing — while recording it in `scope["root_path"]` so downstream URL
    generation still reflects it — is the documented FastAPI "behind a proxy
    that does not strip the path" recipe; this class is that recipe as a raw
    ASGI middleware (cheaper than the `@app.middleware("http")` /
    `BaseHTTPMiddleware` form for a check this cheap, and avoids rebuilding a
    `Request` object just to read `scope["path"]`).

    `LIFEOS_ROOT_PATH` is read PER REQUEST (via `read_env`, the same
    env-lookup `api.auth.settings()` uses), not baked in once at import time:
    `app` is a module-level singleton constructed at import, and baking the
    prefix in then would make it impossible for a test to exercise both the
    "behind /life/api" and "run standalone" shapes against the same `app`
    object without `importlib.reload`. Unset (the default — every existing
    deploy and every existing test before this issue), this is a no-op: the
    request passes through with its path untouched, which is what keeps
    `pytest`'s existing `TestClient(app)` calls against bare paths like
    `/search` passing unchanged (LO-1).

    Registered LAST among this file's middleware (after `CORSMiddleware`,
    below `cap_upload_size`'s own registration): Starlette wraps middleware
    added later AROUND the ones added earlier (see `cap_upload_size`'s own
    "registered before CORS" comment for the same rule stated the other
    direction), so this ends up outermost — the path is rewritten before
    `cap_upload_size`'s `request.url.path == "/documents"` check, before CORS,
    and before routing, which is the one order every one of those depends on
    being correct behind the `/life/api` prefix.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        prefix = (read_env("LIFEOS_ROOT_PATH") or "").rstrip("/")
        path = scope["path"]
        prefix_matches = path.startswith(prefix) and (
            len(path) == len(prefix) or path[len(prefix)] == "/"
        )
        if prefix and prefix_matches:
            scope = dict(scope)
            scope["root_path"] = scope.get("root_path", "") + prefix
            scope["path"] = path[len(prefix):] or "/"
        await self.app(scope, receive, send)


app.add_middleware(_StripRootPathMiddleware)

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


def _hc_secret_context(request: Request) -> AccessContext:
    """Verify the shared-secret header for the Health Connect webhook.

    The Android app (mcnaveen/health-connect-webhook) sends a custom header per
    webhook URL; we use X-HC-Secret. LIFEOS_HC_SECRET must be set in the
    environment; if it is unset the endpoint fails closed with 503 — ingestion
    is refused until the server is configured, even when LIFEOS_AUTH_MODE is
    disabled (#89). Falls through with AccessContext scoped to health_connect
    only (no owner-level access).
    """
    expected = read_env("LIFEOS_HC_SECRET")
    if not expected:
        raise AuthUnavailableError("LIFEOS_HC_SECRET is not configured; refusing ingestion")
    provided = request.headers.get("X-HC-Secret", "")
    if not hmac.compare_digest(provided, expected):
        raise AuthError("invalid or missing X-HC-Secret")
    return AccessContext.of("health_connect:read", "health_connect:write")


HcCtx = Annotated[AccessContext, Depends(_hc_secret_context)]


@app.post("/health-connect")
def post_health_connect(body: dict[str, Any], context: HcCtx) -> IngestResult:
    """Receive one Health Connect Webhook delivery (H1).

    The Android app posts a rolling 48-hour window and retries on failure, so
    duplicate delivery is the normal case. Every record is idempotent by content
    hash — replaying the same window emits zero new events.

    Auth: X-HC-Secret header (set as a custom header in the webhook URL config;
    see docs/runbook.md for rotation). No JWT: the app cannot hold a user token.
    """
    return process_payload(context, body)


@app.post("/types")
def post_types(body: DefineTypeIn, context: Ctx) -> TypeDefinition:
    return define_type(context, body.name, body.domain, body.json_schema, parent=body.parent)


@app.get("/types")
def get_types(context: Ctx) -> list[TypeDefinition]:
    return list_types(context)


@app.post("/capture")
def post_capture(body: CaptureIn, context: Ctx) -> CaptureResult:
    """Generic capture. Four domains lock this door on the way in; the
    decisions live in the domains, this is the dispatch. Three locks are on the
    record the write would land on, not the type name it claims. Bills
    (ADR 017): `status: "verified"` is the reconciliation verifier's to write,
    and a verified record is not editable by hand, because `capture` merges and
    the verified status would survive an edit to the numbers under it.
    Documents (ADR 015): `document` records exist only through the upload and
    erasure paths, and a foreign type carrying the `sha256` identity key would
    merge into a real document — dangling its refs or forging its tombstone.
    Intentions (INT1): at most three intentions carry focus=true — the focus-3
    rule counts current records and refuses a capture that would make a
    fourth. Episodes (EP1): intensity within 0-10, end_date never before
    onset_date, feared_duration_days positive, playbook versions append-only,
    and the `onset_date` identity key embargoed to the episode type."""
    guard_bill_capture(context, body.type_name, body.attributes)
    guard_document_capture(body.type_name, body.attributes)
    guard_episode_capture(context, body.type_name, body.attributes)
    guard_intention_capture(context, body.type_name, body.attributes)
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


class DocumentForgetResponse(DocumentForgetResult):
    """The one-endpoint composition: a document's own erasure plus the bills
    cascade over every candidate extracted from it. The counts are the claim's
    evidence — a caller can check completeness instead of trusting the 200."""

    candidates_erased: int
    receipts_redacted: int


@app.post("/entities/{entity_id}/forget")
def post_forget(
    entity_id: UUID, body: ForgetIn, context: Ctx
) -> DocumentForgetResponse | DocumentForgetResult | BillForgetResult | ForgetResult:
    """Erasure by redaction (ADR 007). Send `{}` to erase every flagged field.

    Two domains own more of an entity's personal data than `forget()` can see,
    and both dispatch here so there is one erasure endpoint and no under-erasing
    trap; the behavior lives in the domain module either way.

    Documents: most of a document's personal data is in the stored file, which
    `forget()` cannot reach, so redacting attributes alone would report an
    erasure that left the bill on disk (ADR 015). And the bill/eob candidates
    extracted FROM the document (C2) are separate bills-domain entities whose
    issuer, references, dates and amounts came out of it, linked only by the
    provenance citation — so forgetting a document routes every candidate
    citing it through the bills domain's own forget path first (which cascades
    to verification receipts and authority digests). First, because over-erasing
    a derived record is the safe direction: a failure part-way must not leave
    the candidates as the only survivors, and a retry can finish the job (the
    `forget_bill` precedent). Composed here so the documents domain never
    imports bills; each decision stays in its domain, this is the dispatch. The
    response carries `blobs_deleted`, `candidates_erased` and
    `receipts_redacted`, so the claim is checkable.

    Bills and EOBs: a candidate's verification receipts hold numbers derived
    from its amounts, in a different entity that `forget()` — which is strictly
    per-entity — never touches (ADR 017). The response carries
    `receipts_redacted` for the same reason.
    """
    if is_document(context, entity_id):
        if body.fields is not None:
            # All-or-nothing is the domain's rule; dispatch straight to its
            # refusal so a doomed request cannot cascade anything first.
            return forget_document(context, entity_id, fields=body.fields, actor=body.actor)
        # Only a type that was NEVER DEFINED may skip its arm of the cascade —
        # that is the "nothing was ever extracted" box (the
        # `extract._pending_documents` precedent). A ScopeError propagates as
        # the 403 it is, before anything is erased: a context that cannot see
        # the candidates must not erase the document out from under them and
        # report `candidates_erased: 0` on a 200. `list_types` cannot make
        # this call — it answers "visible to this context", not "defined", so
        # gating on it would turn the refusal into a silent fail-open skip
        # (the C3 silence precedent).
        candidates: list[UUID] = []
        for type_name in (TYPE_BILL, TYPE_EOB):
            try:
                candidates.extend(
                    entity.id
                    for entity in find(
                        context,
                        type_name=type_name,
                        filters={"provenance": {"source_entity_ids": [str(entity_id)]}},
                    )
                )
            except LookupError:
                continue  # never defined: nothing was ever extracted
        receipts_redacted = sum(
            forget_bill(context, candidate_id, actor=body.actor).receipts_redacted
            for candidate_id in candidates
        )
        result = forget_document(context, entity_id, fields=body.fields, actor=body.actor)
        return DocumentForgetResponse(
            **result.model_dump(),
            candidates_erased=len(candidates),
            receipts_redacted=receipts_redacted,
        )
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
