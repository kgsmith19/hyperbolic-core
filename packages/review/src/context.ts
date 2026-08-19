/**
 * Assembles everything the reviewer is allowed to look at.
 *
 * All git access goes through an injected `runGit`, so every test in this
 * package runs without a repository, a network, or a subprocess. The default
 * implementation is the only thing here that touches the outside world.
 *
 * Two decisions worth stating outright:
 *
 * 1. Changed test files are included in FULL, not as diff hunks. Judging test
 *    quality means asking "could this test have failed before the change, for
 *    the right reason?" -- and that is unanswerable from a hunk. A hunk shows
 *    three added assertions; only the whole file shows that the fixture two
 *    hundred lines up already hard-codes the value being asserted.
 *
 * 2. Truncation is always VISIBLE. Silently dropping the tail of a diff makes
 *    the reviewer confidently review a change it never saw, and the verdict
 *    would carry no trace of the omission. Every cut leaves a literal
 *    `[truncated N chars]` marker in the text the model reads, so a reviewer
 *    that was shown half a diff can say so.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Per-input character cap. Applied to the diff and to each file's text. */
export const PER_INPUT_CHAR_CAP = 120_000;

/** Cap across everything handed to the model, after per-input capping. */
export const TOTAL_CHAR_CAP = 300_000;

/** Runs git and returns stdout. Injected so tests never shell out. */
export type RunGit = (args: string[]) => Promise<string>;

export interface ChangedTestFile {
  path: string;
  /** Whole-file text at `headSha`, possibly truncated with a visible marker. */
  contents: string;
}

export interface ReviewContext {
  baseSha: string;
  headSha: string;
  /** `git diff --unified=3 base...head`. */
  diff: string;
  changedFiles: string[];
  /** Full text of every changed file whose path looks like a test. */
  testFiles: ChangedTestFile[];
  issueBody: string;
  agentsMd: string;
  /**
   * The pull request's own comment thread, chronological, each entry
   * pre-formatted as "<author> (<timestamp>): <body>" by the caller. Empty
   * string on a first-round review, where there is nothing yet to have a
   * conversation about. Exactly as untrusted as `issueBody` -- fenced as
   * DATA the same way, never instructions -- since anyone who can comment on
   * the pull request can write into it.
   */
  conversation: string;
  /** True when any input was cut. Mirrors the in-text `[truncated]` markers. */
  truncated: boolean;
}

export interface GatherContextOptions {
  baseSha: string;
  headSha: string;
  issueBody: string;
  agentsMd: string;
  /** See `ReviewContext.conversation`. Defaults to "" (no prior dialogue). */
  conversation?: string;
  runGit?: RunGit;
  perInputCharCap?: number;
  totalCharCap?: number;
}

/**
 * Default `runGit`: spawns real git in the current working directory.
 * `execFile` (not a shell) so a branch or path containing shell metacharacters
 * is an argument, never something to interpret.
 */
export const defaultRunGit: RunGit = async (args) => {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

/**
 * Cuts `text` to `cap` characters, leaving a visible marker stating exactly how
 * much was removed. Returns the input unchanged when it fits.
 */
export function truncateWithMarker(text: string, cap: number): string {
  if (text.length <= cap) {
    return text;
  }
  const dropped = text.length - cap;
  return `${text.slice(0, cap)}\n\n[truncated ${dropped} chars]\n`;
}

/**
 * A path "looks like a test" when a `test`/`tests`/`spec`/`specs` segment
 * appears delimited by a path or filename separator -- so `tests/a.ts`,
 * `a.test.ts`, and `spec/b.ts` match, while `src/contest.ts` and
 * `src/inspector.ts` do not.
 */
export function looksLikeTestPath(path: string): boolean {
  return /(^|[/._-])(tests?|specs?)([/._-]|$)/i.test(path);
}

/**
 * Gather the diff, the changed-file list, and the full text of changed test
 * files for the range `baseSha...headSha`.
 */
export async function gatherContext(options: GatherContextOptions): Promise<ReviewContext> {
  const {
    baseSha,
    headSha,
    issueBody,
    agentsMd,
    conversation = "",
    runGit = defaultRunGit,
    perInputCharCap = PER_INPUT_CHAR_CAP,
    totalCharCap = TOTAL_CHAR_CAP,
  } = options;

  const range = `${baseSha}...${headSha}`;
  const rawDiff = await runGit(["diff", "--unified=3", range]);
  const rawNames = await runGit(["diff", "--name-only", range]);

  const changedFiles = rawNames
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const rawTestFiles: ChangedTestFile[] = [];
  for (const path of changedFiles.filter(looksLikeTestPath)) {
    // A test file deleted by this change has no text at head. That is not an
    // error -- a deletion is exactly the kind of oracle change this gate is
    // meant to notice -- so it is recorded as such and stays reviewable via
    // the diff.
    let contents: string;
    try {
      contents = await runGit(["show", `${headSha}:${path}`]);
    } catch {
      contents = "[file does not exist at head -- deleted or renamed by this change]";
    }
    rawTestFiles.push({ path, contents });
  }

  // `truncated` is tracked as an explicit flag rather than inferred by
  // comparing lengths afterwards: a cut of exactly the marker's own length
  // would leave the two strings the same size, and a truncation the verdict
  // fails to mention is the specific failure this whole block exists to
  // prevent.
  let truncated = false;

  // Per-input capping first, so one enormous file cannot consume the whole
  // budget and starve the diff.
  const cap = (text: string, limit: number): string => {
    if (text.length <= limit) {
      return text;
    }
    truncated = true;
    return truncateWithMarker(text, limit);
  };

  const diff = cap(rawDiff, perInputCharCap);
  const cappedIssueBody = cap(issueBody, perInputCharCap);
  const cappedAgentsMd = cap(agentsMd, perInputCharCap);
  const cappedConversation = cap(conversation, perInputCharCap);
  const cappedTestFiles = rawTestFiles.map((file) => ({
    path: file.path,
    contents: cap(file.contents, perInputCharCap),
  }));

  // Then the total budget, spent in priority order: the diff is the thing
  // under review and is paid for first; test files are next because test
  // quality is this gate's sharpest question; the Issue and AGENTS.md are the
  // oracles and are smallest. The conversation is spent last, alongside them
  // -- it matters for continuity across rounds, but a first-round review has
  // none of it, and a truncated diff is a worse loss than a truncated
  // rebuttal.
  let remaining = totalCharCap;
  const spend = (text: string): string => {
    if (text.length <= remaining) {
      remaining -= text.length;
      return text;
    }
    const budget = Math.max(remaining, 0);
    remaining = 0;
    truncated = true;
    return truncateWithMarker(text, budget);
  };

  const budgetedDiff = spend(diff);
  const budgetedTestFiles = cappedTestFiles.map((file) => ({
    path: file.path,
    contents: spend(file.contents),
  }));
  const budgetedIssueBody = spend(cappedIssueBody);
  const budgetedAgentsMd = spend(cappedAgentsMd);
  const budgetedConversation = spend(cappedConversation);

  return {
    baseSha,
    headSha,
    diff: budgetedDiff,
    changedFiles,
    testFiles: budgetedTestFiles,
    issueBody: budgetedIssueBody,
    agentsMd: budgetedAgentsMd,
    conversation: budgetedConversation,
    truncated,
  };
}
