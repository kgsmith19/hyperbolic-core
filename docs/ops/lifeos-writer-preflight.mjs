// Read-only cutover preflight. A missing observation is never treated as disabled.
// Input is explicit evidence from each repository's current deployment switch.
// The program intentionally does not contact production or change GitHub settings.
export function assessLifeosWriters({ standalone, monorepo }) {
  const valid = (v) => v === "enabled" || v === "disabled";
  if (!valid(standalone) || !valid(monorepo)) {
    return { ready: false, reason: "unknown-writer-state" };
  }
  if (standalone === "enabled" && monorepo === "enabled") {
    return { ready: false, reason: "dual-writer-risk" };
  }
  if (standalone === "enabled") {
    return { ready: false, reason: "standalone-writer-active" };
  }
  if (monorepo === "disabled") {
    return { ready: false, reason: "no-active-monorepo-writer" };
  }
  return { ready: true, reason: "single-monorepo-writer" };
}

// Example: node docs/ops/lifeos-writer-preflight.mjs disabled enabled
// These inputs MUST be independently read from current repository configuration.
// A passing verdict cannot replace verifying credentials, health, or rollback.
if (process.argv[1]?.endsWith("/lifeos-writer-preflight.mjs")) {
  const [, , standalone, monorepo] = process.argv;
  const verdict = assessLifeosWriters({ standalone, monorepo });
  console.log(JSON.stringify(verdict));
  if (!verdict.ready) process.exitCode = 1;
}
