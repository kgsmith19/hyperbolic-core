"""Thin FastAPI passthrough to kernel services (interface constitution).

The AccessContext is built here from the verified request identity — this is
the seam where scoped agent contexts bolt on later (invariant 5) without
touching the kernel. Token verification lives in api.auth (ADR 008).
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import UUID

import jsonschema
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from api.auth import AuthError, AuthUnavailableError, authenticate
from api.auth import settings as auth_settings
from api.dtos import CaptureIn, DefineTypeIn, ForgetIn, RelateIn
from kernel.access import AccessContext, ScopeError
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
    ping,
    relate,
)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    auth_settings()  # fail fast on misconfigured auth before serving traffic
    yield


app = FastAPI(title="lifeos", lifespan=lifespan)


def ctx(request: Request) -> AccessContext:
    return authenticate(request)


Ctx = Annotated[AccessContext, Depends(ctx)]


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


@app.get("/healthz")
def get_healthz() -> dict[str, str]:
    """Liveness for deploys and the compose healthcheck. Touches no data."""
    ping()
    return {"status": "ok"}


@app.post("/types")
def post_types(body: DefineTypeIn, context: Ctx) -> TypeDefinition:
    return define_type(context, body.name, body.domain, body.json_schema, parent=body.parent)


@app.post("/capture")
def post_capture(body: CaptureIn, context: Ctx) -> CaptureResult:
    return capture(
        context,
        body.type_name,
        body.attributes,
        valid_time=body.valid_time,
        actor=body.actor,
    )


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
def post_forget(entity_id: UUID, body: ForgetIn, context: Ctx) -> ForgetResult:
    """Erasure by redaction (ADR 007). Send `{}` to erase every flagged field."""
    try:
        return forget(context, entity_id, fields=body.fields, actor=body.actor)
    except ValueError as exc:  # unflagged field, or an entity with nothing flagged
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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
    parsed: dict[str, Any] | None = json.loads(filters) if filters else None
    return find(context, type_name=type_name, filters=parsed, text=text)
