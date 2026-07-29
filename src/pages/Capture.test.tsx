import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Capture from "./Capture";
import { captureEntity } from "../api/client";
import { renderWithProviders, setupUser } from "../test-utils";

vi.mock("../api/client", () => ({
  listTypes: vi.fn().mockResolvedValue([
    {
      name: "note",
      domain: "journal",
      json_schema: {
        type: "object",
        properties: {
          text: { type: "string" },
          tags: { type: "array" },
          duration: { type: "number" },
        },
        required: ["text"],
      },
    },
  ]),
  captureEntity: vi
    .fn()
    .mockResolvedValue({ entity_id: "e-new", resolution: "new" }),
}));

describe("Capture", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders schema-driven fields and submits parsed attributes", async () => {
    const user = setupUser();
    renderWithProviders(
      <Routes>
        <Route path="/capture" element={<Capture />} />
        <Route path="/entities/:id" element={<p>entity page</p>} />
      </Routes>,
      { route: "/capture" },
    );
    const typeSelect = screen.getByRole("combobox");
    await screen.findByRole("option", { name: /note/ });
    await user.selectOptions(typeSelect, "note");
    await user.type(screen.getByLabelText(/text/i), "ship the UI");
    await user.type(screen.getByLabelText(/tags/i), '[["dev"]');
    await user.click(screen.getByRole("button", { name: /capture/i }));

    expect(vi.mocked(captureEntity).mock.calls[0][0]).toEqual({
      type_name: "note",
      attributes: { text: "ship the UI", tags: ["dev"] },
    });
    expect(await screen.findByText("entity page")).toBeInTheDocument();
  });

  it("rejects non-numeric input in number fields without calling the API", async () => {
    const user = setupUser();
    renderWithProviders(
      <Routes>
        <Route path="/capture" element={<Capture />} />
      </Routes>,
      { route: "/capture" },
    );
    const typeSelect = screen.getByRole("combobox");
    await screen.findByRole("option", { name: /note/ });
    await user.selectOptions(typeSelect, "note");
    await user.type(screen.getByLabelText(/text/i), "x");
    await user.type(screen.getByLabelText(/duration/i), "abc");
    await user.click(screen.getByRole("button", { name: /capture/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /duration must be a number/i,
    );
    expect(vi.mocked(captureEntity)).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON in non-scalar fields without calling the API", async () => {
    const user = setupUser();
    renderWithProviders(
      <Routes>
        <Route path="/capture" element={<Capture />} />
      </Routes>,
      { route: "/capture" },
    );
    const typeSelect = screen.getByRole("combobox");
    await screen.findByRole("option", { name: /note/ });
    await user.selectOptions(typeSelect, "note");
    await user.type(screen.getByLabelText(/text/i), "x");
    await user.type(screen.getByLabelText(/tags/i), "not-json");
    await user.click(screen.getByRole("button", { name: /capture/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid json/i);
    expect(vi.mocked(captureEntity)).not.toHaveBeenCalled();
  });
});
