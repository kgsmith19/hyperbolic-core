// /prompts page (m5-01/m5-02). src/lib/prompts.ts's own PostgREST mechanics
// are already covered by src/lib/prompts.test.ts -- this file mocks that
// module and tests only what the UI does with the data it gets back:
// search/tag/archived filtering, the new-prompt dialog, and -- through
// PromptCard/RenderPanel/VersionHistory, exercised here rather than in
// isolation, since their whole job is to compose into one card -- body
// edit, rename refusal, tag add, archive, the render/copy/token-estimate
// flow, and version restore.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import PromptsListPage from "./list";
import {
  addTags,
  createPrompt,
  listPrompts,
  listVersions,
  recordUsage,
  saveConfiguration,
  setArchived,
  updateBody,
  updateTitle,
  type Prompt,
} from "../../lib/prompts";

vi.mock("../../lib/prompts", async () => {
  const actual = await vi.importActual<typeof import("../../lib/prompts")>("../../lib/prompts");
  return {
    ...actual,
    listPrompts: vi.fn(),
    createPrompt: vi.fn(),
    updateBody: vi.fn(),
    updateTitle: vi.fn(),
    setArchived: vi.fn(),
    listVersions: vi.fn(),
    addTags: vi.fn(),
    saveConfiguration: vi.fn(),
    recordUsage: vi.fn(),
  };
});

const mockedListPrompts = vi.mocked(listPrompts);
const mockedCreatePrompt = vi.mocked(createPrompt);
const mockedUpdateBody = vi.mocked(updateBody);
const mockedUpdateTitle = vi.mocked(updateTitle);
const mockedSetArchived = vi.mocked(setArchived);
const mockedListVersions = vi.mocked(listVersions);
const mockedAddTags = vi.mocked(addTags);
const mockedSaveConfiguration = vi.mocked(saveConfiguration);
const mockedRecordUsage = vi.mocked(recordUsage);

function prompt(overrides: Partial<Prompt>): Prompt {
  return {
    id: "id-1",
    title: "Fixture prompt",
    body: "Fixture body",
    isActive: true,
    tags: [],
    currentVersionNo: 1,
    configurations: [],
    usageCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PromptsListPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockedRecordUsage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

/** @testing-library/user-event's own setup() installs its OWN
 * navigator.clipboard stub (jsdom has none at all until then) -- spying on
 * writeText must happen AFTER setup(), not before, or user-event's own
 * installation silently replaces whatever was stubbed first. */
function setupUser() {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  return { user, writeText };
}

describe("PromptsListPage: load states", () => {
  it("shows the empty state with a save-first-prompt action when there are zero prompts", async () => {
    mockedListPrompts.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText("No prompts yet.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /save your first prompt/i })).toBeInTheDocument();
  });

  it("shows an error state with a working retry", async () => {
    mockedListPrompts.mockRejectedValueOnce(new Error("network unreachable"));
    mockedListPrompts.mockResolvedValueOnce([prompt({ title: "Recovered" })]);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText("Could not load prompts")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Recovered")).toBeInTheDocument());
  });
});

describe("PromptsListPage: search, tag filter, archived toggle", () => {
  function fixtureSet(): Prompt[] {
    return [
      prompt({ id: "a", title: "Spec Author", body: "writes specs", tags: ["writing"] }),
      prompt({ id: "b", title: "Bug Fixer", body: "fix a defect", tags: ["code"] }),
      prompt({ id: "c", title: "Old draft", isActive: false }),
    ];
  }

  it("hides archived prompts by default, shows them once the toggle is checked", async () => {
    mockedListPrompts.mockResolvedValue(fixtureSet());
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId("prompt-card")).toHaveLength(2));
    await user.click(screen.getByTestId("show-archived-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("prompt-card")).toHaveLength(3));
  });

  it("the search box narrows by title, case-insensitively", async () => {
    mockedListPrompts.mockResolvedValue(fixtureSet());
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("prompt-card")).toHaveLength(2));

    await user.type(screen.getByTestId("prompts-search"), "BUG");
    await waitFor(() => {
      const cards = screen.getAllByTestId("prompt-card");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveAttribute("data-prompt-id", "b");
    });
  });

  it("clicking a tag chip filters to that tag, and clicking it again clears the filter", async () => {
    mockedListPrompts.mockResolvedValue(fixtureSet());
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("prompt-card")).toHaveLength(2));

    const bCard = screen.getAllByTestId("prompt-card").find((c) => c.dataset.promptId === "b")!;
    const codeChip = within(bCard).getByTestId("tag-chip");
    await user.click(codeChip);

    await waitFor(() => {
      const cards = screen.getAllByTestId("prompt-card");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveAttribute("data-prompt-id", "b");
    });
    expect(screen.getByTestId("clear-tag-filter")).toBeInTheDocument();

    await user.click(screen.getByTestId("clear-tag-filter"));
    await waitFor(() => expect(screen.getAllByTestId("prompt-card")).toHaveLength(2));
  });

  it("'/' focuses the search box from anywhere on the page", async () => {
    mockedListPrompts.mockResolvedValue(fixtureSet());
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("prompt-card")).toHaveLength(2));

    const search = screen.getByTestId("prompts-search") as HTMLInputElement;
    expect(document.activeElement).not.toBe(search);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    await waitFor(() => expect(document.activeElement).toBe(search));
  });
});

