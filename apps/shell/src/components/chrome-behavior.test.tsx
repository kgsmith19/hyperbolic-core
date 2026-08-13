import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chrome } from "@hyperbolic/ui";

const SESSION = {
  accessToken: "fixture-token",
  expiresAt: 9_999_999_999,
  userId: "00000000-0000-4000-8000-000000000001",
};

describe("Chrome navigation adapter", () => {
  it("routes an ordinary left-click through the consumer adapter", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(
      <Chrome activeZone="home" session={SESSION} onSignOut={() => {}} navigate={navigate}>
        content
      </Chrome>
    );

    await user.click(screen.getByRole("link", { name: "Tools" }));
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/tools/");
  });
});

describe("Command palette accessibility and reset", () => {
  it("exposes a complete combobox/listbox relationship", async () => {
    const user = userEvent.setup();
    render(
      <Chrome activeZone="home" session={SESSION} onSignOut={() => {}}>
        content
      </Chrome>
    );

    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    const input = await screen.findByRole("combobox", { name: "Search navigation" });
    expect(input).toHaveAttribute("aria-controls", "command-palette-list");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "Navigation and tool results" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Home/ })).toHaveAttribute("aria-selected", "true");
  });

  it("clears the query and resets selection every time it reopens", async () => {
    const user = userEvent.setup();
    render(
      <Chrome activeZone="home" session={SESSION} onSignOut={() => {}}>
        content
      </Chrome>
    );

    const trigger = screen.getByRole("button", { name: "Open command palette" });
    await user.click(trigger);
    const input = await screen.findByRole("combobox", { name: "Search navigation" });
    await user.type(input, "ideas");
    expect(input).toHaveValue("ideas");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());

    await user.click(trigger);
    const reopened = await screen.findByRole("combobox", { name: "Search navigation" });
    expect(reopened).toHaveValue("");
    expect(screen.getByRole("option", { name: /Home/ })).toHaveAttribute("aria-selected", "true");
  });
});
