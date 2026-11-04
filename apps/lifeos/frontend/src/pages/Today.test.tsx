import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Today from "./Today";
import { getToday, setIntentionProgress, type TodayItem } from "../api/client";
import { renderWithProviders, setupUser } from "../test-utils";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, getToday: vi.fn(), setIntentionProgress: vi.fn() };
});

function item(overrides: Partial<TodayItem>): TodayItem {
  return {
    intention_id: "11111111-0000-0000-0000-000000000001",
    title: "Ship the slice",
    kind: "task",
    focus: false,
    progress: "READY",
    next_action: null,
    floor: null,
    updated_at: "2026-11-03T06:00:00Z",
    stale: false,
    ...overrides,
  };
}

describe("Today", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the priorities, the anchors apart, and the next two-minute action", async () => {
    vi.mocked(getToday).mockResolvedValue({
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [
        item({ title: "Call the dentist", focus: true, next_action: "open the contacts app" }),
        item({ intention_id: "2", title: "File the claim" }),
      ],
      more_one_offs: 4,
      anchors: [item({ intention_id: "3", title: "Morning walk", kind: "habit_quota" })],
      next_two_minute_action: "open the contacts app",
    });
    renderWithProviders(<Today />);

    const priorities = await screen.findByRole("region", { name: "Top priorities" });
    expect(within(priorities).getByText("Call the dentist")).toBeInTheDocument();
    expect(within(priorities).queryByText("Morning walk")).not.toBeInTheDocument();
    expect(screen.getByText(/4 more open/)).toBeInTheDocument();
    const anchors = screen.getByRole("region", { name: "Daily anchors" });
    expect(within(anchors).getByText("Morning walk")).toBeInTheDocument();
    const next = screen.getByRole("region", { name: "Next two-minute action" });
    expect(within(next).getByText("open the contacts app")).toBeInTheDocument();
  });

  it("records a progress change and shows the saved state after the refetch", async () => {
    const view = (progress: TodayItem["progress"]) => ({
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [item({ progress })],
      more_one_offs: 0,
      anchors: [],
      next_two_minute_action: null,
    });
    // The server's answer before and after the save: the page must show what it reads back.
    vi.mocked(getToday)
      .mockResolvedValueOnce(view("STARTED"))
      .mockResolvedValue(view("BLOCKED"));
    vi.mocked(setIntentionProgress).mockResolvedValue(item({ progress: "BLOCKED" }));
    const user = setupUser();
    renderWithProviders(<Today />);

    const group = await screen.findByRole("group", { name: "Progress for Ship the slice" });
    expect(within(group).getByRole("button", { name: "STARTED" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(group).getByRole("button", { name: "BLOCKED" }));
    expect(setIntentionProgress).toHaveBeenCalledWith(
      "11111111-0000-0000-0000-000000000001",
      "BLOCKED",
    );
    // UI oracle: after the refetch the saved state is the pressed one.
    await vi.waitFor(() =>
      expect(within(group).getByRole("button", { name: "BLOCKED" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(within(group).getByRole("button", { name: "STARTED" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("flags stale items instead of presenting them as current", async () => {
    vi.mocked(getToday).mockResolvedValue({
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [item({ stale: true })],
      more_one_offs: 0,
      anchors: [],
      next_two_minute_action: null,
    });
    renderWithProviders(<Today />);
    expect(await screen.findByText(/stale: not updated/)).toBeInTheDocument();
  });

  it("reports a failed save instead of hiding it", async () => {
    vi.mocked(getToday).mockResolvedValue({
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [item({})],
      more_one_offs: 0,
      anchors: [],
      next_two_minute_action: null,
    });
    vi.mocked(setIntentionProgress).mockRejectedValue(new Error("422 refused"));
    const user = setupUser();
    renderWithProviders(<Today />);
    const group = await screen.findByRole("group", { name: "Progress for Ship the slice" });
    await user.click(within(group).getByRole("button", { name: "DONE" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("422 refused");
  });
});
