// /ideas/new and /ideas/:id editor (05-h section 8): status-dependent
// action sets (draft: Save/Promote/Delete; idea: Save/Submit; submitted:
// fully read-only) and the submit confirmation modal. intake.ts's own
// PostgREST/submit mechanics are covered by src/lib/intake.test.ts -- this
// file mocks that module entirely and tests only what THIS page does:
// which actions are offered per status, what each action sends, and how
// the page reacts to every SubmitResult outcome.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import IdeaEditorPage from "./editor";
import {
  buildSubmitPreview,
  createDraft,
  deleteIdea,
  getIdea,
  submitIdea,
  updateIdea,
  type Idea,
} from "../../lib/intake";
import { optimizeIdea } from "../../lib/optimize";

const mockNavigate = vi.fn();
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../lib/intake", () => ({
  getIdea: vi.fn(),
  createDraft: vi.fn(),
  updateIdea: vi.fn(),
  deleteIdea: vi.fn(),
  submitIdea: vi.fn(),
  buildSubmitPreview: vi.fn((idea: Idea) => ({
    title: idea.title,
    body: `body-for-${idea.id}`,
    labels: idea.parentGithubIssueUrl ? ["from-idea-intake", "derived"] : ["from-idea-intake"],
  })),
}));

vi.mock("../../lib/optimize", () => ({
  optimizeIdea: vi.fn(),
}));

const mockedGetIdea = vi.mocked(getIdea);
const mockedCreateDraft = vi.mocked(createDraft);
const mockedUpdateIdea = vi.mocked(updateIdea);
const mockedDeleteIdea = vi.mocked(deleteIdea);
const mockedSubmitIdea = vi.mocked(submitIdea);
const mockedBuildSubmitPreview = vi.mocked(buildSubmitPreview);
const mockedOptimizeIdea = vi.mocked(optimizeIdea);

const OPTIMIZED_DRAFT = {
  title: "Optimized title",
  problem: "Optimized problem",
  outcome: "Optimized outcome",
  notes: "Optimized notes",
  confidence: "high" as const,
};

