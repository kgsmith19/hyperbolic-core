#!/usr/bin/env node
// Resolves the review gate's configuration and serializes it, before any
// credential is imported. Called by .github/actions/verify-llm-review's
// preflight step; run it with any TypeScript-capable Node runtime, since it
// imports ../src/config.ts directly.
//
// Usage:
//   node packages/review/bin/write-review-config.mjs <output-path>
//
// It exists as a file rather than an inline `--eval` heredoc for one reason:
// a heredoc cannot be executed by a test, so the seam between "what the action
// resolves" and "what the artifact carries" had no oracle -- deleting the
// producer, or renaming a key it writes, stayed green. docs/ops's workflow
// contract now reads the command out of the action and runs THIS script into
// the real staging step.
//
// Two jobs, both fail-closed:
//   1. Validate. resolveConfig refuses an unset, blank, invalid, or
//      same-company configuration, so an exit here means no credential is ever
//      imported and no provider is ever called.
//   2. Record. The four resolved fields become the run's durable provenance:
//      canonicalized providers, byte-for-byte model ids. Written by the
//      canonical validator itself, so there is exactly one implementation of
//      that resolution rather than a second parse of the raw variables in
//      shell.
//
// Exit codes: 0 wrote the file, 2 resolved nothing and wrote nothing.
import { writeFileSync } from "node:fs";
import process from "node:process";

import { resolveConfig } from "../src/config.ts";

const USAGE = "Usage: node packages/review/bin/write-review-config.mjs <output-path>";

try {
  const [outPath] = process.argv.slice(2);
  if (outPath === undefined || outPath.trim() === "") {
    throw new Error(`An output path is required.\n${USAGE}`);
  }

  const config = resolveConfig(process.env);

  // Exactly these four keys, and the consumer pins them. Adding a field here
  // without teaching review-meta.json and the dialogue workflow about it would
  // be a silent half-migration.
  const provenance = {
    reviewerProvider: config.reviewerProvider,
    reviewerModel: config.reviewerModel,
    builderProvider: config.builderProvider,
    builderModel: config.builderModel,
  };
  writeFileSync(outPath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

  // Providers and model ids are public repository variables, never secrets, so
  // echoing them is safe and is the fastest way to diagnose a misconfigured
  // gate from the run log alone.
  process.stdout.write(
    `Reviewer configuration present: provider=${config.reviewerProvider} model=${config.reviewerModel} ` +
      `builder=${config.builderProvider} builderModel=${config.builderModel}\n`
  );
} catch (error) {
  process.stderr.write(`write-review-config: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
