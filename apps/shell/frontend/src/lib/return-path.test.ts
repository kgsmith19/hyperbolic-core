// sanitizeReturnPath is the one function standing between an attacker-
// influenceable `?return=` query param and react-router's `navigate()`
// (SH-2b's deep-link return, open-redirect guarded). Exercised adversarially
// here, independent of any component or router.
import { describe, expect, it } from "vitest";
import { sanitizeReturnPath } from "./return-path";

describe("sanitizeReturnPath: legitimate same-origin targets pass through unchanged", () => {
  it.each([
    ["/tools", "/tools"],
    ["/tools?tab=registry", "/tools?tab=registry"],
    ["/prompts/", "/prompts/"],
    ["/", "/"],
    ["/settings", "/settings"],
  ])("%s -> %s", (input, expected) => {
    expect(sanitizeReturnPath(input)).toBe(expected);
  });
});

describe("sanitizeReturnPath: falls back to / for anything falsy or absent", () => {
  it.each([null, undefined, ""])("%s -> /", (input) => {
    expect(sanitizeReturnPath(input)).toBe("/");
  });
});

describe("sanitizeReturnPath: rejects targets that would leave this document/origin (open-redirect guard)", () => {
  it.each([
    "//evil.example.com",
    "//evil.example.com/tools",
    "https://evil.example.com",
    "http://evil.example.com/tools",
    "javascript:alert(1)",
    "tools", // no leading slash: relative to current path, not app-root-relative
    "../tools",
    " ",
    "/\\evil.example.com", // backslash normalization trick
    "/\\/evil.example.com",
])("%s -> /", (input) => {
    expect(sanitizeReturnPath(input)).toBe("/");
  });
});

describe("sanitizeReturnPath: never redirects back into the login route itself", () => {
  it.each(["/login", "/login/", "/login?return=%2Ftools", "/login?foo=bar"])("%s -> /", (input) => {
    expect(sanitizeReturnPath(input)).toBe("/");
  });

  it("does not false-positive on an unrelated route that merely starts with the same letters", () => {
    expect(sanitizeReturnPath("/loginhistory")).toBe("/loginhistory");
  });
});
