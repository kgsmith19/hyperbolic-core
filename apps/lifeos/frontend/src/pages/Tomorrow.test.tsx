import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Tomorrow from "./Tomorrow";
import {
  getEntity,
  getIntentionsPlan,
  markIntentionDone,
  searchEntities,
} from "../api/client";
import { renderWithProviders, setupUser } from "../test-utils";

vi.mock("../api/client", () => ({
  searchEntities: vi.fn(),
  getEntity: vi.fn(),
  getIntentionsPlan: vi.fn(),
  markIntentionDone: vi.fn(),
}));

const APPOINTMENT_LATE = "aaaaaaaa-0000-0000-0000-000000000001";
const APPOINTMENT_EARLY = "aaaaaaaa-0000-0000-0000-000000000002";
const INTENTION_FULL = "11111111-0000-0000-0000-000000000001";
const INTENTION_BARE = "11111111-0000-0000-0000-000000000002";
const REVIEW = "bbbbbbbb-0000-0000-0000-000000000001";
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
  [INTENTION_FULL]: {
    attributes: {
      title: "Strength training",
      kind: "habit_quota",
      status: "active",
      focus: true,
      floor: "one set of squats at home",
      next_action: "load the Monday plan",
    },
  },
  [INTENTION_BARE]: {
    attributes: {
      title: "Ship the slice",
      kind: "task",
      status: "active",
      focus: true,
    },
  },
};

/**
 * The briefing cites ids only (ADR 014); the page resolves them one by one.
 *
 * Search is mocked the way the server behaves — a `briefing_key` filter matches
 * exactly — so a page that guesses the key from the browser's clock gets the
 * empty result a real deployment would give it.
 */
function mockBriefing(attributes: object | object[] | null) {
  const briefings = (
    attributes === null
      ? []
      : Array.isArray(attributes)
        ? attributes
        : [attributes]
  ).map((set, index) => {
    const day = (set as { date?: string }).date ?? "2026-07-29";
    return {
      id: `ffffffff-0000-0000-0000-00000000000${index + 1}`,
      name: null,
      attributes: set as Record<string, unknown>,
      created_at: `${day}T06:00:00Z`,
      updated_at: `${day}T06:00:00Z`,
    };
  });
  vi.mocked(searchEntities).mockImplementation(({ filters }) => {
    const wanted = filters?.briefing_key;
    return Promise.resolve(
      wanted
        ? briefings.filter((b) => b.attributes.briefing_key === wanted)
        : briefings,
    );
  });
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
  focus_intention_ids: [INTENTION_FULL, INTENTION_BARE],
  appointment_ids: [APPOINTMENT_LATE, APPOINTMENT_EARLY],
};

