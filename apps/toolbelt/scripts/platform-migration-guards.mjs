#!/usr/bin/env node
// Pure decision logic behind platform-migrations.yml's two still-open P1
// findings (independent security review of this repo, re-verified against
// current HEAD) that stage-migrations.mjs's staging/ordering/owner-split
// work alone doesn't close -- it builds the right directories, but SOMETHING
// still has to decide whether it is safe to push what's in them.
//
// Finding 4 (no live-parity/ledger-baseline step exists):
//   - checkApplyRef() refuses an "apply" dispatch that is not the main
//     branch's exact current commit (docs/planning/issues/
//     m1-05-chore-ci-platform-migrations-workflow.md: normal apply
//     dispatches "must refuse to run against anything other than the main
//     branch's exact current SHA (not an arbitrary feature ref)").
//   - isDiffEmpty() decides whether a `supabase db diff` run found genuine
//     drift between the live project and what the CLI ledger (or, in
//     baseline mode, the operator's named subset) claims is already applied.
//   - findMissingVersions() proves the post-push zero-pending property
//     directly against the ledger table, rather than string-matching
//     `supabase db push --dry-run`'s human-readable output (which is not a
//     documented, version-stable contract).
//
// Finding 5 (owner re-pin can run before its required preflight):
//   - parseOwnerPreflightRow() decides whether the live platform.config +
//     auth.users state genuinely satisfies
//     apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md's
//     prerequisite before platform-migrations.yml applies any owner-repin-tier
//     migration (see stage-migrations.mjs's splitAtOwnerDependency()).
//
// Every function below is pure (string/object in, verdict out) precisely so
// this branching logic is unit-testable without a live Supabase project --
// the workflow's own `run:` steps stay thin, single-purpose data collection
// (one psql query, one `git rev-parse`, one `supabase db diff`), each piped
// straight into this script for the actual pass/fail decision. This mirrors
// validate-migrations.mjs's own split between "collect file paths" (thin)
// and "decide pass/fail" (the exported, tested functions).

import { readFileSync } from "node:fs";

// ---- Finding 4: apply-mode ref pinning ------------------------------------

// baseline dispatches are the one-time, explicitly operator-named repair --
// they are not restricted to main's exact tip the way ongoing apply
// dispatches are (the issue's wording is specific to "normal apply
// dispatches"). Every other mode value passes through unchecked here too;
// the workflow itself only ever sets mode to "apply" or "baseline", but this
// function stays a narrow, single-purpose gate rather than also owning mode
// validation.
export function checkApplyRef({ mode, ref, sha, mainSha }) {
  if (mode !== "apply") return { ok: true };

  if (ref !== "refs/heads/main") {
    return {
      ok: false,
      reason:
        `apply mode refuses to run against ref "${ref}" -- only refs/heads/main ` +
        `(m1-05's "not an arbitrary feature ref"). Dispatch mode=apply against main, ` +
        `or use mode=baseline for a one-time, explicitly-named repair.`,
    };
  }
  if (!mainSha) {
    return {
      ok: false,
      reason: "apply mode could not resolve main's current SHA to compare against; refusing to proceed blind.",
    };
  }
  if (sha !== mainSha) {
    return {
      ok: false,
      reason:
        `apply mode refuses to run: the checked-out commit (${sha}) is not main's current tip ` +
        `(${mainSha}). Either a new commit landed on main after this run started, or this ` +
        `dispatch targeted a stale ref -- re-dispatch to pick up the real current commit.`,
    };
  }
  return { ok: true };
}

// ---- Finding 4: live-parity diff verdict ----------------------------------

