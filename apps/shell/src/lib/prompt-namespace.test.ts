// 05-d-prompt-organizer.md section 5's namespace grammar:
// ^[a-z0-9-]+(/[a-z0-9-]+){1,2}$ -- exactly 2 or 3 lowercase-kebab segments.
// This predicate gates the one real safety property this issue's rename
// refusal depends on: get it wrong in either direction and either a
// namespaced (API-shaped) name becomes renamable, or a legacy personal
// title becomes stuck un-renamable.
import { describe, expect, it } from "vitest";
import { isNamespacedTitle } from "./prompt-namespace";

describe("isNamespacedTitle", () => {
  it("accepts every real example from section 3's taxonomy table", () => {
    for (const title of [
      "brain/task-contract",
      "coding/system/kernel-run",
      "coding/review/simplification",
      "planning/spec/issue-outcome",
      "intake/optimize/idea",
      "lifeos/chat/system",
      "research/deep-dive",
      "ops/runbooks/deploy-verify",
    ]) {
      expect(isNamespacedTitle(title)).toBe(true);
    }
  });

  it("rejects a bare single-segment title (no slash at all)", () => {
    expect(isNamespacedTitle("my-personal-prompt")).toBe(false);
  });

  it("rejects a legacy personal title with spaces or capitals", () => {
    expect(isNamespacedTitle("My Personal Prompt")).toBe(false);
    expect(isNamespacedTitle("Draft: v2")).toBe(false);
  });

  it("rejects more than 3 segments (grammar caps at 2 slashes)", () => {
    expect(isNamespacedTitle("a/b/c/d")).toBe(false);
  });

  it("rejects a trailing or leading slash", () => {
    expect(isNamespacedTitle("brain/task-contract/")).toBe(false);
    expect(isNamespacedTitle("/brain/task-contract")).toBe(false);
  });

  it("rejects an empty segment (double slash)", () => {
    expect(isNamespacedTitle("brain//task-contract")).toBe(false);
  });

  it("rejects uppercase letters even in an otherwise-valid shape", () => {
    expect(isNamespacedTitle("Brain/Task-Contract")).toBe(false);
  });

  it("accepts digits within a segment", () => {
    expect(isNamespacedTitle("coding/system/kernel-run-v2")).toBe(true);
  });
});
