import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Chat from "./Chat";
import { parseSseChunk, streamChat, type ChatFrame } from "../api/client";
import { renderWithProviders } from "../test-utils";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  streamChat: vi.fn(),
}));

function scriptFrames(frames: ChatFrame[]) {
  vi.mocked(streamChat).mockImplementation(async (_messages, onFrame) => {
    frames.forEach(onFrame);
  });
}

describe("Chat", () => {
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
    await userEvent.type(
      screen.getByPlaceholderText(/ask about your data/i),
      "workouts?",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
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
    await userEvent.type(
      screen.getByPlaceholderText(/ask about your data/i),
      "hi",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "model unavailable",
    );
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
