"""POST /chat — grounded chat with citations (ADR 011, roadmap A2).

A manual Anthropic tool loop over the shared agent-tool surface
(mcp_server.tools). Read-only by construction: the verified owner context is
replaced with a scope-stripped context holding only `<domain>:read` for the
active type domains (invariant 5), so the loop cannot write no matter what
the model asks for. Stripping intersects, never widens — a narrowed token
(ADR 008 `scopes` claim) stays narrow here. Streams SSE frames:
text / tool / done / error.

Episode-shaped messages never reach the model (roadmap EP1): the episodes
domain is x-sensitive and withheld from the tool surface (ADR 016), so the
route dispatches to `domains.episodes.lines.deterministic_reply` first — a
kernel-side composition whose lines stream straight to the owner and whose
citations fill the done frame. The routing decision and the composition both
live in the episodes cell; this route only dispatches and renders. The same
guarantee holds across turns: the protocol is stateless and the client
replays deterministic replies as ordinary assistant text, so `_replayable`
scrubs every routed turn-pair from the history before any model call.
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
from domains.episodes import lines as episode_lines
from kernel import services
from kernel.access import AccessContext
from kernel.env import read_env
from mcp_server import tools

log = logging.getLogger("lifeos.chat")
router = APIRouter()

MAX_TURNS = 5
MAX_TOKENS = 16000
ABSTAIN_MSG = "I can't help with that request."
TURN_CAP_MSG = "I couldn't finish that within the available steps."
# Mid-stream failures reach the browser. Say that it broke, never what broke:
# the detail could be a driver error quoting SQL and table names.
ERROR_MSG = "something went wrong answering that; the error was logged"
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
    # Follow the repo secret convention (env var or repo .env via read_env) —
    # the SDK's own resolution only looks at process env.
    return anthropic.Anthropic(api_key=read_env("ANTHROPIC_API_KEY"))


def read_only_context(owner: AccessContext) -> AccessContext:
    """Strip `owner` to read scopes over the active type domains (invariant 5).

    An intersection, never a widening: `active_domains` only returns domains
    `owner` can already read, so a token narrowed by its `scopes` claim keeps
    exactly that reach and an all-scopes owner still gets every domain.
    """
    return AccessContext.of(*(f"{domain}:read" for domain in services.active_domains(owner)))


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _last_user_text(body: ChatIn) -> str:
    return next((m.content for m in reversed(body.messages) if m.role == "user"), "")


def _replayable(messages: list[ChatMessage]) -> list[ChatMessage]:
    """The history the model may see (ADR 016, roadmap EP1): every routed user
    turn — and the assistant turn(s) that answered it — is scrubbed before a
    model call, because a deterministic reply quotes x-sensitive record
    content and the stateless client replays it as ordinary assistant text.
    Routing is a pure function, so recomputing it here reconstructs exactly
    which past turns were answered kernel-side (a routed turn the model DID
    answer — no episode open at the time — is scrubbed too: conservative, and
    its reply held no episode content anyway). The final user message always
    survives: a routed message that composed nothing is the ordinary model
    path and must arrive."""
    kept: list[ChatMessage] = []
    scrubbing = False
    last = len(messages) - 1
    for index, message in enumerate(messages):
        if message.role == "user":
            scrubbing = index != last and episode_lines.route(message.content) is not None
        if not scrubbing:
            kept.append(message)
    return kept


def _model() -> str:
    return read_env("LIFEOS_CHAT_MODEL") or "claude-opus-5"


def _stream_params(convo: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "model": _model(),
        "max_tokens": MAX_TOKENS,
        "output_config": {"effort": read_env("LIFEOS_CHAT_EFFORT") or "low"},
        "system": tools.INSTRUCTIONS + CHAT_STYLE,
        "tools": tools.AGENT_TOOLS,
        "messages": convo,
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
    }


def _run(client: anthropic.Anthropic, ctx: AccessContext, body: ChatIn) -> Iterator[str]:
    convo: list[dict[str, Any]] = [m.model_dump() for m in _replayable(body.messages)]
    citations: dict[str, set[str]] = {"entity_ids": set(), "event_ids": set(), "methods": set()}
    started = time.monotonic()
    model_ms = tool_ms = turns = 0
    stop_reason = "end_turn"
    try:
        # Episode-shaped messages are answered kernel-side, deterministically,
        # before any model call (roadmap EP1, ADR 016): the playbook is quoted
        # verbatim and the evidence card is exact arithmetic, both cited in
        # the done frame — and the model never sees question or answer. The
        # reply is a pure function of recorded state, so a repeated same-day
        # wellbeing query streams the identical playbook again, never fresh
        # reassurance. A non-episode message returns None and flows on.
        reply = episode_lines.deterministic_reply(ctx, _last_user_text(body))
        if reply is not None:
            for line in reply["lines"]:
                yield _sse("text", {"delta": line + "\n"})
            provenance = reply["provenance"]
            total_ms = int((time.monotonic() - started) * 1000)
            log.info("chat: deterministic episodes reply total_ms=%d", total_ms)
            yield _sse(
                "done",
                {
                    "citations": {
                        "entity_ids": sorted(provenance["source_entity_ids"]),
                        "event_ids": sorted(provenance["source_event_ids"]),
                        "methods": [provenance["method"]],
                    },
                    "latency": {"model_ms": 0, "tool_ms": total_ms, "total_ms": total_ms},
                    "model": "deterministic",
                    "stop_reason": stop_reason,
                },
            )
            return
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
        else:
            # Every turn asked for another tool: the loop ran out of steps with
            # no answer written. Say so rather than closing on an empty bubble.
            stop_reason = "max_turns"
            yield _sse("text", {"delta": TURN_CAP_MSG})

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
                "model": _model(),
                "stop_reason": stop_reason,
            },
        )
    except Exception as exc:  # mid-stream: headers are gone, surface on the wire
        log.exception("chat failed: %s", exc)
        yield _sse("error", {"detail": ERROR_MSG})


@router.post("/chat")
def post_chat(
    body: ChatIn,
    owner: Annotated[AccessContext, Depends(authenticate)],
    client: Annotated[anthropic.Anthropic, Depends(get_model_client)],
) -> StreamingResponse:
    """Grounded chat: the owner authenticates, the loop runs read-only."""
    ctx = read_only_context(owner)
    return StreamingResponse(_run(client, ctx, body), media_type="text/event-stream")
