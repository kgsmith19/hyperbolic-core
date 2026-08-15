// Idea Intake's LLM optimize flow (m4-06, docs/planning/05-h-idea-intake.md
// section 5). Two backends, mirroring intake.ts's own split:
//
// 1. rpc/get_prompt (prompt schema, m4-03) fetches and renders the named
//    "idea-intake/optimize-v1" starter prompt with this idea's own fields
//    substituted server-side -- the caller's own session JWT, same manual
//    apikey/Authorization/*-Profile header shape as every other PostgREST
//    call in this app (never the supabase-js query builder, and never
//    packages/llm's createPromptClient: that barrel also re-exports the
//    three provider drivers, which would drag @anthropic-ai/sdk et al into
//    this bundle for zero benefit -- see packages/llm/src/index.ts's own
//    header comment and apps/shell/frontend/src/lib/prompts.ts's identical
//    "deliberately NOT... packages/llm" precedent).
// 2. POST /api/v1/complete (services/llm-handler, m4-05) runs the actual
//    completion through the general-purpose handler -- platformClient.fetch
//    (authedFetch), the same same-origin-verified, session-token-attaching
//    call intake.ts's submitIdea already uses for /api/intake/submit.
//
// II-4: this file never touches a provider API key or the Brain key -- it
// only ever calls Handler A's HTTP surface with the operator's own session.
import { platformClient, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./session";
import { accessToken } from "./postgrest";
import type { Confidence, Idea } from "./intake";

export interface OptimizedDraft {
  title: string;
  problem: string;
  outcome: string;
  notes: string;
  confidence: Confidence;
}

export interface OptimizeResult {
  draft: OptimizedDraft;
  handlerRunId: string;
  model: string;
}

const PROMPT_NAME = "idea-intake/optimize-v1";
// Judgment call (flagged per this repo's own convention for an unspecified
// detail): 08-llm-handlers.md's LlmRequest.model contract is "never
// defaulted silently" -- Handler A will not pick a model on this caller's
// behalf, and no config surface for provider/model selection exists
// anywhere in Idea Intake yet. claude-sonnet-5 is used here: a structured
// JSON-drafting task (05-h section 5's own prompt), not a task that needs
// the largest available model.
const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 30_000;


async function getOptimizePrompt(variables: Record<string, string>): Promise<string> {
  const token = await accessToken("optimize-client");
  const res = await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/get_prompt`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Profile": "prompt",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_name: PROMPT_NAME, p_values: variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`optimize-client: get_prompt failed with ${res.status}${body ? `: ${body}` : ""}`);
  }
  const data = (await res.json()) as { text: string };
  return data.text;
}

/** The prompt instructs the model to "produce exactly this JSON shape and
 * nothing else", but is parsed defensively: a code-fenced or
 * prose-wrapped response still parses by extracting the outermost {...}
 * span rather than requiring the entire response to be bare JSON. */
function parseOptimizedDraft(text: string): OptimizedDraft {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("optimize-client: model response did not contain a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`optimize-client: model response was not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const { title, problem, outcome, notes, confidence } = obj;
  if (
    typeof title !== "string" ||
    typeof problem !== "string" ||
    typeof outcome !== "string" ||
    typeof notes !== "string" ||
    (confidence !== "low" && confidence !== "medium" && confidence !== "high")
  ) {
    throw new Error("optimize-client: model response did not match the expected draft shape");
  }
  return { title, problem, outcome, notes, confidence };
}

async function completeOptimizePrompt(promptText: string, runRef: string): Promise<{ text: string; model: string }> {
  const res = await platformClient.fetch("/api/v1/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "anthropic",
      model: MODEL,
      messages: [{ role: "user", content: promptText }],
      maxTokens: MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
      metadata: { callerApp: "idea-intake", purpose: "optimize-idea", runRef },
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(`optimize-client: Handler A returned ${res.status}${body ? `: ${body.message ?? body.error ?? ""}` : ""}`);
  }
  const completion = (await res.json()) as { text: string | null; model: string };
  if (!completion.text) {
    throw new Error("optimize-client: Handler A returned no text");
  }
  return { text: completion.text, model: completion.model };
}

/** Append-only (20260813002605_intake_create_schema.sql: `grant select,
 * insert on intake.optimization` -- no update grant exists, by design).
 * output_idea_id is left null here: at the moment the LLM call completes,
 * the caller has not yet decided whether to apply the draft in place or
 * create a derivative (that decision, and the resulting write, happens
 * later as a distinct user action -- see editor.tsx's OptimizeModal). One
 * row is appended per optimize call regardless of what happens next, which
 * is the more robust reading of 05-h section 5's "each call appends one
 * intake.optimization row either way": the LLM call itself already
 * happened and must be attributed even if the user discards the draft. */
async function logOptimization(inputIdeaId: string, model: string, handlerRunId: string): Promise<void> {
  const token = await accessToken("optimize-client");
  const res = await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/optimization`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Profile": "intake",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      input_idea_id: inputIdeaId,
      prompt_name: PROMPT_NAME,
      model,
      handler_run_id: handlerRunId,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`optimize-client: logging the optimization failed with ${res.status}${body ? `: ${body}` : ""}`);
  }
}

export async function optimizeIdea(idea: Idea): Promise<OptimizeResult> {
  const runRef = crypto.randomUUID();
  const promptText = await getOptimizePrompt({
    TITLE: idea.title,
    PROBLEM: idea.problem,
    OUTCOME: idea.outcome,
    NOTES: idea.notes,
    TARGET_REPO: idea.targetRepo ?? "",
  });
  const completion = await completeOptimizePrompt(promptText, runRef);
  const draft = parseOptimizedDraft(completion.text);
  await logOptimization(idea.id, completion.model, runRef);
  return { draft, handlerRunId: runRef, model: completion.model };
}
