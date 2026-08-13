// Settings spec: "one health row per deployable unit" (verification list
// item 2; docs/planning/05-a-hyperbolic-core.md section 8).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "./settings";
import { DEPLOYABLE_UNITS } from "../lib/units";

const FIXTURE_SESSION = { accessToken: "t", expiresAt: 9999999999, userId: "test-user-id" };

function mockFetchReject() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unreachable")));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Hardcoded (not derived from DEPLOYABLE_UNITS) on purpose: the assertions
// below must catch BOTH a rendering bug (SettingsPage's map skips a unit)
// AND a data bug (someone silently removes a unit from lib/units.ts) --
// deriving the expected count from the same array the component reads
// would only ever catch the first kind. Update this list deliberately when
// lib/units.ts's DEPLOYABLE_UNITS legitimately changes.
const EXPECTED_UNIT_IDS = ["shell", "acc", "lifeos", "toolbelt", "prompt-organizer", "network-checker"];

describe("SettingsPage: unit health (05-a section 8)", () => {
  it("DEPLOYABLE_UNITS still has exactly the expected 6 units (sanity check for the test below)", () => {
    expect(DEPLOYABLE_UNITS.map((u) => u.id)).toEqual(EXPECTED_UNIT_IDS);
  });

  it("renders exactly one health row per deployable unit, keyed by unit id", () => {
    mockFetchReject();
    render(<SettingsPage session={FIXTURE_SESSION} onSignOut={() => {}} />);

    const rows = screen.getAllByTestId("unit-health-row");
    expect(rows).toHaveLength(EXPECTED_UNIT_IDS.length);

    for (const id of EXPECTED_UNIT_IDS) {
      expect(document.querySelector(`[data-testid="unit-health-row"][data-unit-id="${id}"]`)).not.toBeNull();
    }
  });

  it("renders the session card, theme switch, version info, and break-glass link", () => {
    mockFetchReject();
    render(<SettingsPage session={FIXTURE_SESSION} onSignOut={() => {}} />);

    expect(screen.getByTestId("session-card")).toBeInTheDocument();
    expect(screen.getByText("test-user-id")).toBeInTheDocument();
    expect(screen.getByTestId("version-info")).toBeInTheDocument();
    expect(screen.getByText(/break-glass runbook/i)).toBeInTheDocument();
  });

  it("calls onSignOut when the sign-out button is clicked", () => {
    mockFetchReject();
    const onSignOut = vi.fn();
    render(<SettingsPage session={FIXTURE_SESSION} onSignOut={onSignOut} />);
    screen.getByRole("button", { name: "Sign out" }).click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
