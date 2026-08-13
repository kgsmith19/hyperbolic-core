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

  // Finding #76 (PR #8 security review): a 200 response used to be trusted
  // with a blind `as AccProcessStatus` cast and no runtime check -- these
  // prove a malformed 200 body degrades exactly like a network failure
  // (the SAME unreachable-state UI, per this finding's own fix guidance),
  // and -- just as importantly -- never crashes the render, given this app
  // has no error boundary anywhere.
  describe("malformed 200 response bodies (Finding #76)", () => {
    const malformedBodies: [string, unknown][] = [
      ["null", null],
      ["an array instead of an object", ["not", "an", "object"]],
      ["an empty object (missing every required field)", {}],
      [
        "weekText is a number instead of a string",
        { tier: null, weekText: 12345, stopped: false },
      ],
      [
        "stopped is a string instead of a boolean",
        { tier: null, weekText: "Week: $12 of $100", stopped: "false" },
      ],
      [
        "tier.tier is an unrecognized string",
        { tier: { tier: "purple" }, weekText: "Week: $12 of $100", stopped: false },
      ],
      [
        "tier.pct is a string instead of a number",
        { tier: { tier: "green", pct: "10" }, weekText: "Week: $12 of $100", stopped: false },
      ],
      ["tier is a string instead of an object or null", { tier: "green", weekText: "x", stopped: false }],
    ];

    for (const [label, body] of malformedBodies) {
      it(`${label}: renders the unreachable degrade, never throws`, async () => {
        mockFetchResolve(200, body);
        expect(() => render(<AccStatusCard />)).not.toThrow();

        await waitFor(() => {
          expect(screen.getByTestId("acc-status-unreachable")).toBeInTheDocument();
        });
        expect(screen.getByText("ACC unreachable")).toBeInTheDocument();
        expect(screen.queryByTestId("acc-status-ok")).toBeNull();
      });
    }
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
