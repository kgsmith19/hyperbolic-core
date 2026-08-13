// Finding #73 (PR #8 security review): useThemeChoice (packages/ui) was
// plain per-component React.useState with no cross-instance channel -- two
// independently mounted consumers could show stale/disagreeing DISPLAYED
// selections until one of them remounted, even though the applied theme
// (document.documentElement's data-theme attribute) stayed correct
// everywhere instantly. packages/ui's own test suite (chrome-theme-store.test.mjs)
// proves the underlying shared-store mechanism directly; this file is the
// real, DOM-backed behavioral proof that two ACTUAL rendered React
// components -- the topbar's ThemeSwitch (packages/ui) and this app's own
// ThemeChoiceControl (which wraps the exact same useThemeChoice hook,
// see theme-choice-control.tsx's own header comment) -- now observe the
// same value after either one changes it, with neither remounting.
// packages/ui has no jsdom in its own test suite (its tests are SSR-only,
// see chrome.test.mjs's header comment); apps/shell already has jsdom +
// Testing Library wired for its vitest config, which is exactly what this
// kind of live-DOM, cross-component proof needs.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ThemeSwitch } from "@hyperbolic/ui";
import { ThemeChoiceControl } from "./theme-choice-control";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("Theme choice: cross-instance sync (Finding #73 regression net)", () => {
  it("clicking the topbar ThemeSwitch updates Settings' own ThemeChoiceControl selection, without remounting either", () => {
    render(
      <div>
        <ThemeSwitch />
        <ThemeChoiceControl />
      </div>
    );

    const switchButton = screen.getByRole("button", { name: /switch theme/i });
    const control = screen.getByTestId("theme-choice-control");

    // Both start at the same default ("system": no stored choice yet).
    expect(switchButton).toHaveAttribute("data-theme-choice", "system");
    expect(within(control).getByRole("radio", { name: "System" })).toBeChecked();

    // ThemeSwitch cycles system -> light -> dark -> system (theme.ts's own
    // CYCLE order) -- one click lands on "light".
    fireEvent.click(switchButton);

    expect(switchButton).toHaveAttribute("data-theme-choice", "light");
    // The regression this finding is about: WITHOUT the shared store,
    // ThemeChoiceControl's own independent useState never observes a
    // change made through a DIFFERENT useThemeChoice() instance, so its
    // radio group would still show "System" selected here.
    expect(within(control).getByRole("radio", { name: "Light" })).toBeChecked();
    expect(within(control).getByRole("radio", { name: "System" })).not.toBeChecked();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("the reverse direction also syncs: selecting Dark in Settings' control updates the topbar ThemeSwitch", () => {
    render(
      <div>
        <ThemeSwitch />
        <ThemeChoiceControl />
      </div>
    );

    const switchButton = screen.getByRole("button", { name: /switch theme/i });
    const control = screen.getByTestId("theme-choice-control");

    fireEvent.click(within(control).getByRole("radio", { name: "Dark" }));

    expect(within(control).getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(switchButton).toHaveAttribute("data-theme-choice", "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