describe("Tomorrow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every test in this file renders <Tomorrow/>, which always mounts
    // <TodaysPlan/> regardless of briefing state -- an empty plan is the
    // default so the pre-existing briefing-section tests below don't each
    // need to know about m5-08's own data source.
    vi.mocked(getIntentionsPlan).mockResolvedValue([]);
  });

  it("leads with the focus intentions, floor and next action shown", async () => {
    mockBriefing(FULL);
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText("Strength training")).toBeInTheDocument();
    expect(screen.getByText(/floor: one set of squats/i)).toBeInTheDocument();
    expect(screen.getByText(/next: load the monday plan/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /strength training/i }),
    ).toHaveAttribute("href", `/entities/${INTENTION_FULL}`);
    // composition order (ADR 019 rule 1): focus first, appointments second
    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings.indexOf("Focus goals")).toBeLessThan(
      headings.indexOf("Appointments"),
    );
  });

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

  it("renders the Monday gate counts and verdict", async () => {
    mockBriefing({ ...FULL, gate: { weeks: [5, 5, 4, 5], met: false } });
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText(/utility gate/i)).toBeInTheDocument();
    expect(
      screen.getByText(/open — check-in days per week: 5 · 5 · 4 · 5/i),
    ).toBeInTheDocument();
  });

  it("renders the episodes line the briefing composed", async () => {
    mockBriefing({ ...FULL, episodes_line: "Two headaches this past week." });
    renderWithProviders(<Tomorrow />);

    expect(
      await screen.findByText("Two headaches this past week."),
    ).toBeInTheDocument();
    // EP1 order: after the appointments, before the Monday gate.
    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings.indexOf("Appointments")).toBeLessThan(
      headings.indexOf("Episodes"),
    );
  });

  it("carries no episodes section when the briefing wrote no line", async () => {
    mockBriefing(FULL);
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText("Standup")).toBeInTheDocument();
    expect(screen.queryByText(/episodes/i)).not.toBeInTheDocument();
  });

  it("carries no gate section on a daily edition", async () => {
    mockBriefing(FULL);
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText("Standup")).toBeInTheDocument();
    expect(screen.queryByText(/utility gate/i)).not.toBeInTheDocument();
  });

  it("ignores keys an old-composition briefing left behind", async () => {
    mockBriefing({
      ...FULL,
      open_review_ids: [REVIEW],
      latest_checkin_id: CHECKIN,
    });
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText("Standup")).toBeInTheDocument();
    expect(screen.queryByText(/needs your decision/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/check-in/i)).not.toBeInTheDocument();
    expect(getEntity).not.toHaveBeenCalledWith(REVIEW);
    expect(getEntity).not.toHaveBeenCalledWith(CHECKIN);
  });

  // The backend keys briefings in LIFEOS_BRIEFING_TZ, so any date this browser
  // computes can miss a briefing that exists — and read as "nothing assembled".
  it("asks for briefings without a browser-computed date key", async () => {
    mockBriefing(FULL);
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText(/briefing for/i)).toBeInTheDocument();
    expect(searchEntities).toHaveBeenCalledWith({ type_name: "briefing" });
  });

  it("renders the newest briefing, labelled with its own date", async () => {
    const older = { ...FULL, briefing_key: "2020-01-02", date: "2020-01-02" };
    const newer = {
      ...FULL,
      briefing_key: "2020-01-03",
      date: "2020-01-03",
      appointment_ids: [APPOINTMENT_EARLY],
    };
    mockBriefing([newer, older]);
    renderWithProviders(<Tomorrow />);

    expect(
      await screen.findByText("Briefing for 2020-01-03"),
    ).toBeInTheDocument();
    expect(await screen.findByText("Standup")).toBeInTheDocument();
    expect(screen.queryByText("Dentist")).not.toBeInTheDocument();
  });

  it("says plainly when no briefing exists at all", async () => {
    mockBriefing(null);
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText(/no briefing yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/appointments/i)).not.toBeInTheDocument();
    expect(getEntity).not.toHaveBeenCalled();
  });

  it("says plainly when the briefing is empty", async () => {
    mockBriefing({
      briefing_key: "2026-07-29",
      date: "2026-07-29",
      focus_intention_ids: [],
      appointment_ids: [],
    });
    renderWithProviders(<Tomorrow />);

    expect(
      await screen.findByText("No appointments today."),
    ).toBeInTheDocument();
    expect(screen.getByText(/no focus goals yet/i)).toBeInTheDocument();
  });

  it("shows a still-resolving citation as loading, never as gone", async () => {
    mockBriefing(FULL);
    vi.mocked(getEntity).mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Tomorrow />);

    expect(await screen.findByText("Focus goals")).toBeInTheDocument();
    expect(screen.getAllByText("Loading…")).toHaveLength(4);
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();
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

  describe("Today's plan (m5-08)", () => {
    const INTENTION_ID = "22222222-0000-0000-0000-000000000001";

    it("renders the plan the backend already ordered, with focus and next-action shown", async () => {
      mockBriefing(null);
      vi.mocked(getIntentionsPlan).mockResolvedValue([
        {
          intention_id: INTENTION_ID,
          title: "Ship the slice",
          kind: "task",
          status: "active",
          focus: true,
          floor: null,
          next_action: "open the PR",
          done: false,
          created_at: "2026-07-29T06:00:00Z",
        },
      ]);
      renderWithProviders(<Tomorrow />);

      expect(await screen.findByText("Ship the slice")).toBeInTheDocument();
      expect(screen.getByText("focus")).toBeInTheDocument();
      expect(screen.getByText("open the PR")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /mark done/i }),
      ).toBeInTheDocument();
    });

    it("says plainly when there is nothing to plan", async () => {
      mockBriefing(null);
      renderWithProviders(<Tomorrow />);

      expect(
        await screen.findByText("No plannable intentions yet."),
      ).toBeInTheDocument();
    });

    it("marking an item done calls the API and refreshes the list", async () => {
      mockBriefing(null);
      vi.mocked(getIntentionsPlan).mockResolvedValue([
        {
          intention_id: INTENTION_ID,
          title: "Ship the slice",
          kind: "task",
          status: "active",
          focus: false,
          floor: null,
          next_action: null,
          done: false,
          created_at: "2026-07-29T06:00:00Z",
        },
      ]);
      vi.mocked(markIntentionDone).mockResolvedValue({
        intention_id: INTENTION_ID,
        title: "Ship the slice",
        kind: "task",
        status: "active",
        focus: false,
        floor: null,
        next_action: null,
        done: true,
        created_at: "2026-07-29T06:00:00Z",
      });
      const user = setupUser();
      renderWithProviders(<Tomorrow />);
      await screen.findByText("Ship the slice");

      await user.click(screen.getByRole("button", { name: /mark done/i }));

      expect(markIntentionDone).toHaveBeenCalledWith(INTENTION_ID);
      // A refetch after invalidation calls getIntentionsPlan a second time.
      expect(getIntentionsPlan).toHaveBeenCalledTimes(2);
    });

    it("a done item shows no mark-done button and reads as done", async () => {
      mockBriefing(null);
      vi.mocked(getIntentionsPlan).mockResolvedValue([
        {
          intention_id: INTENTION_ID,
          title: "Already finished",
          kind: "task",
          status: "active",
          focus: false,
          floor: null,
          next_action: null,
          done: true,
          created_at: "2026-07-29T06:00:00Z",
        },
      ]);
      renderWithProviders(<Tomorrow />);

      expect(await screen.findByText("Already finished")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /mark done/i }),
      ).not.toBeInTheDocument();
    });

    it("surfaces a plan fetch error instead of hiding it", async () => {
      mockBriefing(null);
      vi.mocked(getIntentionsPlan).mockRejectedValue(new Error("plan unreachable"));
      renderWithProviders(<Tomorrow />);

      expect(await screen.findByText(/plan unreachable/i)).toBeInTheDocument();
    });
  });
});