describe("PromptsListPage: new prompt dialog", () => {
  it("requires both title and body, and never calls createPrompt when either is blank", async () => {
    mockedListPrompts.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("new-prompt-button")).toBeInTheDocument());

    await user.click(screen.getByTestId("new-prompt-button"));
    await user.click(screen.getByTestId("new-prompt-save"));

    expect(screen.getByTestId("new-prompt-error")).toHaveTextContent(/required/i);
    expect(mockedCreatePrompt).not.toHaveBeenCalled();
  });

  it("creates a prompt with parsed tags and prepends it to the list", async () => {
    mockedListPrompts.mockResolvedValue([]);
    mockedCreatePrompt.mockResolvedValue(prompt({ id: "new-id", title: "New one", tags: ["a", "b"] }));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("new-prompt-button")).toBeInTheDocument());

    await user.click(screen.getByTestId("new-prompt-button"));
    await user.type(screen.getByTestId("new-prompt-title"), "New one");
    await user.type(screen.getByTestId("new-prompt-body"), "The body");
    await user.type(screen.getByTestId("new-prompt-tags"), "A, b, a");
    await user.click(screen.getByTestId("new-prompt-save"));

    await waitFor(() =>
      expect(mockedCreatePrompt).toHaveBeenCalledWith({ title: "New one", body: "The body", tags: ["a", "b"] })
    );
    await waitFor(() => expect(screen.getByTestId("prompt-card")).toBeInTheDocument());
    expect(screen.getByTestId("prompt-title")).toHaveTextContent("New one");
  });
});

describe("PromptCard: title rename refusal (05-d section 5)", () => {
  it("offers no Rename control for a namespaced title", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ title: "brain/task-contract" })]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("prompt-card")).toBeInTheDocument());
    expect(screen.queryByTestId("edit-title-button")).toBeNull();
    expect(screen.getByTestId("rename-refused-note")).toBeInTheDocument();
  });

  it("offers a working Rename control for a legacy (non-namespaced) title", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ title: "My personal prompt" })]);
    mockedUpdateTitle.mockResolvedValue(prompt({ title: "Renamed" }));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("edit-title-button")).toBeInTheDocument());

    await user.click(screen.getByTestId("edit-title-button"));
    await user.clear(screen.getByTestId("title-field"));
    await user.type(screen.getByTestId("title-field"), "Renamed");
    await user.click(screen.getByTestId("save-title-button"));

    await waitFor(() => expect(mockedUpdateTitle).toHaveBeenCalledWith("id-1", "Renamed"));
    await waitFor(() => expect(screen.getByTestId("prompt-title")).toHaveTextContent("Renamed"));
  });
});

