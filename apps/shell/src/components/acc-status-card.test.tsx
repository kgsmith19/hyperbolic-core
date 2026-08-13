// The /acc card degrade case (docs/planning/05-b-acc.md section 5's
// acceptance criterion, this issue's verification list item 3): "When the
// ACC loopback API is unreachable, the /acc card shall render the
// unreachable state and no error toast" -- proven here with a REAL mocked
// fetch failure, not just asserted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AccStatusCard } from "./acc-status-card";

function mockFetchReject(message = "network unreachable") {
  const spy = vi.fn().mockRejectedValue(new TypeError(message));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function mockFetchResolve(status: number, body: unknown) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccStatusCard: unreachable degrade (mocked fetch failure)", () => {
  it('renders "ACC unreachable" and nothing toast-shaped, when fetch rejects', async () => {
    mockFetchReject();
    render(<AccStatusCard />);

    await waitFor(() => {
      expect(screen.getByTestId("acc-status-unreachable")).toBeInTheDocument();
    });
    expect(screen.getByText("ACC unreachable")).toBeInTheDocument();

    // A toast surface DOES exist as of m2-05, which makes this assertion
    // stronger than when it was written, not weaker: the card is rendered
    // here without any chrome around it, so anything toast-shaped in this
    // DOM could only have come from the card itself. It renders inline
    // instead, per 09 section 4.4's "Error, inline" row.
    expect(document.querySelector('[data-slot*="toast"]')).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never throws while mounting or resolving the failed fetch", async () => {
    mockFetchReject();
    expect(() => render(<AccStatusCard />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByTestId("acc-status-unreachable")).toBeInTheDocument();
    });
  });

  it("treats a non-ok HTTP response (e.g. ACC's own 401 without a session token) as unreachable too", async () => {
    mockFetchResolve(401, { error: "unauthorized" });
    render(<AccStatusCard />);
    await waitFor(() => {
      expect(screen.getByText("ACC unreachable")).toBeInTheDocument();
    });
  });

  it("the Retry button re-issues the fetch", async () => {
    const spy = mockFetchReject();
    render(<AccStatusCard />);
    await waitFor(() => expect(screen.getByTestId("acc-status-unreachable")).toBeInTheDocument());
    expect(spy).toHaveBeenCalledTimes(1);

    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});

describe("AccStatusCard: reachable path (mocked fetch success)", () => {
  it("renders tier and week text when ACC responds 200", async () => {
    mockFetchResolve(200, {
      tier: { tier: "green", pct: 10 },
      weekText: "Week: $12 of $100",
      stopped: false,
    });
    render(<AccStatusCard />);

    await waitFor(() => {
      expect(screen.getByTestId("acc-status-ok")).toBeInTheDocument();
    });
    expect(screen.getByText("Spending is fine")).toBeInTheDocument();
    expect(screen.getByText("Week: $12 of $100")).toBeInTheDocument();
  });

  it('renders a "Stopped" badge when stopped is true', async () => {
    mockFetchResolve(200, {
      tier: { tier: "red", pct: 100 },
      weekText: "Week: $100 of $100",
      stopped: true,
    });
    render(<AccStatusCard />);
    await waitFor(() => {
      expect(screen.getByTestId("acc-status-ok")).toBeInTheDocument();
    });
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });
});
