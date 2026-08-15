// PostgREST access via the CALLER's own bearer token, never a service-role
// key. owner_rw RLS (apps/toolbelt/apps/idea-intake/backend/supabase/migrations/
// 20260813002605_intake_create_schema.sql) already restricts every row to
// the platform owner; since /api/intake/submit only ever runs after
// verifyOwnerSession() (auth.ts) has proven the caller IS the owner, riding
// the caller's JWT through PostgREST gets the same authorization boundary
// the browser would get directly, with no new credential this service has
// to hold or leak. Content-Profile/Accept-Profile select the `intake`
// schema, PostgREST's multi-schema switching header (pgrst.db_schemas
// already lists it, see the migration's own comment).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

interface RawIdeaRow {
  status: "draft" | "idea" | "submitted_to_github";
  title: string;
  problem: string;
  outcome: string;
  notes: string;
  confidence: "low" | "medium" | "high";
  source: string;
  target_repo: string | null;
  idempotency_key: string;
  github_issue_number: number | null;
  github_issue_url: string | null;
  parent: { github_issue_url: string | null } | null;
}

export interface IdeaForSubmit {
  status: "draft" | "idea" | "submitted_to_github";
  title: string;
  problem: string;
  outcome: string;
  notes: string;
  confidence: "low" | "medium" | "high";
  source: string;
  targetRepo: string | null;
  idempotencyKey: string;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  parentGithubIssueUrl: string | null;
}

const SELECT_COLUMNS =
  "status,title,problem,outcome,notes,confidence,source,target_repo,idempotency_key," +
  "github_issue_number,github_issue_url,parent:parent_idea_id(github_issue_url)";

/** Reads exactly the columns 05-h section 6 needs, embedding the parent row's
 * issue URL in one round trip (section 6.2's body template's "Derived from"
 * line). Resolves null when the row doesn't exist or RLS hides it -- both
 * indistinguishable from the caller's side by design (no row-existence
 * oracle for a non-owner, though that path is already unreachable: the
 * route only calls this after verifyOwnerSession). */
export async function fetchIdeaForSubmit(
  supabaseUrl: string,
  supabasePublishableKey: string,
  bearerToken: string,
  ideaId: string
): Promise<IdeaForSubmit | null> {
  if (!isValidUuid(ideaId)) {
    return null;
  }
  const res = await fetch(
    `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/idea?id=eq.${encodeURIComponent(ideaId)}&select=${SELECT_COLUMNS}`,
    {
      headers: {
        apikey: supabasePublishableKey,
        Authorization: `Bearer ${bearerToken}`,
        "Accept-Profile": "intake",
      },
    }
  );
  if (!res.ok) {
    return null;
  }
  const rows = (await res.json()) as RawIdeaRow[];
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    status: row.status,
    title: row.title,
    problem: row.problem,
    outcome: row.outcome,
    notes: row.notes,
    confidence: row.confidence,
    source: row.source,
    targetRepo: row.target_repo,
    idempotencyKey: row.idempotency_key,
    githubIssueNumber: row.github_issue_number,
    githubIssueUrl: row.github_issue_url,
    parentGithubIssueUrl: row.parent?.github_issue_url ?? null,
  };
}

/** 05-h section 6.5 step 4: the single write-back UPDATE -- but NOT a plain
 * PostgREST PATCH. PR #8's own security review, Finding 8
 * (20260814040000_intake_mark_submitted_to_github_rpc.sql), already revoked
 * `authenticated`'s UPDATE grant on github_issue_number/github_issue_url/
 * submitted_at (a client could otherwise forge a fake submission) and
 * replaced it with `intake.mark_submitted_to_github(p_idea_id,
 * p_issue_number, p_issue_url)`, a SECURITY DEFINER RPC grantable only to
 * `service_role`. That migration's own comment names this exactly: "a
 * follow-up Issue owns actually building the GitHub-Issue-creation service
 * that will hold that key and call this RPC" -- this is that service. The
 * caller's own JWT (used for every read in this file) cannot perform this
 * write; `serviceRoleKey` is a distinct, far more powerful credential this
 * one call requires, injected only into this process (see config.ts) and
 * never derived from an incoming request. The `idea_guard_update` trigger
 * still enforces the state machine unconditionally inside the RPC (not
 * bypassed by SECURITY DEFINER -- triggers fire regardless of role), so a
 * caller bug here fails loudly in Postgres rather than silently corrupting
 * state. Returns true only on a successful RPC response; false (never
 * throws) on any other outcome, so the submit orchestration can treat
 * "write-back didn't provably happen" as a failure without parsing a
 * specific error shape. */
export async function writeBackSubmitted(
  supabaseUrl: string,
  serviceRoleKey: string,
  ideaId: string,
  issue: { number: number; htmlUrl: string }
): Promise<boolean> {
  if (!isValidUuid(ideaId)) {
    return false;
  }
  const res = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/mark_submitted_to_github`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Profile": "intake",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_idea_id: ideaId,
      p_issue_number: issue.number,
      p_issue_url: issue.htmlUrl,
    }),
  });
  return res.ok;
}
