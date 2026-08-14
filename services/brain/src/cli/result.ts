/**
 * The shared verb output/exit-code contract (07-brain-architecture.md
 * section 7.8): "`--json` makes stdout a single JSON document and stderr
 * the only human text... exit codes are the contract (4 = parked
 * awaiting approval, never an error)." Every CLI verb (verbs.ts) returns
 * one of these; bin/brain.mjs's own job is only argv parsing and calling
 * `emit()`, never deciding output shape itself.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_POLICY_REFUSED = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_AWAITING_APPROVAL = 4;

export interface VerbResult {
  exitCode: number;
  /** What --json mode prints (exactly this, JSON.stringify'd, as the
   * ONLY stdout line). */
  json: unknown;
  /** What non-JSON mode prints to stdout; also always printed to stderr
   * in --json mode, since stdout there is reserved for the JSON document
   * alone ("stderr the only human text"). Empty string = nothing to say
   * beyond the JSON. */
  humanText: string;
}

/** Non-JSON mode split: exit 0 (ok) and 4 (awaiting-approval -- "never an
 * error" per 07 section 7.8) are informational, printed to stdout;
 * everything else (1 error, 2 policy-refused, 3 not-found) is an error
 * condition and goes to stderr, matching ordinary Unix CLI convention
 * (and this file's own pre-m4-13 behavior for validation failures). */
function isErrorExitCode(exitCode: number): boolean {
  return exitCode === EXIT_ERROR || exitCode === EXIT_POLICY_REFUSED || exitCode === EXIT_NOT_FOUND;
}

export function emit(result: VerbResult, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(result.json));
    if (result.humanText) console.error(result.humanText);
    return;
  }
  if (isErrorExitCode(result.exitCode)) {
    console.error(result.humanText);
  } else {
    console.log(result.humanText);
  }
}
