// Parity + behavior tests for the port of
// apps/toolbelt/apps/prompt-organizer/web/render.mjs. Same rationale as
// src/lib/prompt-search.test.ts's own parity block (and
// packages/llm/tests/prompt-render-parity.test.mjs, which proves the SAME
// original against a DIFFERENT copy): a hand-copy can silently drift from
// its source without any suite noticing unless something actually compares
// them.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs, no type declarations; imported only for
// this file's runtime parity check against the TS port below.
import * as original from "../../../../toolbelt/apps/prompt-organizer/web/render.mjs";
import { extractSections, extractVariables, render } from "./prompt-render";

describe("parity with web/render.mjs", () => {
  const FIXTURES: Array<{ body: string; values: Record<string, string | undefined>; includes: string[] }> = [
    { body: "Hello {{NAME}}.", values: { NAME: "World" }, includes: [] },
    { body: "Hello {{NAME}}.", values: {}, includes: [] },
    { body: "No tokens here.", values: {}, includes: [] },
    {
      body: "Base. <!--OPTIONAL:s-->Extra {{DETAIL}}.<!--/OPTIONAL:s--> Tail.",
      values: { DETAIL: "info" },
      includes: ["s"],
    },
    {
      body: "Base. <!--OPTIONAL:s-->Extra {{DETAIL}}.<!--/OPTIONAL:s--> Tail.",
      values: {},
      includes: [],
    },
    { body: "<!--OPTIONAL:a-->x<!--/OPTIONAL:a-->", values: {}, includes: ["a"] },
    { body: "unterminated <!--OPTIONAL:a-->fence", values: {}, includes: ["a"] },
    { body: "{{}} malformed {{1BAD}} {{OK_ONE}}", values: { OK_ONE: "x" }, includes: [] },
  ];

  it("render produces identical output to the original for every fixture", () => {
    for (const { body, values, includes } of FIXTURES) {
      const a = original.render(body, values, includes);
      const b = render(body, values, includes);
      expect(b).toEqual(a);
    }
  });

  it("extractVariables and extractSections produce identical output to the original", () => {
    for (const { body } of FIXTURES) {
      expect(extractVariables(body)).toEqual(original.extractVariables(body));
      expect(extractSections(body)).toEqual(original.extractSections(body));
    }
  });

  it("fuzzed bodies produce identical output across both implementations", () => {
    const tokens = ["{{A}}", "{{B_2}}", "<!--OPTIONAL:x-->", "<!--/OPTIONAL:x-->", "<!--OPTIONAL:y-->", "<!--/OPTIONAL:y-->", "plain "];
    let seed = 42;
    function next() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    }
    for (let i = 0; i < 200; i += 1) {
      const length = 1 + (next() % 8);
      const body = Array.from({ length }, () => tokens[next() % tokens.length]).join("");
      const values = { A: "a-val", B_2: "b-val" };
      const includes = next() % 2 === 0 ? ["x"] : ["x", "y"];
      expect(render(body, values, includes)).toEqual(original.render(body, values, includes));
    }
  });
});

describe("render: own behavioral assertions", () => {
  it("substitutes every occurrence of a variable", () => {
    expect(render("{{A}} and {{A}} again", { A: "x" })).toEqual({ ok: true, text: "x and x again" });
  });

  it("an absent key is missing, but an empty-string value is NOT missing", () => {
    expect(render("{{A}}", {})).toEqual({ ok: false, missing: ["A"] });
    expect(render("{{A}}", { A: "" })).toEqual({ ok: true, text: "" });
  });

  it("a variable inside an excluded section is never required", () => {
    const body = "Base <!--OPTIONAL:s-->needs {{X}}<!--/OPTIONAL:s-->.";
    expect(render(body, {}, [])).toEqual({ ok: true, text: "Base ." });
  });

  it("sections resolve before variables substitute", () => {
    const body = "<!--OPTIONAL:s-->{{X}}<!--/OPTIONAL:s-->";
    expect(render(body, { X: "shown" }, ["s"])).toEqual({ ok: true, text: "shown" });
  });

  it("never substitutes partially when a variable is missing", () => {
    expect(render("{{A}} {{B}}", { A: "x" })).toEqual({ ok: false, missing: ["B"] });
  });
});
