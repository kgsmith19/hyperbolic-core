"""Unit: the chat loop against a scripted fake model client (no network)."""

from types import SimpleNamespace
from typing import Any

from api import chat
from api.chat import ChatIn, ChatMessage, read_only_context
from kernel.access import AccessContext, has


class FakeStream:
    def __init__(self, deltas: list[str], final: Any) -> None:
        self._deltas = deltas
        self._final = final

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *args: object) -> bool:
        return False

    @property
    def text_stream(self) -> Any:
        yield from self._deltas

    def get_final_message(self) -> Any:
        return self._final


class FakeClient:
    """Mirrors the client.beta.messages.stream(**kw) surface the loop uses."""

    def __init__(self, turns: list[FakeStream]) -> None:
        self.calls: list[dict[str, Any]] = []
        self._turns = iter(turns)
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs: Any) -> FakeStream:
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return next(self._turns)


def _final(blocks: list[Any], stop_reason: str = "end_turn") -> Any:
    return SimpleNamespace(content=blocks, stop_reason=stop_reason)


def _text(text: str) -> Any:
    return SimpleNamespace(type="text", text=text)


def _tool_use(name: str, args: dict[str, Any], block_id: str = "tu_1") -> Any:
    return SimpleNamespace(type="tool_use", name=name, input=args, id=block_id)


def _frames(client: FakeClient, message: str = "hi") -> list[str]:
    ctx = AccessContext.of("relationships:read", "health:read")
    body = ChatIn(messages=[ChatMessage(role="user", content=message)])
    return list(chat._run(client, ctx, body))  # noqa: SLF001 - unit under test


def _events(frames: list[str]) -> list[str]:
    return [f.split("\n")[0].removeprefix("event: ") for f in frames]


def test_tool_turn_accumulates_citations_into_done(seeded: dict[str, Any]) -> None:
    kyle = str(seeded["person"])
    client = FakeClient(
        [
            FakeStream([], _final([_tool_use("get_entity", {"entity_id": kyle})], "tool_use")),
            FakeStream(["Kyle ", "Smith."], _final([_text("Kyle Smith.")])),
        ]
    )
    frames = _frames(client, "who am I?")
    assert _events(frames) == ["tool", "text", "text", "done"]
    done = frames[-1]
    assert f'"{kyle}"' in done
    assert "kernel.get_entity" in done
    assert '"total_ms"' in done and '"model_ms"' in done and '"tool_ms"' in done


def test_no_tool_answer_ends_after_one_turn(seeded: object) -> None:
    client = FakeClient([FakeStream(["No record supports that."], _final([_text("...")]))])
    frames = _frames(client)
    assert _events(frames) == ["text", "done"]
    assert len(client.calls) == 1


def test_turn_cap_stops_a_tool_loop(seeded: object) -> None:
    tool_turn = lambda: FakeStream(  # noqa: E731
        [], _final([_tool_use("list_types", {})], "tool_use")
    )
    client = FakeClient([tool_turn() for _ in range(6)])
    frames = _frames(client)
    assert len(client.calls) == chat.MAX_TURNS
    assert _events(frames)[-1] == "done"


def test_refusal_renders_abstention(seeded: object) -> None:
    client = FakeClient([FakeStream([], _final([], "refusal"))])
    frames = _frames(client)
    assert chat.ABSTAIN_MSG in "".join(frames)
    assert _events(frames)[-1] == "done"


def test_tool_error_returns_to_model_not_wire(seeded: object) -> None:
    client = FakeClient(
        [
            FakeStream(
                [], _final([_tool_use("get_entity", {"entity_id": "not-a-uuid"})], "tool_use")
            ),
            FakeStream(["Sorry."], _final([_text("Sorry.")])),
        ]
    )
    frames = _frames(client)
    assert "error" not in _events(frames)
    follow_up = client.calls[1]["messages"][-1]
    assert follow_up["content"][0]["is_error"] is True


def test_read_only_context_carries_only_read_scopes(seeded: object) -> None:
    ctx = read_only_context()
    assert has(ctx, "relationships:read") and has(ctx, "health:read")
    assert not has(ctx, "relationships:write") and not has(ctx, "health:write")
