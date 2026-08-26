/**
 * Contract for `@hyperbolic/review` -- the adversarial LLM PR-review gate.
 *
 * Everything the gate produces is one `ReviewVerdict`. It is the only thing
 * the CLI serializes, the only thing CI reads, and the only thing that decides
 * the exit code. Keeping it a plain data shape (no methods, no classes) is
 * deliberate: it is round-tripped through JSON at every boundary -- the
 * model's tool call in, the `--out` file out -- and anything that does not
 * survive `JSON.parse(JSON.stringify(x))` does not belong on it.
 */

import type { Provider } from "@hyperbolic/llm";

export type { Provider };

/** Raw provider identifiers accepted for the coding-agent harness role. */
export type BuilderProvider = Provider;

/**
 * `blocking` fails the gate; `advisory` is reported and does not. There is no
 * third "info" tier on purpose: a finding either changes the merge decision or
 * it does not, and a tier that does neither invites reviewers to file noise.
 */
export type Severity = "blocking" | "advisory";

/**
 * One reviewer objection.
 *
 * `evidence` and `citation` are what separate a finding from an opinion, and
 * validate.ts discards any finding missing either. `evidence` must quote the
 * actual code or test text under objection; `citation` must name either a
 * specific acceptance criterion from the linked Issue or a named AGENTS.md
 * section. A reviewer that cannot point at both is expressing a preference,
 * and a preference must never block a pull request.
 */
export interface Finding {
  severity: Severity;
  /** Short bucket, e.g. "test-quality", "acceptance-criteria", "lean". */
  category: string;
  /** Repository-relative path the finding is about, when it has one. */
  file?: string;
  /** 1-based line within `file`, when the finding is line-specific. */
  line?: number;
  /** The objection stated as a falsifiable claim about the change. */
  claim: string;
  /** Verbatim quoted code or test text that makes `claim` checkable. */
  evidence: string;
  /** The concrete change being asked for, not a restatement of `claim`. */
  requestedChange: string;
  /** An Issue acceptance criterion, or a named AGENTS.md section. */
  citation: string;
  /**
   * Orthogonal to `severity`, not a third tier of it -- `severity` still
   * only ever means "changes the merge decision or not", exactly as
   * documented above. `outOfScope` answers a different question: the
   * reviewer and the dev agent deliberated in the pull request's dialogue
   * thread and agreed this finding, real as it is, belongs in a follow-up
   * Issue rather than blocking the current one. It is reachable only
   * through that deliberation -- never true on a first-round review, since
   * there is nothing yet to have agreed to -- and validate.ts excludes an
   * out-of-scope finding from the blocking count while still reporting it
   * for transparency. Absent or `false` changes nothing about today's
   * behavior.
   */
  outOfScope?: boolean;
  /**
   * The inverse of `outOfScope`: the reviewer proposes that this finding,
   * real but not raised as `blocking` this round, become its own tracked
   * Issue that blocks the pull request -- but only once the dev side agrees.
   * `confirmed` is reachable only through the same dialogue deliberation
   * `outOfScope` requires, just for the opposite direction: never true on the
   * round the proposal was first raised. This field alone never blocks or
   * files anything -- it is additive data for the caller (the dialogue
   * workflow) to act on once `confirmed` is true.
   */
  proposedBlockingIssue?: {
    title: string;
    body: string;
    confirmed?: boolean;
  };
}

/**
 * The gate's whole output.
 *
 * `discarded` is carried rather than dropped so a human can see what the model
 * tried to say and why it did not count -- silently swallowing an uncited
 * blocking finding would make the gate look like it found nothing, which is a
 * different (and misleading) statement than "it found something unusable".
 */
export interface ReviewVerdict {
  verdict: "pass" | "block";
  /** Findings that carry both evidence and a citation. */
  findings: Finding[];
  /** Findings rejected for missing evidence or citation. Never block. */
  discarded: Finding[];
  summary: string;
}

/**
 * Resolved run configuration. `builderProvider` is not used to call anything;
 * it exists solely so config.ts can refuse a reviewer from the same provider
 * family as the code's author.
 */
export interface ReviewConfig {
  reviewerProvider: Provider;
  reviewerModel: string;
  builderProvider: BuilderProvider;
  maxTokens: number;
  timeoutMs: number;
}
