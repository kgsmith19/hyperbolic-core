// Shared types for the intake submit surface (05-h section 6) and Handler
// A's own /v1/* LLM route surface (08-llm-handlers.md section 4/5, m4-05).

import type { CredentialsByProvider } from "@hyperbolic/llm";

export interface HandlerConfig {
  readonly port: number;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly githubIntakePat: string;
  /** General-purpose provider keys only (08 section 7): Infisical
   * /platform/llm/, injected only into this process. This config object has
   * no field for the Brain key, and nothing under src/ ever reads one --
   * the ADR-05 isolation this repo greps for in CI (m4-05 verification). */
  readonly llmCredentials: CredentialsByProvider;
  /** Per-caller concurrency cap (08 section 5), default 2. */
  readonly llmMaxConcurrencyPerCaller: number;
}

/** 05-h section 6.4: the exact six error classes and their row-state/retry contract. */
export type IntakeSubmitErrorClass =
  | "auth_invalid"
  | "rate_limited"
  | "repo_unreachable"
  | "issues_disabled"
  | "validation"
  | "server_network";

export class GithubSubmitError extends Error {
  readonly class: IntakeSubmitErrorClass;
  constructor(errorClass: IntakeSubmitErrorClass, message: string) {
    super(message);
    this.name = "GithubSubmitError";
    this.class = errorClass;
  }
}

export interface CreatedIssue {
  readonly number: number;
  readonly htmlUrl: string;
}

export interface IdeaRow {
  readonly status: "draft" | "idea" | "submitted_to_github";
  readonly title: string;
  readonly problem: string;
  readonly outcome: string;
  readonly notes: string;
  readonly confidence: "low" | "medium" | "high";
  readonly source: string;
  readonly targetRepo: string | null;
  readonly idempotencyKey: string;
  readonly githubIssueNumber: number | null;
  readonly githubIssueUrl: string | null;
  readonly parentGithubIssueUrl: string | null;
}

export type SubmitOutcome =
  | { readonly kind: "already_submitted"; readonly issueNumber: number; readonly issueUrl: string }
  | { readonly kind: "submitted"; readonly issueNumber: number; readonly issueUrl: string }
  | { readonly kind: "draft_not_promoted" }
  | { readonly kind: "error"; readonly errorClass: IntakeSubmitErrorClass; readonly message: string };
