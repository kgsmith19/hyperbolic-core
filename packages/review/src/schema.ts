/**
 * The single tool the reviewer is allowed to answer through.
 *
 * The model gets exactly one tool and `toolChoice` forces it, so the reviewer
 * cannot reply in prose. That is not a convenience -- it is the mechanism that
 * makes the verdict machine-checkable. Free-text review output has to be
 * parsed by heuristics, and heuristics on model prose are exactly the "vibes"
 * this gate exists to eliminate. A schema also makes `evidence` and `citation`
 * structurally required per finding, so an unsupported objection is visible as
 * a missing field rather than hidden inside a paragraph.
 *
 * The schema is a *forcing function*, not a guarantee: providers do not all
 * validate `required` strictly, and a model can still emit an empty string for
 * a required field. validate.ts re-checks everything this file declares.
 */

import type { ToolChoice, ToolDef } from "@hyperbolic/llm";

export const SUBMIT_REVIEW_TOOL_NAME = "submit_review";

/** JSON Schema for one `Finding`. */
const findingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    severity: {
      type: "string",
      enum: ["blocking", "advisory"],
      description:
        "blocking = this must change before merge. advisory = worth saying, does not fail the gate. Use blocking only when you can name the violated acceptance criterion or AGENTS.md rule.",
    },
    category: {
      type: "string",
      description: "Short bucket, e.g. acceptance-criteria, test-first, test-quality, coverage-bloat, lean, injection.",
    },
    file: {
      type: "string",
      description: "Repository-relative path this finding is about, when it has one.",
    },
    line: {
      type: "integer",
      description: "1-based line number within `file`, when the finding is line-specific.",
    },
    claim: {
      type: "string",
      description: "The objection stated as a single falsifiable claim about this change.",
    },
    evidence: {
      type: "string",
      description:
        "Verbatim quoted code or test text from the diff or a changed file that makes `claim` checkable by a reader who does not trust you. Required. A finding without a quote is discarded.",
    },
    requestedChange: {
      type: "string",
      description: "The concrete change being asked for. Not a restatement of `claim`.",
    },
    citation: {
      type: "string",
      description:
        "Either a specific acceptance criterion from the linked Issue (quote or number it) or a named AGENTS.md section (e.g. 'AGENTS.md > Test quality'). Required. A finding without a citation is discarded.",
    },
    outOfScope: {
      type: "boolean",
      description:
        "True only when the pull request's own dialogue thread shows the dev agent proposing this exact finding belongs in a separate, non-blocking Issue instead of blocking this pull request, and you agree. Never true on a first-round review -- there is nothing yet to have agreed to. Does not change `severity`; it only excludes an otherwise-blocking finding from the block decision, and the finding still gets reported.",
    },
  },
  required: ["severity", "category", "claim", "evidence", "requestedChange", "citation"],
} as const;

/**
 * The `submit_review` tool definition. Its schema forces the exact
 * `ReviewVerdict` shape: verdict enum, findings array with every required
 * field per finding, and a summary.
 */
export const submitReviewTool: ToolDef = {
  name: SUBMIT_REVIEW_TOOL_NAME,
  description:
    "Submit the complete review verdict. This is the ONLY way to answer. Report 'block' if and only if at least one finding is severity=blocking AND carries both concrete quoted evidence and a citation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "block"],
        description: "block if and only if at least one blocking finding is fully evidenced and cited; otherwise pass.",
      },
      findings: {
        type: "array",
        description: "Every objection, blocking and advisory. Empty array when the change is clean.",
        items: findingSchema,
      },
      summary: {
        type: "string",
        description:
          "A few sentences: what the change claims to do, whether the tests could have failed before it, and the single most important objection if any.",
      },
    },
    required: ["verdict", "findings", "summary"],
  },
};

/**
 * Forces the model to call `submit_review`. `"auto"` would let a model answer
 * in prose whenever it felt uncertain -- which is precisely the case where an
 * unstructured, unparseable answer does the most damage.
 */
export const submitReviewToolChoice: ToolChoice = { name: SUBMIT_REVIEW_TOOL_NAME };
