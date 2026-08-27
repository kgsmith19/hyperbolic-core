#!/usr/bin/env node
// Executable entry point for the adversarial LLM review gate. Thin process
// wrapper: every decision lives in ../src/ so the whole gate is testable
// without spawning a subprocess, a network call, or a git repository.
//
// Usage:
//   node packages/review/bin/review.mjs \
//     --base <sha> --head <sha> [--issue-body-file <path>] [--pr-body-file <path>] [--out <path>]
//
// Environment (see ../src/config.ts -- nothing here is defaulted silently):
//   REVIEW_PROVIDER            reviewer provider family (anthropic|openai|gemini)
//   REVIEW_MODEL               exact model id served by REVIEW_PROVIDER
//   REVIEW_BUILDER_PROVIDER    required; family that WROTE the code
//   DEV_MODEL                  required; exact model id that WROTE the code
//   REVIEW_ANTHROPIC_API_KEY   only the reviewer provider's key is required
//   REVIEW_OPENAI_API_KEY
//   REVIEW_GEMINI_API_KEY
//
// Exit codes, and why they are three and not two:
//   0  reviewed, verdict = pass
//   1  reviewed, verdict = block  -- a real finding, with evidence and citation
//   2  the review did not happen  -- bad usage, bad config, or an infrastructure
//      failure. Distinct from 1 on purpose: "the reviewer objects" and "the
//      reviewer never ran" are different facts, and collapsing them would let a
//      broken credential masquerade as a code-quality failure (or, far worse,
//      invite someone to treat every red as flaky and re-run past it).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { gatherContext, resolveConfig, runReview } from "../src/index.ts";

const USAGE = `Usage: node packages/review/bin/review.mjs --base <sha> --head <sha> [--issue-body-file <path>] [--pr-body-file <path>] [--conversation-file <path>] [--out <path>]`;

function parseArgs(argv) {
  const args = { base: null, head: null, issueBodyFile: null, prBodyFile: null, conversationFile: null, out: null };
  const flags = {
    "--base": "base",
    "--head": "head",
    "--issue-body-file": "issueBodyFile",
    "--pr-body-file": "prBodyFile",
    "--conversation-file": "conversationFile",
    "--out": "out",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flags[flag];
    if (key === undefined) {
      throw new Error(`Unknown argument "${flag}".\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.\n${USAGE}`);
    }
    args[key] = value;
    index += 1;
  }
  if (args.base === null || args.head === null) {
    throw new Error(`--base and --head are both required.\n${USAGE}`);
  }
  return args;
}

// One env var per provider, read only for the provider actually being used.
// Handing the client every key it could find would widen the blast radius of
// this process for no benefit: the review makes exactly one call.
function readCredentials(env, provider) {
  const varName = {
    anthropic: "REVIEW_ANTHROPIC_API_KEY",
    openai: "REVIEW_OPENAI_API_KEY",
    gemini: "REVIEW_GEMINI_API_KEY",
  }[provider];
  const apiKey = (env[varName] ?? "").trim();
  if (apiKey === "") {
    throw new Error(
      `${varName} is unset or empty, but REVIEW_PROVIDER="${provider}" needs it. The review cannot run; failing closed.`
    );
  }
  return { [provider]: { apiKey } };
}

function renderHumanSummary(verdict) {
  const lines = [];
  lines.push(verdict.verdict === "block" ? "REVIEW VERDICT: BLOCK" : "REVIEW VERDICT: PASS");
  lines.push("");
  lines.push(verdict.summary);
  lines.push("");

  const blocking = verdict.findings.filter((finding) => finding.severity === "blocking");
  const advisory = verdict.findings.filter((finding) => finding.severity === "advisory");

  const renderFinding = (finding, index) => {
    const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(no file)";
    lines.push(`  ${index + 1}. [${finding.category}] ${where}`);
    lines.push(`     claim:    ${finding.claim}`);
    lines.push(`     evidence: ${finding.evidence.split("\n").join("\n               ")}`);
    lines.push(`     asks for: ${finding.requestedChange}`);
    lines.push(`     cites:    ${finding.citation}`);
    lines.push("");
  };

  lines.push(`Blocking findings (${blocking.length}):`);
  blocking.forEach(renderFinding);
  if (blocking.length === 0) {
    lines.push("  (none)");
    lines.push("");
  }

  lines.push(`Advisory findings (${advisory.length}):`);
  advisory.forEach(renderFinding);
  if (advisory.length === 0) {
    lines.push("  (none)");
    lines.push("");
  }

  // Printed, not hidden: a discarded blocking finding is exactly the case
  // where a human most wants to know what the model tried to say.
  lines.push(`Discarded findings (${verdict.discarded.length}) -- missing evidence or citation, did not affect the verdict:`);
  if (verdict.discarded.length === 0) {
    lines.push("  (none)");
  } else {
    verdict.discarded.forEach((finding, index) => {
      lines.push(`  ${index + 1}. [${finding.severity}/${finding.category}] ${finding.claim || "(no claim)"}`);
    });
  }

  return lines.join("\n");
}

async function main(argv, env) {
  const args = parseArgs(argv);
  const config = resolveConfig(env);
  const credentials = readCredentials(env, config.reviewerProvider);

  const issueBody =
    args.issueBodyFile === null
      ? "(no linked Issue body was supplied to this run)"
      : await readFile(args.issueBodyFile, "utf8");

  const prBody =
    args.prBodyFile === null
      ? "(no pull request body was supplied to this run)"
      : await readFile(args.prBodyFile, "utf8");

  // Empty, not a placeholder sentence: gatherContext's own default is "",
  // and context.ts / prompt.ts already render a first-round placeholder for
  // that case. A second, different placeholder text here would just be a
  // maintenance seam with no behavioral purpose.
  const conversation = args.conversationFile === null ? "" : await readFile(args.conversationFile, "utf8");

  // AGENTS.md is read from the checkout under review, not bundled: the
  // reviewer must judge against the standard as it stands on this branch.
  let agentsMd;
  try {
    agentsMd = await readFile("AGENTS.md", "utf8");
  } catch {
    agentsMd = "(AGENTS.md was not found in the working directory)";
  }

  const context = await gatherContext({
    baseSha: args.base,
    headSha: args.head,
    issueBody,
    prBody,
    agentsMd,
    conversation,
  });

  const verdict = await runReview({ config, context, credentials });

  process.stdout.write(`${renderHumanSummary(verdict)}\n`);

  if (args.out !== null) {
    const outPath = path.resolve(args.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
    process.stdout.write(`\nFull verdict written to ${outPath}\n`);
  }

  return verdict.verdict === "block" ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (error) {
  process.stderr.write(`review-gate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
