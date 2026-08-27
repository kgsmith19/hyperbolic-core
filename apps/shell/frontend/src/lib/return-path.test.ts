// sanitizeReturnPath is the one function standing between an attacker-
// influenceable `?return=` query param and react-router's `navigate()`
// (SH-2b's deep-link return, open-redirect guarded). Exercised adversarially
// here, independent of any component or router.
import { describe, expect, it } from "vitest";
import { sanitizeReturnPath } from "./return-path";

const SHELL_ORIGIN = "https://shell.example";

describe("sanitizeReturnPath: legitimate same-origin targets pass through unchanged", () => {
  it.each([
    ["/tools", "/tools"],
    ["/tools?tab=registry", "/tools?tab=registry"],
    ["/prompts/", "/prompts/"],
    ["/", "/"],
    ["/settings", "/settings"],
    [
      "/life/capture?mode=quick#details",
      "/life/capture?mode=quick#details",
    ],
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
    ["protocol-relative", "//evil.example.com/tools"],
    ["absolute HTTPS", "https://evil.example.com/tools"],
    ["absolute HTTP", "http://evil.example.com/tools"],
    ["script scheme", "javascript:alert(1)"],
    ["backslash-normalized authority", "/\\evil.example.com/path"],
    ["slash-backslash-normalized authority", "/\\/evil.example.com/path"],
    ["tab-stripped authority", "/\t/evil.example.com/path"],
    ["carriage-return-stripped authority", "/\r/evil.example.com/path"],
    ["newline-stripped authority", "/\n/evil.example.com/path"],
  ])("%s resolves outside the Shell origin and falls back", (_label, input) => {
    // WHATWG URL parsing is the independent browser oracle: these strings do
    // not all look absolute before normalization, but they resolve off-origin.
    expect(new URL(input, SHELL_ORIGIN).origin).not.toBe(SHELL_ORIGIN);
    expect(sanitizeReturnPath(input)).toBe("/");
  });

  it.each([
    "tools", // no leading slash: relative to current path, not app-root-relative
    "../tools",
    " ",
    "/tools\u0000next",
    "/tools\u001fnext",
    "/tools\u007fnext",
  ])("%s -> /", (input) => {
    expect(sanitizeReturnPath(input)).toBe("/");
  });
});

describe("sanitizeReturnPath: never redirects back into the login route itself", () => {
  it.each([
    "/login",
    "/login/",
    "/login?return=%2Ftools",
    "/login?foo=bar",
    "/login#fragment",
    "/login?foo=bar#fragment",
    "/LOGIN#fragment",
    "/tools/../login?foo=bar#fragment",
  ])("%s -> /", (input) => {
    const browserPath = new URL(input, SHELL_ORIGIN).pathname.toLowerCase();
    expect(
      browserPath === "/login" || browserPath.startsWith("/login/"),
    ).toBe(true);
    expect(sanitizeReturnPath(input)).toBe("/");
  });

  it.each(["/loginhistory", "/login-help", "/login-help?next=1#form"])(
    "does not false-positive on %s",
    (input) => {
      expect(sanitizeReturnPath(input)).toBe(input);
    },
  );
});
