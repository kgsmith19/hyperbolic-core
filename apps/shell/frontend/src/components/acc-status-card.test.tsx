// The /acc card degrade case (docs/planning/05-b-acc.md section 5's
// acceptance criterion, this issue's verification list item 3): "When the
// ACC loopback API is unreachable, the /acc card shall render the
// unreachable state and no error toast" -- proven here with a REAL mocked
// fetch failure, not just asserted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AccStatusCard } from "./acc-status-card";
import { ACC_TOKEN_STORAGE_KEY } from "../lib/acc";

const VALID_ACC_TOKEN = "A".repeat(43);

function storeAccToken(token = VALID_ACC_TOKEN) {
  window.sessionStorage.setItem(ACC_TOKEN_STORAGE_KEY, token);
}

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
  window.sessionStorage.clear();
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
});
describe("AccStatusCard: unreachable degrade (mocked fetch failure)", () => {
  it('renders "ACC unreachable" and nothing toast-shaped, when fetch rejects', async () => {
    mockFetchReject();
    render(<AccStatusCard />);

    await waitFor(() => {
      expect(screen.getByTestId("acc-status-unreachable")).toBeInTheDocument();
    });
    expect(screen.getByText("ACC unreachable")).toBeInTheDocument();

    // A toast surface exists as of m2-05. This isolated card render proves
    // the unreachable path itself publishes nothing toast-shaped.
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
    window.location.hash = `acc-token=${VALID_ACC_TOKEN}`;
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
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem(ACC_TOKEN_STORAGE_KEY)).toBe(VALID_ACC_TOKEN);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { "X-ACC-Token": VALID_ACC_TOKEN } }),
    );
  });

  it('renders a "Stopped" badge when stopped is true', async () => {
    storeAccToken();
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

  it.each([
    ["unknown tier", { tier: { tier: "blue" }, weekText: "Week", stopped: false }],
    ["missing week text", { tier: { tier: "green" }, stopped: false }],
    ["wrong stopped type", { tier: null, weekText: "Week", stopped: "no" }],
    ["non-object body", ["green", "Week", false]],
  ])("treats a malformed 200 response as unreachable: %s", async (_label, body) => {
    storeAccToken();
    mockFetchResolve(200, body);
    render(<AccStatusCard />);

    await waitFor(() => {
      expect(screen.getByTestId("acc-status-unreachable")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("acc-status-ok")).toBeNull();
  });

  it("reuses the tab-scoped token after reload without putting it back in the URL", async () => {
    storeAccToken();
    mockFetchResolve(200, { tier: null, weekText: "No spend", stopped: false });
    render(<AccStatusCard />);
    await waitFor(() => expect(screen.getByTestId("acc-status-ok")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { "X-ACC-Token": VALID_ACC_TOKEN } }),
    );
    expect(window.location.hash).toBe("");
  });

  it("a malformed bootstrap clears a stale token, strips the fragment, and sends no credential", async () => {
    storeAccToken();
    window.location.hash = "acc-token=%";
    mockFetchResolve(401, { error: "unauthorized" });
    render(<AccStatusCard />);
    await waitFor(() => expect(screen.getByTestId("acc-status-unreachable")).toBeInTheDocument());
    expect(window.sessionStorage.getItem(ACC_TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.location.hash).toBe("");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: undefined }),
    );
  });
});
