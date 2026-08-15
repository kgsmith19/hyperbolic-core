// Finding #70 (PR #8 security review): NavRail and CommandPalette
// (packages/ui) previously rendered every ZONE_ENTRIES item as a plain
// native `<a href>`, forcing a full document reload on every click,
// including for the five zones that are genuinely internal Shell routes.
// The fix threads an optional `navigate` adapter through Chrome's
// ChromeProps; internal-route clicks call it (and preventDefault) when
// supplied, and fall through to the native anchor exactly as before when
// not.
//
// This renders the REAL `Chrome` component straight from "@hyperbolic/ui"
// (built dist, the same artifact apps/shell ships) under jsdom + Testing
// Library -- packages/ui's own test suite is SSR-only and cannot execute
// click handlers or Base UI's portal-rendered CommandPalette content at all
// (see chrome.test.mjs's header comment); apps/shell already carries jsdom
// for exactly this kind of proof. This is the pure-DOM-event half of the
// evidence; e2e/chrome.spec.ts adds the full-browser "did a real reload
// happen" proof this finding calls out as the strongest evidence for that
// specific question.
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Chrome } from "@hyperbolic/ui";

function renderChrome(props: Partial<ComponentProps<typeof Chrome>> = {}) {
  return render(
    <Chrome activeZone="home" session={null} onSignOut={() => {}} {...props}>
      <div>zone content</div>
    </Chrome>
  );
}

function navRailItem(zone: string): HTMLElement {
  const el = document.querySelector(`[data-slot="nav-rail-item"][data-zone="${zone}"]`);
  if (!el) throw new Error(`nav-rail-item for zone "${zone}" not found`);
  return el as HTMLElement;
}

describe("Chrome nav rail: navigate adapter fallback behavior (Finding #70)", () => {
  it("without a navigate prop (today's default for every existing caller): clicking an internal zone does NOT preventDefault -- native anchor navigation is left to proceed, unchanged", () => {
    renderChrome();
    const notPrevented = fireEvent.click(navRailItem("tools"));
    // testing-library's fireEvent returns false when preventDefault() was
    // called on a cancelable event, true otherwise.
    expect(notPrevented).toBe(true);
  });

  it("with a navigate prop: clicking an internal zone calls navigate(href) and prevents the native navigation", () => {
    const navigate = vi.fn();
    renderChrome({ navigate });

    const notPrevented = fireEvent.click(navRailItem("tools"));

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/tools/");
    expect(notPrevented).toBe(false);
  });

  it("with a navigate prop: EVERY internal zone (home, acc, tools, prompts, ideas) routes through it", () => {
    const navigate = vi.fn();
    renderChrome({ navigate });

    for (const [zone, href] of [
      ["home", "/"],
      ["acc", "/acc/"],
      ["tools", "/tools/"],
      ["prompts", "/prompts/"],
      ["ideas", "/ideas/"],
    ] as const) {
      navigate.mockClear();
      fireEvent.click(navRailItem(zone));
      expect(navigate).toHaveBeenCalledWith(href);
    }
  });

  it("with a navigate prop supplied: clicking the LifeOS (life) zone does NOT call navigate -- always hard-navigates, per zones.ts's hardNavigate flag", () => {
    const navigate = vi.fn();
    renderChrome({ navigate });

    const notPrevented = fireEvent.click(navRailItem("life"));

    expect(navigate).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("without a navigate prop: clicking LifeOS also leaves the native anchor alone (same default fallback as every other entry)", () => {
    renderChrome();
    const notPrevented = fireEvent.click(navRailItem("life"));
    expect(notPrevented).toBe(true);
  });
});

describe("Chrome command palette: navigate adapter (Finding #70)", () => {
  async function openPalette() {
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    // The dialog's own initial-focus behavior moves focus into the input;
    // wait for the results list to actually exist in the DOM (Base UI's
    // Portal renders asynchronously-ish relative to the click under jsdom).
    await screen.findByRole("listbox");
  }

  it("with a navigate prop: clicking a navigation-kind result calls navigate(href) and prevents native navigation", async () => {
    const navigate = vi.fn();
    renderChrome({ navigate });
    await openPalette();

    const toolsResult = document.querySelector('[data-slot="command-palette-item"][data-zone="tools"]');
    expect(toolsResult).not.toBeNull();

    const notPrevented = fireEvent.click(toolsResult as HTMLElement);

    expect(navigate).toHaveBeenCalledWith("/tools/");
    expect(notPrevented).toBe(false);
  });

  it("with a navigate prop: clicking the life (LifeOS) result does NOT call navigate", async () => {
    const navigate = vi.fn();
    renderChrome({ navigate });
    await openPalette();

    const lifeResult = document.querySelector('[data-slot="command-palette-item"][data-zone="life"]');
    expect(lifeResult).not.toBeNull();

    fireEvent.click(lifeResult as HTMLElement);

    expect(navigate).not.toHaveBeenCalled();
  });

  it("without a navigate prop: clicking a navigation-kind result does not preventDefault (native anchor behavior, unchanged)", async () => {
    renderChrome();
    await openPalette();

    const toolsResult = document.querySelector('[data-slot="command-palette-item"][data-zone="tools"]');
    const notPrevented = fireEvent.click(toolsResult as HTMLElement);

    expect(notPrevented).toBe(true);
  });
});
