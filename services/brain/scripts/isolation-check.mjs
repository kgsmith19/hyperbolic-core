#!/usr/bin/env node
// ADR-05 / BR-3 / II-4 isolation check (docs/planning/04-adrs.md's ADR-05,
// 07-brain-architecture.md section 7.10, m4-18's own scope bullet):
// "attempt to read the /brain/ secrets path from a non-Brain process
// context, exit non-zero."
//
// ADR-05's own mechanics (04-adrs.md line 163) are deploy-time/infra
// facts this repo cannot fabricate in CI -- a real Infisical project, a
// dedicated `brain` OS user, a separate container per unit. What IS
// exercisable here, and is the actual structural guarantee those
// mechanics are meant to realize, is the file-based half: in production
// the Brain's own secret is rendered to a single file at deploy time
// (BRAIN_SECRET_FILE, default /run/secrets/brain/anthropic-api-key --
// the standard Docker/Compose secrets-mount convention), owned and
// readable only by the `brain` OS user/container. Every OTHER unit's
// container never has that file mounted at all -- so "attempt to read
// it from a non-Brain process context" and "the file simply is not
// there for you" are the SAME observable fact from any other unit's
// point of view. This script's whole job is to make that fact into an
// exit code, not to simulate the OS-user boundary itself.
//
// Contract: prints what it did to stderr, then exits 0 if the secret was
// actually read (successful access -- the CORRECT outcome only when this
// script runs INSIDE the real Brain container) or non-zero if it could
// not be read (ENOENT/EACCES/any other error -- the CORRECT outcome from
// every non-Brain context, which is what "echo $? is non-zero" in the
// issue's own verification bullet exercises).
import { readFileSync } from "node:fs";

const secretPath = process.env.BRAIN_SECRET_FILE ?? "/run/secrets/brain/anthropic-api-key";

try {
  const contents = readFileSync(secretPath, "utf8");
  if (contents.trim().length === 0) {
    console.error(`isolation-check: ${secretPath} exists but is empty -- treating as unreadable`);
    process.exit(1);
  }
  console.error(`isolation-check: read ${secretPath} successfully (${contents.trim().length} bytes) -- this process CAN see the Brain secret`);
  process.exit(0);
} catch (err) {
  console.error(`isolation-check: could not read ${secretPath} (${err.code ?? err.message}) -- this process context cannot see the Brain secret`);
  process.exit(1);
}