// `supabase db diff` prints a SQL migration-shaped diff to stdout when it
// finds real differences, and nothing (or comment-only boilerplate) when the
// two sides already match. Strip line comments the same way
// validate-migrations.mjs's own stripLineComments does, so a diff run that
// only emits a header comment is correctly read as "no drift", not as a
// false-positive failure.
function stripLineComments(sql) {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

export function isDiffEmpty(diffText) {
  return stripLineComments(diffText).trim().length === 0;
}

// ---- Finding 4: post-push zero-pending proof ------------------------------

// `stagedVersions` is every version key that was staged for push (read off
// the staged directory's own filenames); `ledgerVersions` is what
// `select version from supabase_migrations.schema_migrations` reports
// immediately after the push. Anything staged but missing from the ledger
// afterward is genuinely still pending -- the push did not actually land it
// (a silent CLI no-op, a partial failure that didn't propagate a nonzero
// exit, etc.). Comparing sets we already query ourselves is deliberately
// preferred over parsing `supabase db push --dry-run`'s prose output, which
// is not a documented, version-stable machine contract.
export function findMissingVersions(stagedVersions, ledgerVersions) {
  const ledgerSet = new Set(ledgerVersions);
  return stagedVersions.filter((version) => !ledgerSet.has(version));
}

// ---- Finding 5: owner preflight -------------------------------------------

// Parses one row of `psql -Atc` output (default unaligned separator '|')
// from the exact query platform-migrations.yml's "Owner preflight" step
// runs directly over $SUPABASE_DB_URL:
//
//   select
//     (select count(*) from platform.config)                                 as config_rows,
//     (select owner_uuid::text from platform.config limit 1)                 as owner_uuid,
//     (select u.id::text from platform.config c
//        join auth.users u on u.id = c.owner_uuid limit 1)                   as user_id,
//     (select u.email from platform.config c
//        join auth.users u on u.id = c.owner_uuid limit 1)                   as email,
//     (select u.confirmed_at::text from platform.config c
//        join auth.users u on u.id = c.owner_uuid limit 1)                   as confirmed_at,
//     (select u.banned_until::text from platform.config c
//        join auth.users u on u.id = c.owner_uuid limit 1)                   as banned_until;
//
// Written as five scalar subqueries (not a plain join) so the query always
// returns exactly one row regardless of whether platform.config has 0, 1, or
// (should the singleton PK ever be bypassed) more rows -- a join starting
// from an empty or multi-row platform.config would otherwise return zero or
// multiple rows instead of one clear verdict.
//
// This is the exact query the check runs because it is the exact credential
// the workflow actually holds: a raw superuser Postgres connection
// ($SUPABASE_DB_URL, from the existing Infisical /platform/ secret-path
// step) can read auth.users directly, but there is no Auth admin API key and
// no TOOLBELT_OWNER_TOKEN available to this pipeline (that GitHub secret, per
// apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md step 3, is
// scoped to apps/toolbelt's *test* pipeline, not this migrations workflow) --
// so config-row-count plus a live, confirmed, unbanned owner resolving
// through it is the check that is actually possible here, not a check
// against credentials this workflow was never given.
export function parseOwnerPreflightRow(line) {
  const [configRowsRaw, ownerUuid, userId, email, confirmedAt, bannedUntil] = line.split("|");
  const configRows = Number(configRowsRaw);
  const runbook = "apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md";

  if (!Number.isInteger(configRows) || configRows !== 1) {
    return {
      ok: false,
      reason:
        `platform.config holds ${configRowsRaw || "0"} row(s), expected exactly 1. ` +
        `Run the operator setup steps in ${runbook} before this migration tier can apply.`,
    };
  }
  if (!userId) {
    return {
      ok: false,
      reason:
        `platform.config.owner_uuid (${ownerUuid || "<empty>"}) does not resolve to any row in ` +
        `auth.users -- the owner user was never created, or was deleted after the config row was ` +
        `inserted. See ${runbook} step 1.`,
    };
  }
  if (!confirmedAt) {
    return {
      ok: false,
      reason:
        `Owner user ${email || userId} exists but has never confirmed (auth.users.confirmed_at is ` +
        `null) -- not a genuinely live credential yet. See ${runbook}.`,
    };
  }
  if (bannedUntil) {
    return {
      ok: false,
      reason: `Owner user ${email || userId} is banned until ${bannedUntil} -- not a usable live owner credential right now.`,
    };
  }
  return { ok: true };
}

// ---- CLI --------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i += 1;
    }
  }
  return flags;
}

function readInput(path) {
  return path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
}

function readVersionsFile(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "check-apply-ref") {
    const flags = parseFlags(rest);
    const result = checkApplyRef({
      mode: flags.mode,
      ref: flags.ref,
      sha: flags.sha,
      mainSha: flags["main-sha"],
    });
    if (!result.ok) {
      console.error(result.reason);
      process.exit(1);
    }
    console.log(`apply-ref check passed (mode=${flags.mode}, ref=${flags.ref}).`);
    return;
  }

  if (cmd === "check-diff-empty") {
    const text = readInput(rest[0]);
    if (!isDiffEmpty(text)) {
      console.error(
        "Live schema has drifted from what the ledger claims is already applied -- refusing " +
          "to push anything new on top of an unverified base. See the uploaded diff artifact.",
      );
      process.exit(1);
    }
    console.log("Live-parity diff is empty -- no drift.");
    return;
  }

  if (cmd === "check-owner-preflight") {
    const text = readInput(rest[0]).trim();
    const result = parseOwnerPreflightRow(text);
    if (!result.ok) {
      console.error(result.reason);
      process.exit(1);
    }
    console.log("Owner preflight passed: exactly one platform.config row, resolving to a confirmed, unbanned owner.");
    return;
  }

  if (cmd === "check-zero-pending") {
    const flags = parseFlags(rest);
    const staged = readVersionsFile(flags.staged);
    const ledger = readVersionsFile(flags.ledger);
    const missing = findMissingVersions(staged, ledger);
    if (missing.length > 0) {
      console.error(`${missing.length} staged migration(s) are still pending after the push:`);
      for (const version of missing) console.error(`  ${version}`);
      process.exit(1);
    }
    console.log(`Zero pending: all ${staged.length} staged version(s) are recorded in the ledger.`);
    return;
  }

  console.error(
    "usage: platform-migration-guards.mjs <check-apply-ref|check-diff-empty|check-owner-preflight|check-zero-pending> [...args]",
  );
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
