"""Thin FastAPI passthrough to kernel services (interface constitution).

The single-user AccessContext is built here — this is the seam where scoped
agent contexts bolt on later (invariant 5) without touching the kernel.
"""

import json
from typing import Annotated, Any
from uuid import UUID

import jsonschema
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from api.dtos import CaptureIn, DefineTypeIn, RelateIn
from kernel.access import AccessContext, ScopeError
from kernel.models import Edge, Entity, EntityView, Event, TypeDefinition
from kernel.services import (
    CaptureResult,
    capture,
    define_type,
    find,
    get_entity,
    history,
    relate,
)

app = FastAPI(title="lifeos")


def ctx() -> AccessContext:
    return AccessContext.all()


Ctx = Annotated[AccessContext, Depends(ctx)]


@app.exception_handler(ScopeError)
def scope_error(request: Request, exc: ScopeError) -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": str(exc)})


@app.exception_handler(LookupError)
def lookup_error(request: Request, exc: LookupError) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(jsonschema.ValidationError)
def schema_validation_error(request: Request, exc: jsonschema.ValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": exc.message})


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