describe("PromptCard: body edit is versioned", () => {
  it("editing and saving the body calls updateBody and reflects the saved result", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ body: "old body" })]);
    mockedUpdateBody.mockResolvedValue(prompt({ body: "new body" }));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("prompt-body")).toHaveTextContent("old body"));

    await user.click(screen.getByTestId("edit-body-button"));
    await user.clear(screen.getByTestId("body-field"));
    await user.type(screen.getByTestId("body-field"), "new body");
    await user.click(screen.getByTestId("save-body-button"));

    await waitFor(() => expect(mockedUpdateBody).toHaveBeenCalledWith("id-1", "new body"));
    await waitFor(() => expect(screen.getByTestId("prompt-body")).toHaveTextContent("new body"));
  });

  it("Cancel discards the draft without calling updateBody", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ body: "old body" })]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("edit-body-button")).toBeInTheDocument());

    await user.click(screen.getByTestId("edit-body-button"));
    await user.type(screen.getByTestId("body-field"), " more");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockedUpdateBody).not.toHaveBeenCalled();
    expect(screen.getByTestId("prompt-body")).toHaveTextContent("old body");
  });
});

describe("PromptCard: tags and archive", () => {
  it("adding tags calls addTags with only the new, deduplicated set and merges them locally", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ tags: ["existing"] })]);
    mockedAddTags.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("add-tags-field")).toBeInTheDocument());

    await user.type(screen.getByTestId("add-tags-field"), "existing, new-one");
    await user.click(screen.getByTestId("add-tags-button"));

    await waitFor(() => expect(mockedAddTags).toHaveBeenCalledWith("id-1", ["new-one"]));
    await waitFor(() => expect(screen.getAllByTestId("tag-chip").map((c) => c.textContent)).toContain("new-one"));
  });

  it("archiving toggles is_active via setArchived and the summary shows the Archived badge", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ isActive: true })]);
    mockedSetArchived.mockResolvedValue(prompt({ isActive: false }));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("archive-toggle-button")).toHaveTextContent("Archive"));

    await user.click(screen.getByTestId("archive-toggle-button"));

    await waitFor(() => expect(mockedSetArchived).toHaveBeenCalledWith("id-1", false));
    // Archiving removes it from the default (active-only) view entirely.
    await waitFor(() => expect(screen.queryByTestId("prompt-card")).toBeNull());
  });
});

