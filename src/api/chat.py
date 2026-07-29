"""POST /chat — grounded chat with citations (ADR 011, roadmap A2).

A manual Anthropic tool loop over the shared agent-tool surface
(mcp_server.tools). Read-only by construction: the verified owner context is
replaced with a scope-stripped context holding only `<domain>:read` for the
active type domains (invariant 5), so the loop cannot write no matter what
the model asks for. Streams SSE frames: text / tool / done / error.
"""

import json
import logging
import time
from collections.abc import Iterator
from typing import Annotated, Any, Literal

import anthropic
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.auth import authenticate
from kernel import db
from kernel.access import AccessContext
from kernel.env import read_env
from mcp_server import tools

log = logging.getLogger("lifeos.chat")
router = APIRouter()

MAX_TURNS = 5
MAX_TOKENS = 16000
ABSTAIN_MSG = "I can't help with that request."
CHAT_STYLE = (
    " You are chatting with the owner of this data. Keep answers brief and "
    "direct; lead with the answer, then the supporting records."
)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class ChatIn(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)


def get_model_client() -> anthropic.Anthropic:
    return anthropic.Anthropic()


def read_only_context() -> AccessContext:
    """Strip to read scopes over every active type domain (invariant 5)."""
    with db.connect() as conn:
        rows = conn.execute(
            "select distinct domain from type_definition where is_active"
        ).fetchall()
    return AccessContext.of(*(f"{row['domain']}:read" for row in rows))


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _stream_params(convo: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "model": read_env("LIFEOS_CHAT_MODEL") or "claude-opus-5",
        "max_tokens": MAX_TOKENS,
        "output_config": {"effort": read_env("LIFEOS_CHAT_EFFORT") or "low"},
        "system": tools.INSTRUCTIONS + CHAT_STYLE,
        "tools": tools.AGENT_TOOLS,
        "messages": convo,
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
    }


def _run(client: anthropic.Anthropic, ctx: AccessContext, body: ChatIn) -> Iterator[str]:
    convo: list[dict[str, Any]] = [m.model_dump() for m in body.messages]
    citations: dict[str, set[str]] = {"entity_ids": set(), "event_ids": set(), "methods": set()}
    started = time.monotonic()
    model_ms = tool_ms = turns = 0
    stop_reason = "end_turn"
    try:
        for _ in range(MAX_TURNS):
            turns += 1
            turn_start = time.monotonic()
            params = _stream_params(convo)
            with client.beta.messages.stream(**params) as stream:
                for text in stream.text_stream:
                    yield _sse("text", {"delta": text})
                final = stream.get_final_message()
            model_ms += int((time.monotonic() - turn_start) * 1000)
            stop_reason = final.stop_reason or "end_turn"
            convo.append({"role": "assistant", "content": final.content})

            if stop_reason == "refusal":
                yield _sse("text", {"delta": ABSTAIN_MSG})
                break
            if stop_reason == "max_tokens":
                yield _sse(
                    "error", {"detail": "response hit the token limit; ask again more narrowly"}
                )
                return
            tool_uses = [b for b in final.content if b.type == "tool_use"]
            if not tool_uses:
                break

            results: list[dict[str, Any]] = []
            tool_start = time.monotonic()
            for block in tool_uses:
                yield _sse("tool", {"name": block.name})
                try:
                    payload = tools.run_tool(ctx, block.name, dict(block.input))
                except Exception as exc:  # tool errors go back to the model, not the wire
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": f"error: {exc}",
                            "is_error": True,
                        }
                    )
                    continue
                prov = payload["provenance"]
                citations["entity_ids"].update(prov["source_entity_ids"])
                citations["event_ids"].update(prov["source_event_ids"])
                citations["methods"].add(prov["method"])
                results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(payload)}
                )
            tool_ms += int((time.monotonic() - tool_start) * 1000)
            convo.append({"role": "user", "content": results})

        total_ms = int((time.monotonic() - started) * 1000)
        log.info(
            "chat: total_ms=%d model_ms=%d tool_ms=%d turns=%d stop=%s",
            total_ms,
            model_ms,
            tool_ms,
            turns,
            stop_reason,
        )
        yield _sse(
            "done",
            {
                "citations": {key: sorted(values) for key, values in citations.items()},
                "latency": {"model_ms": model_ms, "tool_ms": tool_ms, "total_ms": total_ms},
                "model": _stream_params([])["model"],
                "stop_reason": stop_reason,
            },
        )
    except Exception as exc:  # mid-stream: headers are gone, surface on the wire
        log.exception("chat failed")
        yield _sse("error", {"detail": str(exc)})


@router.post("/chat")
def post_chat(
    body: ChatIn,
    _owner: Annotated[AccessContext, Depends(authenticate)],
    client: Annotated[anthropic.Anthropic, Depends(get_model_client)],
) -> StreamingResponse:
    """Grounded chat: the owner authenticates, the loop runs read-only."""
    ctx = read_only_context()
    return StreamingResponse(_run(client, ctx, body), media_type="text/event-stream")