function idea(overrides: Partial<Idea>): Idea {
  return {
    id: "idea-1",
    parentIdeaId: null,
    title: "Fixture idea",
    problem: "The problem",
    outcome: "The outcome",
    notes: "Some notes",
    confidence: "medium",
    status: "draft",
    source: "manual",
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

function renderCreate() {
  return render(
    <MemoryRouter initialEntries={["/ideas/new"]}>
      <Routes>
        <Route path="/ideas/new" element={<IdeaEditorPage mode="create" />} />
        <Route path="/ideas/:id" element={<IdeaEditorPage mode="edit" />} />
        <Route path="/ideas" element={<div data-testid="ideas-list-stub" />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderEdit(id = "idea-1") {
  return render(
    <MemoryRouter initialEntries={[`/ideas/${id}`]}>
      <Routes>
        <Route path="/ideas/new" element={<IdeaEditorPage mode="create" />} />
        <Route path="/ideas/:id" element={<IdeaEditorPage mode="edit" />} />
        <Route path="/ideas" element={<div data-testid="ideas-list-stub" />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("IdeaEditorPage: create mode", () => {
  it("requires a title before saving, and never calls createDraft when it's blank", async () => {
    const user = userEvent.setup();
    renderCreate();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("save-idea-button"));

    expect(screen.getByTestId("idea-form-error")).toHaveTextContent("Title is required.");
    expect(mockedCreateDraft).not.toHaveBeenCalled();
  });

  it("saves a new draft with the entered fields and navigates to its edit page", async () => {
    mockedCreateDraft.mockResolvedValue(idea({ id: "new-id" }));
    const user = userEvent.setup();
    renderCreate();
    await screen.findByTestId("idea-editor-page");

    await user.type(screen.getByTestId("idea-title-field"), "My new idea");
    await user.type(screen.getByTestId("idea-problem-field"), "A problem");
    await user.click(screen.getByTestId("save-idea-button"));

    await waitFor(() => expect(mockedCreateDraft).toHaveBeenCalledTimes(1));
    expect(mockedCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My new idea", problem: "A problem", confidence: "medium" })
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/ideas/new-id"));
  });

  it("shows the target repo field (create is always draft-shaped) and hides Optimize (no idea row exists yet)", async () => {
    renderCreate();
    await screen.findByTestId("idea-editor-page");
    expect(screen.getByTestId("idea-target-repo-field")).toBeInTheDocument();
    expect(screen.queryByTestId("optimize-idea-button")).toBeNull();
    expect(screen.queryByTestId("delete-idea-button")).toBeNull();
    expect(screen.queryByTestId("promote-idea-button")).toBeNull();
    expect(screen.queryByTestId("submit-idea-button")).toBeNull();
  });

  it("surfaces a save failure inline without navigating away", async () => {
    mockedCreateDraft.mockRejectedValue(new Error("insert failed"));
    const user = userEvent.setup();
    renderCreate();
    await screen.findByTestId("idea-editor-page");

    await user.type(screen.getByTestId("idea-title-field"), "Doomed idea");
    await user.click(screen.getByTestId("save-idea-button"));

    await waitFor(() => expect(screen.getByTestId("idea-form-error")).toHaveTextContent("insert failed"));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe("IdeaEditorPage: edit mode, load states", () => {
  it("shows an error state with retry when getIdea rejects", async () => {
    mockedGetIdea.mockRejectedValueOnce(new Error("network down"));
    mockedGetIdea.mockResolvedValueOnce(idea({}));
    const user = userEvent.setup();
    renderEdit();

    await waitFor(() => expect(screen.getByText("Could not load this idea")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("idea-editor-page")).toBeInTheDocument());
  });

  it('shows "Idea not found" when getIdea resolves null', async () => {
    mockedGetIdea.mockResolvedValue(null);
    renderEdit();
    await waitFor(() => expect(screen.getByText("Idea not found")).toBeInTheDocument());
  });
});

describe("IdeaEditorPage: edit mode, draft status action set", () => {
  it("offers Save, Promote, Delete, and enabled Optimize -- never Submit", async () => {
    mockedGetIdea.mockResolvedValue(idea({ status: "draft" }));
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    expect(screen.getByTestId("save-idea-button")).toBeEnabled();
    expect(screen.getByTestId("promote-idea-button")).toBeInTheDocument();
    expect(screen.getByTestId("delete-idea-button")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-idea-button")).toBeEnabled();
    expect(screen.queryByTestId("submit-idea-button")).toBeNull();
  });

  it("refuses to promote without a valid owner/repo target, and never calls updateIdea", async () => {
    mockedGetIdea.mockResolvedValue(idea({ status: "draft", targetRepo: null }));
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("promote-idea-button"));

    expect(screen.getByTestId("idea-form-error")).toHaveTextContent(/owner\/repo/);
    expect(mockedUpdateIdea).not.toHaveBeenCalled();
  });

  it("promotes with a valid target repo, sending status: 'idea', and the action set flips to the idea shape in place", async () => {
    mockedGetIdea.mockResolvedValue(idea({ status: "draft", targetRepo: null }));
    mockedUpdateIdea.mockResolvedValue(idea({ status: "idea", targetRepo: "kgsmith19/hyperbolic-core" }));
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.type(screen.getByTestId("idea-target-repo-field"), "kgsmith19/hyperbolic-core");
    await user.click(screen.getByTestId("promote-idea-button"));

    await waitFor(() =>
      expect(mockedUpdateIdea).toHaveBeenCalledWith(
        "idea-1",
        expect.objectContaining({ status: "idea", targetRepo: "kgsmith19/hyperbolic-core" })
      )
    );
    await waitFor(() => expect(screen.getByTestId("submit-idea-button")).toBeInTheDocument());
    expect(screen.queryByTestId("promote-idea-button")).toBeNull();
    expect(screen.queryByTestId("delete-idea-button")).toBeNull();
  });

  it("rejects a malformed target repo (no slash) the same way as an empty one", async () => {
    mockedGetIdea.mockResolvedValue(idea({ status: "draft" }));
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.type(screen.getByTestId("idea-target-repo-field"), "not-a-valid-repo");
    await user.click(screen.getByTestId("promote-idea-button"));

    expect(screen.getByTestId("idea-form-error")).toHaveTextContent(/owner\/repo/);
    expect(mockedUpdateIdea).not.toHaveBeenCalled();
  });

  it("deletes the draft and navigates back to the list", async () => {
    mockedGetIdea.mockResolvedValue(idea({ status: "draft" }));
    mockedDeleteIdea.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("delete-idea-button"));

    await waitFor(() => expect(mockedDeleteIdea).toHaveBeenCalledWith("idea-1"));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/ideas"));
  });

  it("a failed delete surfaces inline and never navigates away", async () => {
    mockedGetIdea.mockResolvedValue(idea({ status: "draft" }));
    mockedDeleteIdea.mockRejectedValue(new Error("delete blocked"));
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("delete-idea-button"));

    await waitFor(() => expect(screen.getByTestId("idea-form-error")).toHaveTextContent("delete blocked"));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("saving a draft includes the editable target repo in the PATCH", async () => {
    mockedGetIdea.mockResolvedValue(idea({ status: "draft", targetRepo: "" }));
    mockedUpdateIdea.mockResolvedValue(idea({ status: "draft" }));
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.type(screen.getByTestId("idea-target-repo-field"), "kgsmith19/hyperbolic-core");
    await user.click(screen.getByTestId("save-idea-button"));

    await waitFor(() =>
      expect(mockedUpdateIdea).toHaveBeenCalledWith(
        "idea-1",
        expect.objectContaining({ targetRepo: "kgsmith19/hyperbolic-core" })
      )
    );
    expect(mockedUpdateIdea).not.toHaveBeenCalledWith("idea-1", expect.objectContaining({ status: expect.anything() }));
  });
});

describe("IdeaEditorPage: edit mode, idea status action set", () => {
  function ideaStatusFixture(overrides: Partial<Idea> = {}) {
    return idea({ status: "idea", targetRepo: "kgsmith19/hyperbolic-core", ...overrides });
  }

  it("offers Save and Submit, but never Promote or Delete", async () => {
    mockedGetIdea.mockResolvedValue(ideaStatusFixture());
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    expect(screen.getByTestId("save-idea-button")).toBeInTheDocument();
    expect(screen.getByTestId("submit-idea-button")).toBeInTheDocument();
    expect(screen.queryByTestId("promote-idea-button")).toBeNull();
    expect(screen.queryByTestId("delete-idea-button")).toBeNull();
  });

  it("renders the target repo read-only (no editable field) once promoted", async () => {
    mockedGetIdea.mockResolvedValue(ideaStatusFixture());
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    expect(screen.queryByTestId("idea-target-repo-field")).toBeNull();
    expect(screen.getByTestId("idea-target-repo-readonly")).toHaveTextContent("kgsmith19/hyperbolic-core");
  });

  it("clicking Submit opens the confirmation modal with the real preview (title, body, labels) before any network call", async () => {
    mockedGetIdea.mockResolvedValue(ideaStatusFixture({ title: "Ship it" }));
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("submit-idea-button"));

    await screen.findByTestId("submit-confirmation-modal");
    expect(screen.getByTestId("submit-preview-title")).toHaveTextContent("Ship it");
    expect(screen.getByTestId("submit-preview-body")).toHaveTextContent("body-for-idea-1");
    expect(mockedBuildSubmitPreview).toHaveBeenCalled();
    expect(mockedSubmitIdea).not.toHaveBeenCalled();
  });

  it("Cancel closes the modal without ever calling submitIdea", async () => {
    mockedGetIdea.mockResolvedValue(ideaStatusFixture());
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("submit-idea-button"));
    await screen.findByTestId("submit-confirmation-modal");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByTestId("submit-confirmation-modal")).toBeNull());
    expect(mockedSubmitIdea).not.toHaveBeenCalled();
  });

  it("Confirm calls submitIdea(id) and, on success, closes the modal and switches the page into the locked SubmittedView", async () => {
    mockedGetIdea.mockResolvedValue(ideaStatusFixture());
    mockedSubmitIdea.mockResolvedValue({
      kind: "ok",
      issueNumber: 99,
      issueUrl: "https://github.com/kgsmith19/hyperbolic-core/issues/99",
    });
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("submit-idea-button"));
    await screen.findByTestId("submit-confirmation-modal");
    await user.click(screen.getByTestId("submit-confirm-button"));

    await waitFor(() => expect(mockedSubmitIdea).toHaveBeenCalledWith("idea-1"));
    await waitFor(() => expect(screen.queryByTestId("submit-confirmation-modal")).toBeNull());
    const issueLink = screen.getByTestId("idea-issue-link");
    expect(issueLink).toHaveAttribute("href", "https://github.com/kgsmith19/hyperbolic-core/issues/99");
    expect(issueLink).toHaveTextContent("Issue #99");
    // Once locked, none of the mutating actions exist anymore.
    expect(screen.queryByTestId("save-idea-button")).toBeNull();
    expect(screen.queryByTestId("submit-idea-button")).toBeNull();
  });

  it.each([
    ["draft_not_promoted" as const, { kind: "draft_not_promoted" as const }, /promote it before submitting/i],
    ["unauthorized" as const, { kind: "unauthorized" as const }, /sign in again/i],
    ["error" as const, { kind: "error" as const, message: "GitHub unreachable" }, /GitHub unreachable/],
  ])("Confirm shows an inline modal error for a %s outcome and leaves the modal open", async (_label, result, expected) => {
    mockedGetIdea.mockResolvedValue(ideaStatusFixture());
    mockedSubmitIdea.mockResolvedValue(result);
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("submit-idea-button"));
    await screen.findByTestId("submit-confirmation-modal");
    await user.click(screen.getByTestId("submit-confirm-button"));

    await waitFor(() => expect(screen.getByTestId("submit-error")).toHaveTextContent(expected));
    expect(screen.getByTestId("submit-confirmation-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("idea-issue-link")).toBeNull();
  });

  it("a thrown/rejected submitIdea (transport failure) is caught and shown inline, not left unhandled", async () => {
    mockedGetIdea.mockResolvedValue(ideaStatusFixture());
    mockedSubmitIdea.mockRejectedValue(new TypeError("network unreachable"));
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("submit-idea-button"));
    await screen.findByTestId("submit-confirmation-modal");
    await user.click(screen.getByTestId("submit-confirm-button"));

    await waitFor(() => expect(screen.getByTestId("submit-error")).toHaveTextContent("network unreachable"));
  });
});

describe("IdeaEditorPage: edit mode, submitted status is fully read-only", () => {
  it("renders SubmittedView with no Save/Promote/Delete/Submit actions, only the derivative action and the issue link", async () => {
    mockedGetIdea.mockResolvedValue(
      idea({
        status: "submitted_to_github",
        title: "Already shipped",
        githubIssueNumber: 7,
        githubIssueUrl: "https://github.com/kgsmith19/hyperbolic-core/issues/7",
      })
    );
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    expect(screen.queryByTestId("save-idea-button")).toBeNull();
    expect(screen.queryByTestId("promote-idea-button")).toBeNull();
    expect(screen.queryByTestId("delete-idea-button")).toBeNull();
    expect(screen.queryByTestId("submit-idea-button")).toBeNull();
    expect(screen.queryByTestId("idea-title-field")).toBeNull();

    const optimize = screen.getByTestId("optimize-derivative-button");
    expect(optimize).toBeEnabled();
    expect(optimize).toHaveTextContent("Optimize as new derivative");

    const issueLink = screen.getByTestId("idea-issue-link");
    expect(issueLink).toHaveAttribute("href", "https://github.com/kgsmith19/hyperbolic-core/issues/7");
    expect(issueLink).toHaveTextContent("Issue #7");
    expect(screen.getByText("Already shipped")).toBeInTheDocument();
  });
});

describe("IdeaEditorPage: optimize flow (m4-06)", () => {
  it("draft/idea: applies the optimized draft in place via an ordinary UPDATE, never an INSERT", async () => {
    const original = idea({ status: "idea", targetRepo: "kgsmith19/hyperbolic-core" });
    mockedGetIdea.mockResolvedValue(original);
    mockedOptimizeIdea.mockResolvedValue({ draft: OPTIMIZED_DRAFT, handlerRunId: "run-1", model: "claude-sonnet-5" });
    mockedUpdateIdea.mockResolvedValue({ ...original, ...OPTIMIZED_DRAFT });
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("optimize-idea-button"));
    expect(mockedOptimizeIdea).toHaveBeenCalledWith(original);

    await screen.findByTestId("optimize-draft-preview");
    expect(screen.getByTestId("optimize-draft-title")).toHaveTextContent(OPTIMIZED_DRAFT.title);
    expect(screen.getByTestId("optimize-draft-confidence")).toHaveTextContent("high");

    await user.click(screen.getByTestId("optimize-confirm-button"));

    await waitFor(() => expect(mockedUpdateIdea).toHaveBeenCalledTimes(1));
    expect(mockedUpdateIdea).toHaveBeenCalledWith(
      "idea-1",
      expect.objectContaining({
        title: OPTIMIZED_DRAFT.title,
        problem: OPTIMIZED_DRAFT.problem,
        outcome: OPTIMIZED_DRAFT.outcome,
        notes: OPTIMIZED_DRAFT.notes,
        confidence: OPTIMIZED_DRAFT.confidence,
      })
    );
    expect(mockedCreateDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("idea-title-field")).toHaveValue(OPTIMIZED_DRAFT.title));
  });

  it("draft/idea: a failed optimize call shows the error and never calls updateIdea", async () => {
    mockedGetIdea.mockResolvedValue(idea({ status: "draft" }));
    mockedOptimizeIdea.mockRejectedValue(new Error("Handler A returned 429"));
    const user = userEvent.setup();
    renderEdit();
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("optimize-idea-button"));

    await waitFor(() => expect(screen.getByTestId("optimize-error")).toHaveTextContent("Handler A returned 429"));
    expect(screen.getByTestId("optimize-confirm-button")).toBeDisabled();
    expect(mockedUpdateIdea).not.toHaveBeenCalled();
  });

  it("submitted: creates a derivative draft only, leaving the submitted idea untouched, and navigates to the new draft", async () => {
    const submitted = idea({
      id: "submitted-1",
      status: "submitted_to_github",
      githubIssueNumber: 7,
      githubIssueUrl: "https://github.com/kgsmith19/hyperbolic-core/issues/7",
    });
    mockedGetIdea.mockResolvedValue(submitted);
    mockedOptimizeIdea.mockResolvedValue({ draft: OPTIMIZED_DRAFT, handlerRunId: "run-2", model: "claude-sonnet-5" });
    mockedCreateDraft.mockResolvedValue(idea({ id: "derivative-1", parentIdeaId: "submitted-1", ...OPTIMIZED_DRAFT }));
    const user = userEvent.setup();
    renderEdit("submitted-1");
    await screen.findByTestId("idea-editor-page");

    await user.click(screen.getByTestId("optimize-derivative-button"));
    expect(mockedOptimizeIdea).toHaveBeenCalledWith(submitted);

    await screen.findByTestId("optimize-draft-preview");
    await user.click(screen.getByTestId("optimize-confirm-button"));

    await waitFor(() => expect(mockedCreateDraft).toHaveBeenCalledTimes(1));
    expect(mockedCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ ...OPTIMIZED_DRAFT, parentIdeaId: "submitted-1" })
    );
    expect(mockedUpdateIdea).not.toHaveBeenCalled();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/ideas/derivative-1"));
  });
});
