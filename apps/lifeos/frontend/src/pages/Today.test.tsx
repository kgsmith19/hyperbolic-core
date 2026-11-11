import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Today from "./Today";
import {
  getToday,
  setIntentionProgress,
  type TodayItem,
  type TodayView,
} from "../api/client";
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
    area: null,
    focus: false,
    progress: "READY",
    next_action: null,
    floor: null,
    updated_at: "2026-11-03T06:00:00Z",
    stale: false,
    ...overrides,
  };
}

// The slice 2 context, empty by default: tests of the priorities stay about them.
const CONTEXT: Pick<
  TodayView,
  | "balance"
  | "schedule"
  | "upcoming"
  | "more_upcoming"
  | "sources"
  | "unavailable"
> = {
  balance: { god: 0, family: 0, work: 0, unassigned: 0 },
  schedule: [],
  upcoming: [],
  more_upcoming: 0,
  sources: [],
  unavailable: [],
};

describe("Today", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the priorities, the anchors apart, and the next two-minute action", async () => {
    vi.mocked(getToday).mockResolvedValue({
      ...CONTEXT,
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [
        item({
          title: "Call the dentist",
          focus: true,
          next_action: "open the contacts app",
        }),
        item({ intention_id: "2", title: "File the claim" }),
      ],
      more_one_offs: 4,
      anchors: [
        item({ intention_id: "3", title: "Morning walk", kind: "habit_quota" }),
      ],
      next_two_minute_action: "open the contacts app",
    });
    renderWithProviders(<Today />);

    const priorities = await screen.findByRole("region", {
      name: /Top priorities/,
    });
    expect(
      within(priorities).getByText("Call the dentist"),
    ).toBeInTheDocument();
    expect(
      within(priorities).queryByText("Morning walk"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/4 more open/)).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    const anchors = screen.getByRole("region", { name: "Daily anchors" });
    expect(within(anchors).getByText("Morning walk")).toBeInTheDocument();
    const next = screen.getByRole("region", { name: "Next two-minute action" });
    expect(within(next).getByText("open the contacts app")).toBeInTheDocument();
  });

  it("records a progress change and shows the saved state after the refetch", async () => {
    const view = (progress: TodayItem["progress"]) => ({
      ...CONTEXT,
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
    vi.mocked(setIntentionProgress).mockResolvedValue(
      item({ progress: "BLOCKED" }),
    );
    const user = setupUser();
    renderWithProviders(<Today />);

    const group = await screen.findByRole("group", {
      name: "Progress for Ship the slice",
    });
    expect(
      within(group).getByRole("button", { name: "STARTED" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(within(group).getByRole("button", { name: "BLOCKED" }));
    expect(setIntentionProgress).toHaveBeenCalledWith(
      "11111111-0000-0000-0000-000000000001",
      "BLOCKED",
    );
    // UI oracle: after the refetch the saved state is the pressed one.
    await vi.waitFor(() =>
      expect(
        within(group).getByRole("button", { name: "BLOCKED" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(
      within(group).getByRole("button", { name: "STARTED" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("flags stale items instead of presenting them as current", async () => {
    vi.mocked(getToday).mockResolvedValue({
      ...CONTEXT,
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
      ...CONTEXT,
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [item({})],
      more_one_offs: 0,
      anchors: [],
      next_two_minute_action: null,
    });
    vi.mocked(setIntentionProgress).mockRejectedValue(new Error("422 refused"));
    const user = setupUser();
    renderWithProviders(<Today />);
    const group = await screen.findByRole("group", {
      name: "Progress for Ship the slice",
    });
    await user.click(within(group).getByRole("button", { name: "DONE" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("422 refused");
  });

  it("shows the balance with a neglected area flagged, the schedule and what is coming", async () => {
    vi.mocked(getToday).mockResolvedValue({
      ...CONTEXT,
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [],
      more_one_offs: 0,
      anchors: [],
      next_two_minute_action: null,
      balance: { god: 0, family: 2, work: 3, unassigned: 1 },
      schedule: [
        {
          appointment_id: "a1",
          title: "Standup",
          starts_at: "2026-11-03T15:00:00Z",
          all_day: false,
        },
        {
          appointment_id: "a2",
          title: null,
          starts_at: "2026-11-03T18:00:00Z",
          all_day: false,
        },
      ],
      upcoming: [
        {
          appointment_id: "a3",
          title: "Dentist",
          starts_at: "2026-11-05T14:00:00Z",
          all_day: false,
        },
      ],
      more_upcoming: 2,
    });
    renderWithProviders(<Today />);

    const user = setupUser();
    await user.click(screen.getByText("Life balance"));
    await user.click(screen.getByText("Upcoming commitments"));
    const balance = await screen.findByRole("region", { name: "Balance" });
    expect(within(balance).getByText(/God: 0/)).toHaveTextContent(
      "(nothing open)",
    );
    expect(within(balance).getByText(/Work: 3/)).not.toHaveTextContent(
      "nothing open",
    );
    expect(within(balance).getByText("Unassigned: 1")).toBeInTheDocument();
    const schedule = screen.getByRole("region", { name: "Today's schedule" });
    expect(within(schedule).getByText("Standup")).toBeInTheDocument();
    expect(within(schedule).getByText("(title erased)")).toBeInTheDocument();
    const upcoming = screen.getByRole("region", { name: "Coming up" });
    expect(within(upcoming).getByText("Dentist")).toBeInTheDocument();
    expect(within(upcoming).getByText("2 more this week.")).toBeInTheDocument();
  });

  it("says when a source is stale or failed instead of looking current", async () => {
    vi.mocked(getToday).mockResolvedValue({
      ...CONTEXT,
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [],
      more_one_offs: 0,
      anchors: [],
      next_two_minute_action: null,
      sources: [
        {
          job: "domains.ops.briefing",
          last_receipt_at: "2026-11-03T05:00:00Z",
          last_status: "ok",
          missed: false,
        },
        {
          job: "domains.calendar.ingest",
          last_receipt_at: "2026-11-03T05:00:00Z",
          last_status: "failed",
          missed: false,
        },
        {
          job: "domains.calendar.autolink",
          last_receipt_at: null,
          last_status: null,
          missed: true,
        },
      ],
    });
    renderWithProviders(<Today />);
    const user = setupUser();
    await user.click(screen.getByText("Source health and sync details"));
    const sources = await screen.findByRole("region", { name: "Sources" });
    expect(within(sources).getByText("up to date")).toBeInTheDocument();
    expect(within(sources).getByText("last run failed")).toBeInTheDocument();
    expect(within(sources).getByText("never run")).toBeInTheDocument();
  });

  it("reports sections this session cannot read instead of showing them empty", async () => {
    vi.mocked(getToday).mockResolvedValue({
      ...CONTEXT,
      as_of: "2026-11-03T06:00:00Z",
      one_offs: [],
      more_one_offs: 0,
      anchors: [],
      next_two_minute_action: null,
      unavailable: ["calendar", "sources"],
    });
    renderWithProviders(<Today />);
    const schedule = await screen.findByRole("region", {
      name: "Today's schedule",
    });
    expect(
      within(schedule).getByText(/Calendar not available/),
    ).toBeInTheDocument();
    expect(
      within(schedule).queryByText(/Nothing on the calendar/),
    ).not.toBeInTheDocument();
    const user = setupUser();
    await user.click(screen.getByText("Source health and sync details"));
    expect(screen.getByText(/Source status not available/)).toBeInTheDocument();
  });
});
