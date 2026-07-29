# A2 Grounded Chat Implementation Plan

> **For agentic workers:** executed inline (superpowers:executing-plans) in the
> authoring session per operator instruction. Checkboxes track progress.

**Goal:** POST /chat SSE agent loop over the shared read-tool surface with
citations + latency, and a lifeos-ui chat page — roadmap Slice 2 (A2, ADR-011).

**Architecture:** manual Anthropic tool loop inside the FastAPI app; MCP tool
functions factored into `src/mcp_server/tools.py` and reused by both doors;
scope-stripped read-only AccessContext; SSE frames text/tool/done/error.

**Tech stack:** Python 3.12, FastAPI, `anthropic` SDK (new dep), React 19 SPA.

## Global constraints

- Spec: `docs/superpowers/specs/2026-07-28-a2-grounded-chat-design.md` (approved).
- Model `claude-opus-5` via `LIFEOS_CHAT_MODEL`; effort `low` via
  `LIFEOS_CHAT_EFFORT`; `max_tokens` 16000; streaming always;
  `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`.
- Read-only by construction: ctx = `AccessContext.of(*(f"{d}:read"))` over
  active type domains. Max 5 model turns.
- Gates: lifeos `ruff` + `mypy` + `pytest`; lifeos-ui `lint && test && e2e && build`.
- Cells: interface for all lifeos code; rules declared only for ADR-011 file.

### Task 1: shared agent tools (`src/mcp_server/tools.py`)

Files: create `src/mcp_server/tools.py`; modify `src/mcp_server/server.py`.
Produces: `INSTRUCTIONS: str`; plain functions `list_types(ctx)`,
`find(ctx, type_name=None, filters=None, text=None)`, `get_entity(ctx, entity_id)`,
`history(ctx, entity_id)` each returning the existing `{..., "provenance"}` dict;
`AGENT_TOOLS: list[dict]` (Anthropic tool defs: name/description/input_schema,
`additionalProperties: false`); `run_tool(ctx, name, args) -> dict`.
`server.py` keeps `access_context()` + `main()` and registers the shared
functions with per-call ctx wrappers. Gate: `pytest tests/mcp` green (refactor
is behavior-neutral).

- [ ] tools.py extracted; server.py thin; tests/mcp green; commit.

### Task 2: chat endpoint (`src/api/chat.py`)

Files: create `src/api/chat.py`; modify `src/api/main.py` (router include),
`pyproject.toml` (+`anthropic`).
Produces: `ChatMessage {role: Literal["user","assistant"], content: str}`,
`ChatIn {messages: list[ChatMessage]}` (min length 1, content non-empty);
`read_only_context(conn) -> AccessContext`; `get_model_client()` FastAPI
dependency returning `anthropic.Anthropic()`; `POST /chat` returning
`StreamingResponse` of SSE frames per spec.

Loop core (load-bearing shape):

```python
def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"

async def _run(...)  # sync generator is fine under StreamingResponse
for turn in range(MAX_TURNS):
    with client.beta.messages.stream(
        model=MODEL, max_tokens=16000,
        output_config={"effort": EFFORT},
        system=tools.INSTRUCTIONS + CHAT_STYLE,
        tools=tools.AGENT_TOOLS,
        messages=convo,
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    ) as stream:
        for text in stream.text_stream:
            yield _sse("text", {"delta": text})
        final = stream.get_final_message()
    convo.append({"role": "assistant", "content": final.content})
    if final.stop_reason == "refusal":
        yield _sse("text", {"delta": ABSTAIN_MSG}); break
    tool_uses = [b for b in final.content if b.type == "tool_use"]
    if not tool_uses: break
    results = []
    for block in tool_uses:
        yield _sse("tool", {"name": block.name})
        payload = tools.run_tool(ctx, block.name, dict(block.input))
        _collect_citations(citations, payload["provenance"])
        results.append({"type": "tool_result", "tool_use_id": block.id,
                        "content": json.dumps(payload)})
    convo.append({"role": "user", "content": results})
yield _sse("done", {"citations": ..., "latency": ..., "model": MODEL,
                    "stop_reason": final.stop_reason})
```

`model_ms`/`tool_ms` via `time.monotonic()` around the stream block / tool
execution; one log line `chat: total_ms=... model_ms=... tool_ms=... turns=...`.
Mid-generator exceptions → `yield _sse("error", {"detail": ...})`. If the SDK
version rejects the `fallbacks` kwarg, pass `extra_body={"fallbacks": "default"}`.

