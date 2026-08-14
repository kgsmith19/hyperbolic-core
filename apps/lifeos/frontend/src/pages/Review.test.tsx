import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Review from "./Review";
import { getReviewFeed, type ReviewFeed } from "../api/client";
import { renderWithProviders, setupUser } from "../test-utils";

vi.mock("../api/client", () => ({
  getReviewFeed: vi.fn(),
}));

const BRIEFING_ID = "ffffffff-0000-0000-0000-000000000001";
const RECEIPT_ID = "eeeeeeee-0000-0000-0000-000000000001";

const EMPTY_FEED: ReviewFeed = {
  start: "2026-07-01",
  end: "2026-07-07",
  briefings: [],
  receipts: [],
  job_health: [],
};

describe("Review", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders briefings, receipts, and job health for the default range", async () => {
    vi.mocked(getReviewFeed).mockResolvedValue({
      ...EMPTY_FEED,
      briefings: [
        {
          briefing_id: BRIEFING_ID,
          date: "2026-07-05",
          focus_intention_ids: ["a", "b"],
          appointment_ids: ["c"],
        },
      ],
      receipts: [
        {
          receipt_id: RECEIPT_ID,
          job: "domains.ops.briefing",
          started_at: "2026-07-05T06:00:00Z",
          finished_at: "2026-07-05T06:00:01Z",
          status: "ok",
          summary: "briefing 2026-07-05: focus=2 appointments=1",
        },
      ],
      job_health: [
        {
          job: "domains.ops.briefing",
          last_receipt_at: "2026-07-05T06:00:00Z",
          last_status: "ok",
          missed: false,
        },
      ],
    });
    renderWithProviders(<Review />);

    expect(await screen.findByText("2026-07-05")).toBeInTheDocument();
    expect(screen.getByText("2 focus, 1 appointment")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2026-07-05" })).toHaveAttribute(
      "href",
      `/entities/${BRIEFING_ID}`,
    );
    expect(screen.getAllByText("domains.ops.briefing").length).toBeGreaterThan(0);
    expect(screen.getByText("last run ok")).toBeInTheDocument();
  });

  it("flags a job with no receipt today as missed, distinctly from a failed run", async () => {
    vi.mocked(getReviewFeed).mockResolvedValue({
      ...EMPTY_FEED,
      job_health: [
        { job: "domains.ops.briefing", last_receipt_at: null, last_status: null, missed: true },
        {
          job: "domains.calendar.ingest",
          last_receipt_at: "2026-07-05T06:00:00Z",
          last_status: "failed",
          missed: false,
        },
      ],
    });
    renderWithProviders(<Review />);

    expect(await screen.findByText("missed today")).toBeInTheDocument();
    expect(screen.getByText("last run failed")).toBeInTheDocument();
  });

  it("says plainly when nothing is in range", async () => {
    vi.mocked(getReviewFeed).mockResolvedValue(EMPTY_FEED);
    renderWithProviders(<Review />);

    expect(
      await screen.findByText("No briefings in this range."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No scheduled-job receipts in this range."),
    ).toBeInTheDocument();
  });

  it("requests a default range spanning the last 7 days, start before end", async () => {
    vi.mocked(getReviewFeed).mockResolvedValue(EMPTY_FEED);
    renderWithProviders(<Review />);

    await screen.findByText(/no briefings/i);
    expect(getReviewFeed).toHaveBeenCalledTimes(1);
    const [start, end] = vi.mocked(getReviewFeed).mock.calls[0]!;
    expect(start < end).toBe(true);
    const days = (Date.parse(end) - Date.parse(start)) / (1000 * 60 * 60 * 24);
    expect(days).toBe(6);
  });

  it("re-queries with the operator's chosen range on submit", async () => {
    vi.mocked(getReviewFeed).mockResolvedValue(EMPTY_FEED);
    const user = setupUser();
    renderWithProviders(<Review />);
    await screen.findByText(/no briefings/i);

    const start = screen.getByLabelText("Start");
    const end = screen.getByLabelText("End");

    await user.clear(start);
    await user.type(start, "2026-01-01");
    await user.clear(end);
    await user.type(end, "2026-01-10");
    await user.click(screen.getByRole("button", { name: /apply/i }));

    expect(getReviewFeed).toHaveBeenLastCalledWith("2026-01-01", "2026-01-10");
  });

  it("surfaces a fetch error instead of hiding it", async () => {
    vi.mocked(getReviewFeed).mockRejectedValue(new Error("end must not be before start"));
    renderWithProviders(<Review />);

    expect(
      await screen.findByText(/end must not be before start/i),
    ).toBeInTheDocument();
  });
});
