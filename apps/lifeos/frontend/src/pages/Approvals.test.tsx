import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Approvals from "./Approvals";
import {
  approveProposal,
  getApprovedDraft,
  listProposals,
  rejectProposal,
} from "../api/client";
import { renderWithProviders, setupUser } from "../test-utils";

vi.mock("../api/client", () => ({
  listProposals: vi.fn(),
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
  getApprovedDraft: vi.fn(),
}));

const PROPOSED = {
  proposal_id: "p1",
  kind: "dispute_draft",
  state: "proposed",
  subject_ids: ["bill1"],
  points: [],
  unresolved_count: 2,
  body: "Dear Acme Billing, I am disputing...",
  draft_digest: "abc123",
};

describe("Approvals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a proposed draft with its unresolved count and lets it be approved", async () => {
    vi.mocked(listProposals).mockResolvedValue([PROPOSED]);
    vi.mocked(approveProposal).mockResolvedValue({
      proposal_id: "p1",
      state: "approved",
      authority_receipt_id: "auth1",
      expires_at: "2026-08-15T00:00:00Z",
    });
    const user = setupUser();
    renderWithProviders(<Approvals />);

    expect(await screen.findByText(/dear acme billing/i)).toBeInTheDocument();
    expect(screen.getByText("2 unresolved")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "bill1" })).toHaveAttribute(
      "href",
      "/entities/bill1",
    );

    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(approveProposal).toHaveBeenCalledWith("p1", "abc123");
  });

  it("rejects without echoing a digest", async () => {
    vi.mocked(listProposals).mockResolvedValue([PROPOSED]);
    vi.mocked(rejectProposal).mockResolvedValue({
      proposal_id: "p1",
      state: "rejected",
    });
    const user = setupUser();
    renderWithProviders(<Approvals />);

    await screen.findByText(/dear acme billing/i);
    await user.click(screen.getByRole("button", { name: /reject/i }));
    expect(rejectProposal).toHaveBeenCalledWith("p1");
  });

  it("fetches the gated draft for an approved proposal instead of showing stale body", async () => {
    vi.mocked(listProposals).mockResolvedValue([
      {
        proposal_id: "p2",
        kind: "dispute_draft",
        state: "approved",
        subject_ids: [],
        points: [],
        unresolved_count: 0,
        authority_receipt_id: "auth1",
        body: null,
        draft_digest: null,
      },
    ]);
    vi.mocked(getApprovedDraft).mockResolvedValue({
      proposal_id: "p2",
      authority_receipt_id: "auth1",
      channel: "on_screen",
      permits: ["display_draft"],
      expires_at: "2026-08-15T00:00:00Z",
      body: "The receipt-verified letter.",
    });
    renderWithProviders(<Approvals />);

    expect(await screen.findByText("approved")).toBeInTheDocument();
    expect(
      await screen.findByText("The receipt-verified letter."),
    ).toBeInTheDocument();
    expect(getApprovedDraft).toHaveBeenCalledWith("p2");
    // Never buttons for a proposal that is already decided.
    expect(
      screen.queryByRole("button", { name: /approve/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a lapsed authority instead of hiding the refusal", async () => {
    vi.mocked(listProposals).mockResolvedValue([
      {
        proposal_id: "p3",
        kind: "dispute_draft",
        state: "approved",
        subject_ids: [],
        points: [],
        unresolved_count: 0,
        authority_receipt_id: "auth1",
        body: null,
        draft_digest: null,
      },
    ]);
    vi.mocked(getApprovedDraft).mockRejectedValue(
      new Error("authority receipt is expired or carries no usable expiry"),
    );
    renderWithProviders(<Approvals />);

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });

  it("shows an approved agent proposal without fetching a bills-only draft", async () => {
    // M4-20: a generic Brain proposal (domains/agents/proposals.py) is never
    // "dispute_draft"-kinded, and GET .../draft only ever renders a bills
    // dispute letter -- calling it for this kind would 404. The listing must
    // tell approved proposals apart by kind before reaching for that route.
    vi.mocked(listProposals).mockResolvedValue([
      {
        proposal_id: "p5",
        kind: "test.brain-kind",
        state: "approved",
        subject_ids: [],
        points: [],
        unresolved_count: 0,
        body: null,
        draft_digest: null,
      },
    ]);
    renderWithProviders(<Approvals />);

    expect(await screen.findByText("approved")).toBeInTheDocument();
    expect(getApprovedDraft).not.toHaveBeenCalled();
  });

  it("shows no letter and no actions for a rejected proposal", async () => {
    vi.mocked(listProposals).mockResolvedValue([
      {
        proposal_id: "p4",
        kind: "dispute_draft",
        state: "rejected",
        subject_ids: [],
        points: [],
        unresolved_count: 0,
        body: null,
        draft_digest: null,
      },
    ]);
    renderWithProviders(<Approvals />);

    expect(await screen.findByText("rejected")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve|reject/i }),
    ).not.toBeInTheDocument();
    expect(getApprovedDraft).not.toHaveBeenCalled();
  });

  it("says plainly when nothing is proposed", async () => {
    vi.mocked(listProposals).mockResolvedValue([]);
    renderWithProviders(<Approvals />);

    expect(await screen.findByText(/nothing proposed/i)).toBeInTheDocument();
  });

  it("puts proposals awaiting a decision ahead of already-decided ones", async () => {
    vi.mocked(listProposals).mockResolvedValue([
      {
        proposal_id: "old",
        kind: "dispute_draft",
        state: "rejected",
        subject_ids: [],
        points: [],
        unresolved_count: 0,
        body: null,
        draft_digest: null,
      },
      PROPOSED,
    ]);
    renderWithProviders(<Approvals />);

    await screen.findByText(/dear acme billing/i);
    const states = screen
      .getAllByText(/^(proposed|rejected)$/)
      .map((el) => el.textContent);
    expect(states).toEqual(["proposed", "rejected"]);
  });
});
