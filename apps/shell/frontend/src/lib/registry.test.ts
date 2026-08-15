// splitByRoute is one of the two places this issue's own testing bar names
// as where a bug could silently leak or hide a tool (the other is
// packages/platform-client/src/registry.ts's buildListToolsParams, tested
// there). Pure function, no network -- fast, direct regression net;
// e2e/tools.spec.ts proves the same guarantee end to end against a real
// registry-shaped backend.
import { describe, expect, it } from "vitest";
import type { RegisteredTool } from "@hyperbolic/platform-client";
import { DISCOVERABLE_STATUS, splitByRoute } from "./registry";

function tool(overrides: Partial<RegisteredTool>): RegisteredTool {
  return {
    id: "fixture-tool",
    name: "Fixture Tool",
    schemaName: "fixture",
    status: "building",
    kind: "ui",
    route: "/fixture",
    version: "0.1.0",
    description: null,
    manifestHash: null,
    registeredAt: null,
    ...overrides,
  };
}

describe("splitByRoute: route-vs-status-page split (05-c section 4.3)", () => {
  it("a row with a non-null route becomes a navigation entry", () => {
    const { navTools, statusTools } = splitByRoute([tool({ id: "prompt-organizer", route: "/prompts" })]);
    expect(navTools.map((t) => t.id)).toEqual(["prompt-organizer"]);
    expect(statusTools).toEqual([]);
  });

  it("a row with a null route (headless/cli) becomes a status-page entry, never a navigation entry", () => {
    const { navTools, statusTools } = splitByRoute([
      tool({ id: "network-checker", kind: "cli", route: null }),
    ]);
    expect(navTools).toEqual([]);
    expect(statusTools.map((t) => t.id)).toEqual(["network-checker"]);
  });

  it("splits a mixed list correctly, preserving relative order within each group", () => {
    const tools = [
      tool({ id: "a", route: "/a" }),
      tool({ id: "b", route: null, kind: "cli" }),
      tool({ id: "c", route: "/c" }),
      tool({ id: "d", route: null, kind: "headless" }),
    ];
    const { navTools, statusTools } = splitByRoute(tools);
    expect(navTools.map((t) => t.id)).toEqual(["a", "c"]);
    expect(statusTools.map((t) => t.id)).toEqual(["b", "d"]);
  });

  it("empty string route is treated the same as null (falsy route never becomes a navigation entry)", () => {
    const { navTools, statusTools } = splitByRoute([tool({ id: "e", route: "" as unknown as string })]);
    expect(navTools).toEqual([]);
    expect(statusTools.map((t) => t.id)).toEqual(["e"]);
  });
});

describe("splitByRoute: TB-6, retired rows never render in navigation OR the status page", () => {
  it("a retired row with a route is excluded from navTools", () => {
    const { navTools, statusTools } = splitByRoute([
      tool({ id: "retired-ui-tool", route: "/retired-ui-tool", status: "retired" }),
    ]);
    expect(navTools).toEqual([]);
    expect(statusTools).toEqual([]);
  });

  it("a retired row with no route is excluded from statusTools too", () => {
    const { navTools, statusTools } = splitByRoute([
      tool({ id: "retired-cli-tool", route: null, kind: "cli", status: "retired" }),
    ]);
    expect(navTools).toEqual([]);
    expect(statusTools).toEqual([]);
  });

  it("a retired row disappears from a mixed list while its siblings still render", () => {
    const tools = [
      tool({ id: "live-tool", route: "/live-tool", status: "live" }),
      tool({ id: "retired-tool", route: "/retired-tool", status: "retired" }),
      tool({ id: "building-tool", route: null, kind: "headless", status: "building" }),
    ];
    const { navTools, statusTools } = splitByRoute(tools);
    expect(navTools.map((t) => t.id)).toEqual(["live-tool"]);
    expect(statusTools.map((t) => t.id)).toEqual(["building-tool"]);
  });
});

describe("splitByRoute: empty input", () => {
  it("returns two empty arrays for an empty list", () => {
    expect(splitByRoute([])).toEqual({ navTools: [], statusTools: [] });
  });
});

describe("DISCOVERABLE_STATUS: 05-c section 4.3's server-side filter (status in ('building','live'))", () => {
  // Mutation-testing finding: every currently-registered real tool (and
  // every e2e fixture) uses status='building', so a regression dropping
  // 'live' from this filter would go undetected by every 'building'-status
  // test above -- splitByRoute's own "live-tool" case (TB-6 describe block)
  // proves splitByRoute itself doesn't exclude 'live', but nothing
  // previously asserted the SERVER-SIDE query filter actually requests
  // 'live' rows in the first place. A tool promoted to status='live' would
  // silently vanish from the Shell entirely under that regression, with
  // every existing test still green.
  it("includes both 'building' and 'live', excludes 'idea' and 'retired'", () => {
    expect(DISCOVERABLE_STATUS.status).toEqual(expect.arrayContaining(["building", "live"]));
    expect(DISCOVERABLE_STATUS.status).toHaveLength(2);
  });
});
