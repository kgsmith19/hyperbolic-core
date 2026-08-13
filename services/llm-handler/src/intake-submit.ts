// 05-h section 6.5 + section 9: the submit orchestration. Never throws --
// every path resolves a SubmitOutcome so the route layer has one place to
// map outcomes to HTTP responses, and so a bug here can never leave a
// request hanging without a response.

import { findIssueByMarker, createIssue } from "./github-client.ts";
import { fetchIdeaForSubmit, writeBackSubmitted, type IdeaForSubmit } from "./postgrest.ts";
import { GithubSubmitError, type SubmitOutcome } from "./types.ts";

export interface SubmitDeps {
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly serviceRoleKey: string;
  readonly githubIntakePat: string;
}

function buildMarker(ideaId: string, idempotencyKey: string): string {
  return `<!-- idea-intake:v1 idea=${ideaId} key=${idempotencyKey} -->`;
}

function buildBody(idea: IdeaForSubmit, marker: string): string {
  const derivedLine = idea.parentGithubIssueUrl ? `Derived from: ${idea.parentGithubIssueUrl}\n` : "";
  return (
    `## Problem\n${idea.problem}\n\n` +
    `## Desired outcome\n${idea.outcome}\n\n` +
    `## Notes\n${idea.notes}\n\n` +
    `Confidence: ${idea.confidence}. Source: ${idea.source}.\n` +
    `${derivedLine}\n` +
    `${marker}\n`
  );
}

/** 05-h section 7's label scheme. `from-idea-intake` and `derived` are
 * fully realized (both are derivable from columns intake.idea actually
 * has). `type` (FEAT/BUG/CHORE) and `component` are NOT applied: the
 * m3-05 schema this API reads from has no column to source either from --
 * section 7 describes them as "chosen in the editor," but no editor exists
 * yet (m3-07) and no column exists to hold that choice even if it did.
 * Applying a fixed always-FEAT label with no real editor choice behind it
 * would misrepresent every submission as a deliberate classification it
 * never was, so this is left as a known, explicitly-flagged gap rather than
 * a fabricated default -- see the m3-06 planning issue's amended scope note
 * for the tracked follow-up (new intake.idea columns + m3-07 editor
 * fields). */
function buildLabels(idea: IdeaForSubmit): string[] {
  const labels = ["from-idea-intake"];
  if (idea.parentGithubIssueUrl) {
    labels.push("derived");
  }
  return labels;
}

async function doSubmit(deps: SubmitDeps, bearerToken: string, ideaId: string): Promise<SubmitOutcome> {
  const idea = await fetchIdeaForSubmit(deps.supabaseUrl, deps.supabasePublishableKey, bearerToken, ideaId);
  if (!idea) {
    return { kind: "error", errorClass: "validation", message: "idea not found or not visible to this session" };
  }

  // Sequence step "already submitted_to_github" (05-h section 9): a 200
  // no-op, no GitHub call, per the idempotency algorithm's step 1.
  if (idea.status === "submitted_to_github") {
    return {
      kind: "already_submitted",
      issueNumber: idea.githubIssueNumber!,
      issueUrl: idea.githubIssueUrl!,
    };
  }

  // Sequence step "status = draft": II-1, promote first.
  if (idea.status === "draft") {
    return { kind: "draft_not_promoted" };
  }

  // status === "idea" from here. repo_required_beyond_draft's CHECK
  // constraint already guarantees target_repo is set once status left
  // 'draft' -- this is defense in depth, not a reachable path today.
  if (!idea.targetRepo) {
    return { kind: "error", errorClass: "validation", message: "idea has no target_repo" };
  }

  const marker = buildMarker(ideaId, idea.idempotencyKey);
  try {
    let issue = await findIssueByMarker(deps.githubIntakePat, idea.targetRepo, marker);
    if (!issue) {
      issue = await createIssue(deps.githubIntakePat, idea.targetRepo, {
        title: idea.title,
        body: buildBody(idea, marker),
        labels: buildLabels(idea),
      });
    }

    const wroteBack = await writeBackSubmitted(deps.supabaseUrl, deps.serviceRoleKey, ideaId, {
      number: issue.number,
      htmlUrl: issue.htmlUrl,
    });
    if (!wroteBack) {
      // 05-h section 6.4: "a failed submit never partially transitions."
      // The Issue may now exist with the row still at status='idea' -- this
      // is the exact crash-recovery window the marker scan exists for; the
      // next submit call finds it and completes the write-back without a
      // second create.
      return {
        kind: "error",
        errorClass: "server_network",
        message: "GitHub issue exists but the database write-back did not confirm; retry is safe",
      };
    }
    return { kind: "submitted", issueNumber: issue.number, issueUrl: issue.htmlUrl };
  } catch (err) {
    if (err instanceof GithubSubmitError) {
      return { kind: "error", errorClass: err.class, message: err.message };
    }
    return {
      kind: "error",
      errorClass: "server_network",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// 05-h section 6.5 step 5: "double-submit race in one process is serialized
// per idea id." Each idea id gets its own promise chain so two
// near-simultaneous submits for the SAME idea never both pass the
// existence check before either writes back (which would create two
// Issues); submits for DIFFERENT ideas run fully concurrently. Cross-process
// safety (the actual crash-recovery case) is the marker scan plus the
// unique index, independent of this in-memory lock.
const chains = new Map<string, Promise<SubmitOutcome>>();

export async function submitIdea(deps: SubmitDeps, bearerToken: string, ideaId: string): Promise<SubmitOutcome> {
  const previous = (chains.get(ideaId) ?? Promise.resolve()).then(
    () => undefined,
    () => undefined
  );
  const task = previous.then(() => doSubmit(deps, bearerToken, ideaId));
  chains.set(ideaId, task);
  try {
    return await task;
  } finally {
    if (chains.get(ideaId) === task) {
      chains.delete(ideaId);
    }
  }
}
