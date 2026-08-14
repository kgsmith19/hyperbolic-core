/**
 * USD estimate for harness token usage (07-brain-architecture.md section
 * 7.9's cost dashboard; BR-5's "queryable non-null tokens and dollars").
 *
 * Genuine limitation, not a silent guess: the ACC kernel's subprocess CLI
 * (kernel/run.mjs) reports only ONE combined token count per run -- no
 * input/output/cache-read split, and no model identifier in its stdout
 * result -- so a real per-model, per-token-class rate table cannot be
 * applied from outside the kernel process (result-mapper.ts's own header
 * comment documents the same combined-count limitation for
 * brain.result.v1's cost object). This uses one blended rate
 * approximating the harness fleet's default model, `claude-sonnet-5` (07
 * section 7.2: "cheap classification and routing steps claude-sonnet-5";
 * Claude Code sessions typically run on a Sonnet-class model absent an
 * explicit override), applied to whatever combined count is available.
 * Closing the real per-token-class split is tracked, not silently
 * mislabeled as exact.
 */

/** Approximate blended $/token across input, output, and cache-read
 * traffic for a Sonnet-class model -- a single coarse rate standing in
 * for three distinct real rates until the kernel exposes the split. */
export const BLENDED_USD_PER_TOKEN = 0.000006;

export function estimateUsd(inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
  const total = Math.max(0, inputTokens) + Math.max(0, outputTokens) + Math.max(0, cacheReadTokens);
  // Six decimal places matches core.cost.usd/core.llm_call.usd_estimate's
  // own numeric precision (numeric(12,6) / numeric(10,4)) -- rounding here
  // rather than at every consumer keeps one canonical estimate.
  return Math.round(total * BLENDED_USD_PER_TOKEN * 1e6) / 1e6;
}
