// 05-h section 6: the GitHub REST integration. Narrow by design (create-issue
// and the existence-check list only, per m3-06's own scope) -- no update,
// comment, close, or label-edit capability exists anywhere in this file,
// matching II-3's "the app can never touch that Issue again."

import { GithubSubmitError, type CreatedIssue, type IntakeSubmitErrorClass } from "./types.ts";

const API_VERSION = "2022-11-28";
const MARKER_SCAN_MAX_PAGES = 3;
const MARKER_SCAN_PER_PAGE = 100;
const SERVER_NETWORK_BACKOFFS_MS = [1_000, 4_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubHeaders(pat: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    ...extra,
  };
}

/** 05-h section 6.4's exact error taxonomy. Only ever called on a non-ok
 * response (a thrown/rejected fetch -- DNS, timeout, connection reset -- is
 * classified `server_network` by its caller directly, never reaching here). */
function classify(status: number, headers: Headers): IntakeSubmitErrorClass {
  if (status === 401) {
    return "auth_invalid";
  }
  if (status === 403 || status === 429) {
    const remaining = headers.get("x-ratelimit-remaining");
    const retryAfter = headers.get("retry-after");
    if (remaining === "0" || retryAfter !== null) {
      return "rate_limited";
    }
    // A 403 that isn't rate-limit-shaped (e.g. PAT lacks repo access) reads
    // exactly like "repo unreachable" from the caller's perspective -- 05-h's
    // own row for 404 already covers "PAT lacks repo access" by name.
    return "repo_unreachable";
  }
  if (status === 404) {
    return "repo_unreachable";
  }
  if (status === 410) {
    return "issues_disabled";
  }
  if (status === 422) {
    return "validation";
  }
  return "server_network";
}

function retryDelayMs(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) {
      return Math.max(0, resetMs - Date.now());
    }
  }
  return 1_000;
}

/** Runs one GitHub REST call with 05-h section 6.4's exact retry policy:
 * rate-limited waits per header then retries once; server/network retries
 * twice with fixed 1s/4s backoff; every other class fails immediately, no
 * retry. Never resolves an error silently -- always throws GithubSubmitError
 * with the classified class attached, so a caller's catch block is the one
 * place row-state (II-5: no write-back on any failure) is enforced. */
async function callWithRetry(doCall: () => Promise<Response>): Promise<Response> {
  let rateLimitRetried = false;
  let networkAttempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await doCall();
    } catch (err) {
      if (networkAttempt < SERVER_NETWORK_BACKOFFS_MS.length) {
        await sleep(SERVER_NETWORK_BACKOFFS_MS[networkAttempt]!);
        networkAttempt += 1;
        continue;
      }
      throw new GithubSubmitError(
        "server_network",
        `GitHub request failed after retries: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (res.ok) {
      return res;
    }
    const errorClass = classify(res.status, res.headers);
    if (errorClass === "rate_limited" && !rateLimitRetried) {
      rateLimitRetried = true;
      await sleep(retryDelayMs(res.headers));
      continue;
    }
    if (errorClass === "server_network" && networkAttempt < SERVER_NETWORK_BACKOFFS_MS.length) {
      await sleep(SERVER_NETWORK_BACKOFFS_MS[networkAttempt]!);
      networkAttempt += 1;
      continue;
    }
    const body = await res.text().catch(() => "");
    throw new GithubSubmitError(
      errorClass,
      `GitHub ${res.status}: ${body.slice(0, 500) || res.statusText}`
    );
  }
}

/** 05-h section 6.5 step 2: scans up to 3 pages of the from-idea-intake
 * label for the exact idempotency marker, in list order. Returns the found
 * issue or null -- never creates, never paginates past the cap (an operator
 * with more than 300 from-idea-intake issues on one repo is out of scope for
 * V1, matching the spec's own stated bound). */
export async function findIssueByMarker(
  pat: string,
  ownerRepo: string,
  marker: string
): Promise<CreatedIssue | null> {
  for (let page = 1; page <= MARKER_SCAN_MAX_PAGES; page += 1) {
    const url =
      `https://api.github.com/repos/${ownerRepo}/issues` +
      `?state=all&labels=from-idea-intake&per_page=${MARKER_SCAN_PER_PAGE}&page=${page}`;
    const res = await callWithRetry(() => fetch(url, { headers: githubHeaders(pat) }));
    const issues = (await res.json()) as Array<{ number: number; html_url: string; body: string | null }>;
    const match = issues.find((issue) => (issue.body ?? "").includes(marker));
    if (match) {
      return { number: match.number, htmlUrl: match.html_url };
    }
    if (issues.length < MARKER_SCAN_PER_PAGE) {
      // Short page: no more results exist, no point requesting page + 1.
      return null;
    }
  }
  return null;
}

export async function createIssue(
  pat: string,
  ownerRepo: string,
  fields: { title: string; body: string; labels: string[] }
): Promise<CreatedIssue> {
  const res = await callWithRetry(() =>
    fetch(`https://api.github.com/repos/${ownerRepo}/issues`, {
      method: "POST",
      headers: githubHeaders(pat, { "Content-Type": "application/json" }),
      body: JSON.stringify({ title: fields.title, body: fields.body, labels: fields.labels }),
    })
  );
  const created = (await res.json()) as { number: number; html_url: string };
  return { number: created.number, htmlUrl: created.html_url };
}
