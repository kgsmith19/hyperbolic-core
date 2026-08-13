// Home page launcher-card navigation mechanism (P1 fix: the LifeOS card
// must perform a REAL hard navigation, not a client-side router transition).
//
// LifeOS is not a Shell route at all -- it's a separate zone stitched in by
// `tailscale serve`'s path-based reverse proxy (docs/ops/tailscale-serve-apply.sh),
// entirely outside app.tsx's <Routes>. A plain react-router <Link> never
// leaves Shell's SPA: react-router's useLinkClickHandler calls
// event.preventDefault() and does a history.pushState() instead of letting
// the browser's normal anchor click go through, so the click never becomes
// an HTTP request and the reverse proxy never gets a chance to serve the
// LifeOS bundle -- Shell's own catch-all NotFoundPage renders instead.
//
// A test that only checks `href="/life/"` would pass on both the buggy
// (plain <Link>) and fixed code, because react-router's <Link> always
// renders a real <a href> under the hood regardless of `reloadDocument` --
// the DOM tag and href are identical either way. The actual difference is
// BEHAVIORAL: whether a click's default action gets prevented. This is
// exactly what react-router's SPA click handler does (see
// node_modules/react-router/dist/development/lib/dom/lib.js's
// useLinkClickHandler, which calls `event.preventDefault()` before pushing
// state) -- and exactly what `reloadDocument` (or a plain <a>) skips, by
// design, so the browser's native, un-intercepted navigation runs instead.
// Firing a real click event and reading `event.defaultPrevented` afterward
// is therefore a mechanism-level assertion, not a markup-level one: it
// fails against the buggy router-Link code and passes only once the click
// is genuinely left for the browser to handle.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import HomePage from "./home";

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <HomePage />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HomePage launcher cards: navigation mechanism", () => {
  it("the LifeOS card's click is NOT intercepted by the router (event.preventDefault is never called)", () => {
    // HealthSummary/AccStatusCard both fetch on mount; reject so they
    // settle into their quiet "unreachable" degrade instead of hanging or
    // logging noise unrelated to what this test checks.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unreachable")));
    renderHome();

    const lifeCard = screen.getAllByTestId("launcher-card").find((el) => el.dataset.zone === "life");
    if (!lifeCard) throw new Error("no launcher-card with data-zone=life rendered");
    expect(lifeCard.tagName).toBe("A");
    expect(lifeCard).toHaveAttribute("href", "/life/");

    // fireEvent.click dispatches a real, cancelable click event through
    // React's synthetic event system and into any onClick handler attached
    // to the element -- exactly the path react-router's <Link> hooks into.
    // A plain, un-intercepted <a> (or a <Link reloadDocument>, which is
    // engineered to behave like one -- see lib.js's isSpaLink branch)
    // leaves the event's default action alone; jsdom just doesn't happen to
    // implement following it, which is irrelevant to what's under test
    // here: whether react-router's SPA handler swallowed the click.
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(lifeCard, event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("the ACC card's click IS intercepted by the router (a real in-Shell route, unlike LifeOS)", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unreachable")));
    renderHome();

    const accCard = screen.getAllByTestId("launcher-card").find((el) => el.dataset.zone === "acc");
    if (!accCard) throw new Error("no launcher-card with data-zone=acc rendered");
    expect(accCard).toHaveAttribute("href", "/acc");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(accCard, event);

    // Contrast case: the ACC card DOES point at a real Shell route
    // (app.tsx's `/acc/*`), so it should keep the normal SPA behavior --
    // proving this suite's mechanism actually distinguishes the two cases
    // rather than happening to read `false` for every card.
    expect(event.defaultPrevented).toBe(true);
  });

  it("renders exactly one launcher card per zone, LifeOS included", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unreachable")));
    renderHome();

    const cards = screen.getAllByTestId("launcher-card");
    expect(cards).toHaveLength(6);
    expect(document.querySelector('[data-testid="launcher-card"][data-zone="life"]')).not.toBeNull();
  });
});
