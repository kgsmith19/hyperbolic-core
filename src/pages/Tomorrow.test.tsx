import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Tomorrow from "./Tomorrow";
import { getEntity, searchEntities } from "../api/client";
import { renderWithProviders } from "../test-utils";

vi.mock("../api/client", () => ({
  searchEntities: vi.fn(),
  getEntity: vi.fn(),
}));

const APPOINTMENT_LATE = "aaaaaaaa-0000-0000-0000-000000000001";
const APPOINTMENT_EARLY = "aaaaaaaa-0000-0000-0000-000000000002";
const REVIEW = "bbbbbbbb-0000-0000-0000-000000000001";
const ATTENDEE = "cccccccc-0000-0000-0000-000000000001";
const PERSON = "dddddddd-0000-0000-0000-000000000001";
const CHECKIN = "eeeeeeee-0000-0000-0000-000000000001";

const ENTITIES: Record<string, { name?: string; attributes: object }> = {
  [APPOINTMENT_LATE]: {
    name: "Dentist",
    attributes: { title: "Dentist", starts_at: "2026-07-29T15:00:00Z" },
  },
  [APPOINTMENT_EARLY]: {
    name: "Standup",
    attributes: {
      title: "Standup",
      starts_at: "2026-07-29T08:00:00Z",
      location: "Zoom",
    },
  },
  [REVIEW]: {
    attributes: {
      review_key: "r1",
      attendee_id: ATTENDEE,
      candidate_person_ids: [PERSON],
      reason: "ambiguous_email_match",
    },
  },
  [CHECKIN]: {
    attributes: {
      date: "2026-07-29",
      mood: 4,
      energy: 3,
      stress: 2,
      sleep_quality: 5,
      top_priorities: ["ship B4"],
    },
  },
};

/** The briefing cites ids only (ADR 014); the page resolves them one by one. */
function mockBriefing(attributes: object | null) {
  vi.mocked(searchEntities).mockResolvedValue(
    attributes === null
      ? []
      : [
          {
            id: "ffffffff-0000-0000-0000-000000000001",
            name: null,
            attributes: attributes as Record<string, unknown>,
            created_at: "2026-07-29T06:00:00Z",
            updated_at: "2026-07-29T06:00:00Z",
          },
        ],
  );
  vi.mocked(getEntity).mockImplementation((id: string) => {
    const found = ENTITIES[id];
    if (!found) return Promise.reject(new Error("not found"));
    return Promise.resolve({
      entity: {
        id,
        name: found.name ?? null,
        attributes: found.attributes as Record<string, unknown>,
        created_at: "2026-07-29T06:00:00Z",
        updated_at: "2026-07-29T06:00:00Z",
      },
      types: ["thing"],
      edges_out: [],
      edges_in: [],
    });
  });
}

const FULL = {
  briefing_key: "2026-07-29",
  date: "2026-07-29",
  appointment_ids: [APPOINTMENT_LATE, APPOINTMENT_EARLY],
  open_review_ids: [REVIEW],
  latest_checkin_id: CHECKIN,
};

describe("Tomorrow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves cited ids and orders appointments chronologically", async () => {
    mockBriefing(FULL);
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText("Standup")).toBeInTheDocument();
    const titles = screen
      .getAllByRole("link")
      .map((link) => link.textContent ?? "")
      .filter((text) => text.includes("Standup") || text.includes("Dentist"));
    expect(titles[0]).toContain("Standup");
    expect(titles[1]).toContain("Dentist");
    expect(screen.getByText("Zoom")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dentist/i })).toHaveAttribute(
      "href",
      `/entities/${APPOINTMENT_LATE}`,
    );
  });

  it("renders an open link_review as needing a decision, with entity links", async () => {
    mockBriefing(FULL);
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText(/needs your decision/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/more than one person matches/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: ATTENDEE.slice(0, 8) }),
    ).toHaveAttribute("href", `/entities/${ATTENDEE}`);
    expect(
      screen.getByRole("link", { name: PERSON.slice(0, 8) }),
    ).toHaveAttribute("href", `/entities/${PERSON}`);
    expect(screen.getByRole("link", { name: "review item" })).toHaveAttribute(
      "href",
      `/entities/${REVIEW}`,
    );
  });

  it("shows the latest check-in when the briefing cites one", async () => {
    mockBriefing(FULL);
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText("2026-07-29")).toBeInTheDocument();
    expect(screen.getByText(/mood 4\/5/)).toBeInTheDocument();
    expect(screen.getByText(/ship B4/)).toBeInTheDocument();
  });

  it("says plainly when no briefing exists for today", async () => {
    mockBriefing(null);
    renderWithProviders(<Tomorrow />);

    expect(
      await screen.findByText(/no briefing for today yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/appointments/i)).not.toBeInTheDocument();
    expect(getEntity).not.toHaveBeenCalled();
  });

  it("says plainly when the briefing is empty", async () => {
    mockBriefing({
      briefing_key: "2026-07-29",
      date: "2026-07-29",
      appointment_ids: [],
      open_review_ids: [],
    });
    renderWithProviders(<Tomorrow />);

    expect(
      await screen.findByText("No appointments today."),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing is waiting on you.")).toBeInTheDocument();
    expect(screen.getByText("No check-in recorded yet.")).toBeInTheDocument();
  });

  it("reports a cited id that no longer resolves instead of guessing", async () => {
    mockBriefing({
      ...FULL,
      appointment_ids: ["99999999-0000-0000-0000-000000000001"],
    });
    renderWithProviders(<Tomorrow />);

    expect(
      await screen.findByText(
        /appointment \(99999999\) is no longer available/i,
      ),
    ).toBeInTheDocument();
  });
});
