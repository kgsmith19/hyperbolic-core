import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Browse from "./Browse";
import { renderWithProviders } from "../test-utils";

vi.mock("../api/client", () => ({
  listTypes: vi.fn().mockResolvedValue([
    { name: "note", domain: "journal" },
    { name: "workout", domain: "health" },
  ]),
  searchEntities: vi.fn().mockResolvedValue([
    {
      id: "4f6f1a5e-0000-0000-0000-000000000001",
      name: "Morning run",
      attributes: { kind: "run" },
      created_at: "2026-07-26T07:30:00Z",
      updated_at: "2026-07-26T07:30:00Z",
    },
  ]),
}));

describe("Browse", () => {
  it("renders search results and the type filter", async () => {
    renderWithProviders(<Browse />);
    expect(await screen.findByText("Morning run")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "note" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "workout" })).toBeInTheDocument();
    const card = screen.getByRole("link", { name: /morning run/i });
    expect(card).toHaveAttribute(
      "href",
      "/entities/4f6f1a5e-0000-0000-0000-000000000001",
    );
  });
});
