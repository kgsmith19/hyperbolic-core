import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Chat from "./Chat";
import { parseSseChunk, streamChat, type ChatFrame } from "../api/client";
import { renderWithProviders, setupUser } from "../test-utils";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  streamChat: vi.fn(),
}));

/** Frames for the next send; call once per expected send, in order. */
function scriptFrames(frames: ChatFrame[]) {
  vi.mocked(streamChat).mockImplementationOnce(async (_messages, onFrame) => {
    frames.forEach(onFrame);
  });
}

const ANSWER: ChatFrame = {
  type: "done",
  citations: { entity_ids: [], event_ids: [], methods: [] },
  latency: { model_ms: 1, tool_ms: 1, total_ms: 2 },
  model: "claude-opus-5",
  stop_reason: "end_turn",
};

const box = () => screen.getByPlaceholderText(/ask about your data/i);

/** Ask a question, replacing whatever is in the box — a failed send leaves its
 *  own question there for the owner to resend or edit. */
async function send(question: string) {
  const user = setupUser();
  await user.clear(box());
  await user.type(box(), question);
  await user.click(screen.getByRole("button", { name: /send/i }));
}

describe("Chat", () => {
  beforeEach(() => vi.mocked(streamChat).mockReset());

  it("streams an answer and renders citation links", async () => {
    scriptFrames([
      { type: "tool", name: "find" },
      { type: "text", delta: "Two " },
      { type: "text", delta: "workouts." },
      {
        type: "done",
        citations: {
          entity_ids: ["e1e1e1e1-0000-0000-0000-000000000000"],
          event_ids: ["ev1", "ev2"],
          methods: ["kernel.find"],
        },
        latency: { model_ms: 1, tool_ms: 1, total_ms: 2 },
        model: "claude-opus-5",
        stop_reason: "end_turn",
      },
    ]);
    renderWithProviders(<Chat />);
    await send("workouts?");
    expect(await screen.findByText("Two workouts.")).toBeInTheDocument();
    const chip = screen.getByRole("link", { name: "e1e1e1e1" });
    expect(chip).toHaveAttribute(
      "href",
      "/entities/e1e1e1e1-0000-0000-0000-000000000000",
    );
    expect(screen.getByText(/2 events/)).toBeInTheDocument();
  });

  it("surfaces an error frame as an alert", async () => {
    scriptFrames([{ type: "error", detail: "model unavailable" }]);
    renderWithProviders(<Chat />);
    await send("hi");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "model unavailable",
    );
  });

  // An errored send used to leave an empty assistant turn in the history; the
  // next request carried it and /chat rejected the lot with 422 (content has
  // min_length 1), bricking the page until reload.
  it("keeps sending after a failed turn instead of bricking the page", async () => {
    scriptFrames([{ type: "error", detail: "model unavailable" }]);
    scriptFrames([{ type: "text", delta: "All good." }, ANSWER]);
    renderWithProviders(<Chat />);

    await send("hi");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await send("again");

    expect(await screen.findByText("All good.")).toBeInTheDocument();
    expect(vi.mocked(streamChat).mock.calls[1][0]).toEqual([
      { role: "user", content: "again" },
    ]);
  });

  // A transient failure must not destroy what was typed: there is no undo.
  it("hands the question back to the input when the send fails", async () => {
    scriptFrames([{ type: "error", detail: "model unavailable" }]);
    renderWithProviders(<Chat />);

    await send("how many workouts?");

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(box()).toHaveValue("how many workouts?");
    expect(screen.queryByText("how many workouts?")).not.toBeInTheDocument();
  });
});

describe("parseSseChunk", () => {
  it("emits complete frames and returns the partial tail", () => {
    const seen: ChatFrame[] = [];
    const rest = parseSseChunk(
      'event: text\ndata: {"delta": "Hi"}\n\nevent: done\ndata: {"cit',
      (frame) => seen.push(frame),
    );
    expect(seen).toEqual([{ type: "text", delta: "Hi" }]);
    expect(rest).toBe('event: done\ndata: {"cit');
  });
});
