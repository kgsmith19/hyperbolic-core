// sanitizeReturnPath is the one function standing between an attacker-
// influenceable `?return=` query param and react-router's `navigate()`
// (SH-2b's deep-link return, open-redirect guarded). Exercised adversarially
// here without a component; WHATWG URL and React Router matching provide
// independent oracles for the two normalization boundaries.
import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router";
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
    [
      "/life/%FF?mode=quick#entry",
      "/life/%FF?mode=quick#entry",
    ],
    [
      "/life/entities/id%2Fwith%2Fslashes",
      "/life/entities/id%2Fwith%2Fslashes",
    ],
    ["/life%252Fcapture", "/life%252Fcapture"],
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
    [
      "protocol-relative sentinel collision",
      "//shell.invalid/looks-like-the-sentinel",
    ],
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

describe("sanitizeReturnPath: rejects server-invalid normalized paths", () => {
  it.each([
    ["above-root decoded traversal", "/%2e%2e%2Flife%2Fcapture"],
    ["decoded NUL", "/life%2F%00?mode=quick#entry"],
    ["non-hex percent escape", "/life/%zz?mode=quick#entry"],
    ["short percent escape", "/life/%2"],
    ["terminal percent", "/life/%"],
  ])("%s falls back to /", (_label, input) => {
    expect(sanitizeReturnPath(input)).toBe("/");
  });
});

describe("sanitizeReturnPath: rejects document targets the destination bundle cannot mount", () => {
  it.each([
    ["encoded zone root", "/%6cife/capture"],
    ["encoded bare zone root", "/%6cife"],
    ["encoded separator", "/life%2Fcapture"],
    ["encoded trailing separator", "/life%2F"],
    ["encoded root and separator", "/%6cife%2Fcapture"],
    ["encoded leading separator", "/%2Flife/capture"],
    [
      "encoded traversal into the zone",
      "/shell/%2e%2e%2Flife%2Fcapture?mode=quick#entry",
    ],
  ])("%s falls back to /", (_label, input) => {
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
    "/%6cogin?return=%2Flife%2Fcapture",
    "/%6Cogin#fragment",
  ])("%s -> /", (input) => {
    const browserPath = new URL(input, SHELL_ORIGIN).pathname;
    // The actual router matcher is the independent loop oracle. In
    // particular, it decodes percent-encoded path characters that the URL
    // object's pathname intentionally leaves encoded.
    expect(matchRoutes([{ path: "/login" }], browserPath)).not.toBeNull();
    expect(sanitizeReturnPath(input)).toBe("/");
  });

  it.each(["/loginhistory", "/login-help", "/login-help?next=1#form"])(
    "does not false-positive on %s",
    (input) => {
      expect(sanitizeReturnPath(input)).toBe(input);
    },
  );
});