- [ ] chat.py + wiring + dep; commit.

### Task 3: backend tests

Files: create `tests/api/test_chat_loop.py`, `tests/api/test_chat.py`.
Fake client shape (mirrors the SDK surface the loop touches):

```python
class FakeStream:
    def __init__(self, deltas, final): ...
    def __enter__(self): return self
    def __exit__(self, *a): return False
    @property
    def text_stream(self): yield from self._deltas
    def get_final_message(self): return self._final
class FakeClient:  # .beta.messages.stream(**kw) -> FakeStream from a script
```

Final messages built as SimpleNamespace with `.content` blocks
(`.type/.name/.id/.input/.text`) and `.stop_reason`. Wire via
`app.dependency_overrides[chat.get_model_client]`.
Cover: (1) tool turn then text turn → citations union + done frame fields;
(2) stripped ctx contains only `:read` scopes (assert `run_tool` refuses a
write-scope-needing path structurally — direct unit on `read_only_context`);
(3) abstention passthrough (scripted no-tool "no record supports" answer);
(4) turn cap: script 6 tool turns → loop stops at 5 with done;
(5) SSE wire test: frames parse, order text*→tool*→done, content-type.
Gate: full `ruff` + `mypy` + `pytest`.

- [ ] tests green; commit.

### Task 4: ADR-011 + roadmap line

Files: create `docs/adr/011-grounded-chat-sse-direct-llm.md` (declare
`{"cell": "rules"}` for this file, then restore interface); modify
`docs/roadmap.md` (A2 status line; unowned path).
ADR content per spec §ADR-011. Commit separately ("docs: ADR-011 ...").

- [ ] ADR + roadmap committed.

### Task 5: lifeos PR → green CI → merge (deploys)

`gh pr create` on `slice-2/a2-grounded-chat`; watch checks; squash-merge;
pull main. `ANTHROPIC_API_KEY` already in the prod `.env` render (ci.yml).

- [ ] merged on green.

### Task 6: lifeos-ui `streamChat` (`src/api/client.ts`)

Branch `slice-2/chat-page` off main. Produces in client.ts:

```ts
export type ChatCitations = { entity_ids: string[]; event_ids: string[]; methods: string[] };
export type ChatFrame =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "done"; citations: ChatCitations; latency: { total_ms: number }; model: string; stop_reason: string }
  | { type: "error"; detail: string };
export async function streamChat(
  messages: { role: "user" | "assistant"; content: string }[],
  onFrame: (frame: ChatFrame) => void,
): Promise<void>
```

fetch POST to `${VITE_API_URL}/chat` with auth header (reuse token lookup from
`api()`; 401 → same signOut path), read `response.body` via reader +
TextDecoder, buffer on `\n\n`, parse `event:`/`data:` lines, dispatch typed
frames. Run `npm run gen:api`, commit `types.gen.ts` (ChatIn appears).
Vitest: parser unit test over a mocked ReadableStream with split chunks.

- [ ] streamChat + types + tests; commit.

### Task 7: Chat page + route

Files: create `src/pages/Chat.tsx`, `src/pages/Chat.test.tsx`; modify
`src/App.tsx` (route `/chat` + nav link "Chat").
Page state: `turns: {role, content, citations?}[]`, `pending` string while
streaming, tool-activity line, error inline (`role="alert"`), citations as
entity-id `Link` chips + `· N events` suffix. Submit appends user turn, calls
`streamChat` with full history, builds assistant turn from frames.
Vitest: mocked `streamChat` invoking handlers — renders streamed text,
citations chips link to `/entities/:id`, error frame shows alert.

- [ ] page + tests; commit.

### Task 8: Playwright + gate + PR → merge (deploys)

`e2e/app.spec.ts`: add chat test — host-scoped `page.route` fulfilling
`${API}/chat` with an SSE body (text deltas + done with citations), assert
streamed text and citation chip visible. Full gate
`lint && test && e2e && build`. PR, green CI, squash-merge, pull main.

- [ ] merged on green.

### Task 9: acceptance + wrap

Score runnable golden questions (8 partial, 9, 13, 14) against the deployed
instance via the chat page or curl SSE; citations visible; unanswerables
abstain. Run `/diff-review` per operator instruction. A2.5 rider only if all
green and time remains: `scripts/define_daily_checkin.py` posting the
wellbeing `daily_checkin` type (date identity; 1-5 ints; top_priorities;
note) — capture form needs zero changes.

- [ ] acceptance recorded in roadmap; diff-review done.