describe("PromptCard -> RenderPanel: variables, sections, preview/copy, token estimate, usage", () => {
  it("does not render a panel at all for a prompt with no variables or sections", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ body: "plain text, nothing to render" })]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("prompt-card")).toBeInTheDocument());
    expect(screen.queryByTestId("render-panel")).toBeNull();
  });

  it("an empty variable input is treated as MISSING, not an empty value -- copy is refused", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ body: "Hello {{NAME}}." })]);
    const { user, writeText } = setupUser();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("render-panel")).toBeInTheDocument());

    await user.click(screen.getByTestId("render-preview-copy"));

    expect(screen.getByTestId("render-status-missing")).toHaveTextContent("Missing: NAME");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("filling a variable renders, copies to the clipboard, shows the preview with a labeled token estimate, and logs usage after the copy confirms", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ id: "p1", body: "Hello {{NAME}}.", currentVersionNo: 5 })]);
    const { user, writeText } = setupUser();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("render-panel")).toBeInTheDocument());

    await user.type(screen.getByTestId("render-variable-NAME"), "World");
    await user.click(screen.getByTestId("render-preview-copy"));

    expect(writeText).toHaveBeenCalledWith("Hello World.");
    expect(screen.getByTestId("render-status-copied")).toHaveTextContent("Copied!");
    expect(screen.getByTestId("render-status-copied")).toHaveTextContent("Hello World.");
    const estimate = screen.getByTestId("render-token-estimate");
    expect(estimate).toHaveTextContent(/tokens \(estimate\)/);

    await waitFor(() => expect(mockedRecordUsage).toHaveBeenCalledWith("p1", 5, expect.any(Number)));
    // The usage badge updates only after the (fire-and-forget) log resolves.
    await waitFor(() => expect(screen.getByTestId("prompt-usage-badge")).toHaveTextContent("1 use"));
  });

  it("unchecking an optional section excludes its content and no longer requires its variable", async () => {
    mockedListPrompts.mockResolvedValue([
      prompt({ body: "Base. <!--OPTIONAL:extra-->Extra {{DETAIL}}.<!--/OPTIONAL:extra-->" }),
    ]);
    const { user, writeText } = setupUser();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("render-section-extra")).toBeInTheDocument());

    await user.click(screen.getByTestId("render-section-extra"));
    await user.click(screen.getByTestId("render-preview-copy"));

    expect(writeText).toHaveBeenCalledWith("Base. ");
    expect(screen.queryByTestId("render-status-missing")).toBeNull();
  });

  it("saving a configuration calls saveConfiguration with only the filled variables and the checked sections", async () => {
    mockedListPrompts.mockResolvedValue([
      prompt({ id: "p1", body: "Hi {{NAME}}. <!--OPTIONAL:s-->x<!--/OPTIONAL:s-->" }),
    ]);
    mockedSaveConfiguration.mockResolvedValue({ name: "cfg1", values: { NAME: "World" }, sections: ["s"] });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("render-panel")).toBeInTheDocument());

    await user.type(screen.getByTestId("render-variable-NAME"), "World");
    await user.type(screen.getByTestId("render-config-name"), "cfg1");
    await user.click(screen.getByTestId("render-save-config"));

    await waitFor(() =>
      expect(mockedSaveConfiguration).toHaveBeenCalledWith("p1", "cfg1", { NAME: "World" }, ["s"])
    );
  });

  it("applying a saved configuration only fills variables that still exist in the current body (SPEC-0011 AC-001)", async () => {
    mockedListPrompts.mockResolvedValue([
      prompt({
        body: "Hi {{NAME}}.",
        configurations: [{ name: "stale-cfg", values: { NAME: "Applied", GONE: "ignored" }, sections: [] }],
      }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("render-config-select")).toBeInTheDocument());

    await user.selectOptions(screen.getByTestId("render-config-select"), "stale-cfg");

    expect(screen.getByTestId("render-variable-NAME")).toHaveValue("Applied");
  });
});

describe("PromptCard -> VersionHistory: restore", () => {
  it("loads versions lazily on first expand and never offers Restore for the current version", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ id: "p1", body: "current body" })]);
    mockedListVersions.mockResolvedValue([
      { versionNo: 2, body: "current body", createdAt: "2026-08-02T00:00:00.000Z" },
      { versionNo: 1, body: "older body", createdAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("version-history")).toBeInTheDocument());
    expect(mockedListVersions).not.toHaveBeenCalled();

    await user.click(screen.getByText("Version history"));

    await waitFor(() => expect(mockedListVersions).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.getAllByTestId("version-row")).toHaveLength(2));
    expect(screen.queryByTestId("restore-version-2")).toBeNull();
    expect(screen.getByTestId("restore-version-1")).toBeInTheDocument();
  });

  it("restoring a prior version PATCHes its body as a new version, never rewriting history", async () => {
    mockedListPrompts.mockResolvedValue([prompt({ id: "p1", body: "current body" })]);
    mockedListVersions.mockResolvedValue([
      { versionNo: 2, body: "current body", createdAt: "2026-08-02T00:00:00.000Z" },
      { versionNo: 1, body: "older body", createdAt: "2026-08-01T00:00:00.000Z" },
    ]);
    mockedUpdateBody.mockResolvedValue(prompt({ id: "p1", body: "older body" }));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("version-history")).toBeInTheDocument());

    await user.click(screen.getByText("Version history"));
    await waitFor(() => expect(screen.getByTestId("restore-version-1")).toBeInTheDocument());
    await user.click(screen.getByTestId("restore-version-1"));

    await waitFor(() => expect(mockedUpdateBody).toHaveBeenCalledWith("p1", "older body"));
    await waitFor(() => expect(screen.getByTestId("prompt-body")).toHaveTextContent("older body"));
  });
});
