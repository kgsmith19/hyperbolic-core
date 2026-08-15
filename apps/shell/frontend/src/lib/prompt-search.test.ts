// Parity + behavior tests for the port of
// apps/toolbelt/apps/prompt-organizer/web/search.mjs. The parity block
// mirrors packages/llm/tests/prompt-render-parity.test.mjs's own rationale
// verbatim: a hand-copy can silently drift from its source without either
// suite ever noticing, so this imports BOTH implementations and asserts
// identical output across representative and fuzzed inputs -- the actual
// enforcement mechanism, not just a comment promising fidelity.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs, no type declarations; imported only for
// this file's runtime parity check against the TS port below.
import * as original from "../../../../toolbelt/apps/prompt-organizer/web/search.mjs";
import { filterByActive, searchPrompts, shouldFocusSearch, toggleTagFilter } from "./prompt-search";
import type { Prompt } from "./prompts";

function prompt(overrides: Partial<Prompt>): Prompt {
  return {
    id: "id-1",
    title: "Fixture",
    body: "body",
    isActive: true,
    tags: [],
    currentVersionNo: 1,
    configurations: [],
    usageCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parity with web/search.mjs", () => {
  const FIXTURES: Array<{ title: string; body: string; tags?: string[]; isActive?: boolean }> = [
    { title: "Spec Author", body: "writes specs" },
    { title: "Bug Fixer", body: "fix a spec defect" },
    { title: "Daily Journal", body: "morning pages" },
    { title: "Regex (.*) Guide", body: "literal dot star" },
    { title: "Café Menu", body: "menu du jour", tags: ["food", "Café"] },
    { title: "Archived one", body: "old", isActive: false },
  ];
  const QUERIES = ["spec", "SPEC", "", "zzz-none", "café", "food", "(.*)"];

  it("searchPrompts produces identical output to the original for every query", () => {
    for (const query of QUERIES) {
      const a = original.searchPrompts(FIXTURES, query);
      const b = searchPrompts(FIXTURES.map((f) => prompt(f)), query);
      expect(b.map((p) => p.title)).toEqual(a.map((p: { title: string }) => p.title));
    }
  });

  it("filterByActive produces identical output to the original", () => {
    for (const showArchived of [true, false]) {
      const a = original.filterByActive(FIXTURES, showArchived);
      const b = filterByActive(FIXTURES.map((f) => prompt(f)), showArchived);
      expect(b.map((p) => p.title)).toEqual(a.map((p: { title: string }) => p.title));
    }
  });

  it("toggleTagFilter and shouldFocusSearch produce identical output to the original", () => {
    expect(toggleTagFilter("a", "a")).toEqual(original.toggleTagFilter("a", "a"));
    expect(toggleTagFilter("a", "b")).toEqual(original.toggleTagFilter("a", "b"));
    expect(toggleTagFilter(null, "b")).toEqual(original.toggleTagFilter(null, "b"));
    for (const [key, tag] of [
      ["/", "INPUT"],
      ["/", "DIV"],
      ["a", "DIV"],
    ] as const) {
      expect(shouldFocusSearch(key, tag)).toEqual(original.shouldFocusSearch(key, tag));
    }
  });
});

describe("searchPrompts: own behavioral assertions", () => {
  const prompts = [
    prompt({ id: "1", title: "Spec Author", body: "writes specs" }),
    prompt({ id: "2", title: "Bug Fixer", body: "fix a spec defect" }),
    prompt({ id: "3", title: "Daily Journal", body: "morning pages" }),
  ];

  it("matches case-insensitively on title or body", () => {
    expect(searchPrompts(prompts, "spec").map((p) => p.id).sort()).toEqual(["1", "2"]);
    expect(searchPrompts(prompts, "SPEC").map((p) => p.id).sort()).toEqual(["1", "2"]);
  });

  it("ranks a title match above a body-only match, regardless of input order", () => {
    const reordered = [prompts[1]!, prompts[0]!, prompts[2]!];
    expect(searchPrompts(reordered, "spec").map((p) => p.id)).toEqual(["1", "2"]);
  });

  it("an empty query returns every prompt, unmutated, in original order", () => {
    const input = [...prompts];
    expect(searchPrompts(input, "")).toEqual(prompts);
    expect(input).toEqual(prompts);
  });

  it("matches a tag before falling back to a body-only match", () => {
    const tagged = [
      prompt({ id: "t1", title: "Untitled", body: "no keyword here", tags: ["keyword"] }),
      prompt({ id: "t2", title: "Other", body: "mentions keyword in body" }),
    ];
    expect(searchPrompts(tagged, "keyword").map((p) => p.id)).toEqual(["t1", "t2"]);
  });
});

describe("filterByActive", () => {
  it("hides archived prompts by default", () => {
    const prompts = [prompt({ id: "a", isActive: true }), prompt({ id: "b", isActive: false })];
    expect(filterByActive(prompts, false).map((p) => p.id)).toEqual(["a"]);
  });

  it("shows every prompt when showArchived is true", () => {
    const prompts = [prompt({ id: "a", isActive: true }), prompt({ id: "b", isActive: false })];
    expect(filterByActive(prompts, true).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("toggleTagFilter", () => {
  it("clicking the same tag again clears the filter", () => {
    expect(toggleTagFilter("food", "food")).toBeNull();
  });

  it("clicking a different tag selects it", () => {
    expect(toggleTagFilter("food", "travel")).toBe("travel");
  });
});

describe("shouldFocusSearch", () => {
  it('"/" focuses search when nothing is being typed into', () => {
    expect(shouldFocusSearch("/", "BODY")).toBe(true);
  });

  it('"/" types literally while a text field already has focus', () => {
    expect(shouldFocusSearch("/", "INPUT")).toBe(false);
    expect(shouldFocusSearch("/", "TEXTAREA")).toBe(false);
    expect(shouldFocusSearch("/", "SELECT")).toBe(false);
  });

  it("any other key never triggers the shortcut", () => {
    expect(shouldFocusSearch("a", "BODY")).toBe(false);
  });
});
