// /ideas list page (05-h section 8): "One table... Filter tabs: All,
// Drafts, Ideas, Submitted... Submitted rows show the issue number as an
// outbound GitHub link and render visually locked. Derivative rows show a
// 'derived from #n' affordance." intake.ts's own PostgREST mechanics are
// already covered by src/lib/intake.test.ts -- this file mocks that module
// and tests only what THIS component does with the data it gets back:
// filtering, the locked-vs-editable row split, and the error/empty states.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import IdeasListPage from "./list";
import { listIdeas, type Idea } from "../../lib/intake";

vi.mock("../../lib/intake", () => ({ listIdeas: vi.fn() }));

const mockedListIdeas = vi.mocked(listIdeas);

function idea(overrides: Partial<Idea>): Idea {
  return {
    id: "id-1",
    parentIdeaId: null,
    title: "Fixture idea",
    problem: "",
    outcome: "",
    notes: "",
    confidence: "medium",
    status: "draft",
    source: "",
    targetRepo: null,
    idempotencyKey: "key-1",
    githubIssueNumber: null,
    githubIssueUrl: null,
    submittedAt: null,
    parentGithubIssueUrl: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={["/ideas"]}>
      <IdeasListPage />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("IdeasListPage: empty and error states", () => {
  it("shows the empty state with a 'capture your first idea' action when there are zero ideas at all", async () => {
    mockedListIdeas.mockResolvedValue([]);
    renderList();
    await waitFor(() => expect(screen.getByText("No ideas captured yet.")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /capture your first idea/i })).toHaveAttribute("href", "/ideas/new");
  });

  it("shows an error state with a working retry on load failure", async () => {
    mockedListIdeas.mockRejectedValueOnce(new Error("network unreachable"));
    mockedListIdeas.mockResolvedValueOnce([idea({ id: "id-1", title: "Recovered idea" })]);
    const user = userEvent.setup();
    renderList();

    await waitFor(() => expect(screen.getByText("Could not load ideas")).toBeInTheDocument());
    expect(screen.getByText("network unreachable")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Recovered idea")).toBeInTheDocument());
    expect(mockedListIdeas).toHaveBeenCalledTimes(2);
  });
});

describe("IdeasListPage: row rendering", () => {
  it("renders a draft row as an editable link, not locked", async () => {
    mockedListIdeas.mockResolvedValue([idea({ id: "id-1", title: "Draft idea", status: "draft" })]);
    renderList();
    await waitFor(() => expect(screen.getByTestId("idea-row")).toBeInTheDocument());

    expect(screen.getByTestId("idea-title-link")).toHaveAttribute("href", "/ideas/id-1");
    expect(screen.queryByTestId("idea-issue-link")).toBeNull();
  });

  it("renders a submitted row locked: plain text title, no edit link, with the GitHub issue link", async () => {
    mockedListIdeas.mockResolvedValue([
      idea({
        id: "id-2",
        title: "Submitted idea",
        status: "submitted_to_github",
        githubIssueNumber: 42,
        githubIssueUrl: "https://github.com/o/r/issues/42",
      }),
    ]);
    renderList();
    await waitFor(() => expect(screen.getByTestId("idea-row")).toBeInTheDocument());

    expect(screen.queryByTestId("idea-title-link")).toBeNull();
    expect(screen.getByTestId("idea-title")).toHaveTextContent("Submitted idea");
    const issueLink = screen.getByTestId("idea-issue-link");
    expect(issueLink).toHaveAttribute("href", "https://github.com/o/r/issues/42");
    expect(issueLink).toHaveTextContent("#42");
  });

  it("shows the 'derived from' affordance only when the idea has a parent with a GitHub issue", async () => {
    mockedListIdeas.mockResolvedValue([
      idea({ id: "id-3", title: "Derivative", parentGithubIssueUrl: "https://github.com/o/r/issues/1" }),
      idea({ id: "id-4", title: "Original" }),
    ]);
    renderList();
    await waitFor(() => expect(screen.getAllByTestId("idea-row")).toHaveLength(2));

    const rows = screen.getAllByTestId("idea-row");
    const derivative = rows.find((row) => row.dataset.ideaId === "id-3")!;
    const original = rows.find((row) => row.dataset.ideaId === "id-4")!;
    expect(within(derivative).getByTestId("idea-derived-from")).toHaveAttribute(
      "href",
      "https://github.com/o/r/issues/1"
    );
    expect(within(original).queryByTestId("idea-derived-from")).toBeNull();
  });
});

describe("IdeasListPage: filter tabs and title filter (client-side narrowing over the one fetch)", () => {
  function fixtureSet(): Idea[] {
    return [
      idea({ id: "d1", title: "Draft alpha", status: "draft" }),
      idea({ id: "i1", title: "Idea beta", status: "idea" }),
      idea({
        id: "s1",
        title: "Submitted gamma",
        status: "submitted_to_github",
        githubIssueNumber: 1,
        githubIssueUrl: "https://github.com/o/r/issues/1",
      }),
    ];
  }

  it("the 'All' tab (default) shows every idea regardless of status", async () => {
    mockedListIdeas.mockResolvedValue(fixtureSet());
    renderList();
    await waitFor(() => expect(screen.getAllByTestId("idea-row")).toHaveLength(3));
  });

  it("each non-All tab narrows to exactly its own status, never leaking rows from another status", async () => {
    mockedListIdeas.mockResolvedValue(fixtureSet());
    const user = userEvent.setup();
    renderList();
    await waitFor(() => expect(screen.getAllByTestId("idea-row")).toHaveLength(3));

    await user.click(screen.getByTestId("ideas-tab-draft"));
    await waitFor(() => {
      const rows = screen.getAllByTestId("idea-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-status", "draft");
    });

    await user.click(screen.getByTestId("ideas-tab-submitted_to_github"));
    await waitFor(() => {
      const rows = screen.getAllByTestId("idea-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-status", "submitted_to_github");
    });
  });

  it("switching to a tab with no matching rows shows the 'no ideas match this filter' empty state, not the zero-ideas one", async () => {
    mockedListIdeas.mockResolvedValue([idea({ id: "d1", title: "Only draft", status: "draft" })]);
    const user = userEvent.setup();
    renderList();
    await waitFor(() => expect(screen.getAllByTestId("idea-row")).toHaveLength(1));

    await user.click(screen.getByTestId("ideas-tab-submitted_to_github"));
    await waitFor(() => expect(screen.getByText("No ideas match this filter.")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /capture your first idea/i })).toBeNull();
  });

  it("the title filter narrows case-insensitively and combines with the active tab", async () => {
    mockedListIdeas.mockResolvedValue(fixtureSet());
    const user = userEvent.setup();
    renderList();
    await waitFor(() => expect(screen.getAllByTestId("idea-row")).toHaveLength(3));

    await user.type(screen.getByTestId("ideas-title-filter"), "BETA");
    await waitFor(() => {
      const rows = screen.getAllByTestId("idea-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-idea-id", "i1");
    });
  });
});
