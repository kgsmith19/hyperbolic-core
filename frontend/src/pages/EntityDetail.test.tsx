import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import EntityDetail from "./EntityDetail";
import { forgetEntity, getHistory } from "../api/client";
import { renderWithProviders } from "../test-utils";

vi.mock("../api/client", () => ({
  getEntity: vi.fn().mockResolvedValue({
    entity: {
      id: "e1",
      name: "Kyle Smith",
      attributes: { full_name: "Kyle Smith", emails: ["k@example.com"] },
      created_at: "2026-07-26T00:00:00Z",
      updated_at: "2026-07-26T00:00:00Z",
    },
    types: ["person"],
    edges_out: [],
    edges_in: [],
  }),
  getHistory: vi.fn().mockResolvedValue([
    {
      id: "ev1",
      entity_id: "e1",
      event_type: "entity.created",
      payload: {},
      valid_time: "2026-07-26T00:00:00Z",
      recorded_at: "2026-07-26T00:00:00Z",
      actor: "kyle",
    },
  ]),
  forgetEntity: vi.fn().mockResolvedValue({
    entity_id: "e1",
    fields: ["full_name", "emails"],
    events_redacted: 2,
  }),
}));

function renderDetail() {
  renderWithProviders(
    <Routes>
      <Route path="/entities/:id" element={<EntityDetail />} />
    </Routes>,
    { route: "/entities/e1" },
  );
}

describe("EntityDetail", () => {
  it("shows attributes, types, and history", async () => {
    renderDetail();
    expect(
      await screen.findByRole("heading", { name: "Kyle Smith" }),
    ).toBeInTheDocument();
    expect(screen.getByText("person")).toBeInTheDocument();
    expect(await screen.findByText("entity.created")).toBeInTheDocument();
  });

  it("surfaces a history load failure instead of an empty section", async () => {
    vi.mocked(getHistory).mockRejectedValueOnce(new Error("boom"));
    renderDetail();
    await screen.findByRole("heading", { name: "Kyle Smith" });
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it("forgets PII only after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDetail();
    await screen.findByRole("heading", { name: "Kyle Smith" });
    await userEvent.click(screen.getByRole("button", { name: /forget/i }));
    expect(forgetEntity).toHaveBeenCalledWith("e1");
    expect(
      await screen.findByText(/erased full_name, emails across 2 event/i),
    ).toBeInTheDocument();
  });
});
