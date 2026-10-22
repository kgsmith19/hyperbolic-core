// Read-only cutover preflight. A missing observation is never treated as disabled.
// Input is explicit evidence from each repository's current deployment switch.
// The program intentionally does not contact production or change GitHub settings.
export function assessLifeosWriters({ standalone, monorepo }) {
  const valid = (v) => v === "enabled" || v === "disabled";
  // Preserve only normalized, non-sensitive observations. Invalid input is
  // reported as unknown rather than echoed back as though it were evidence.
  const observed = {
    standalone: valid(standalone) ? standalone : null,
    monorepo: valid(monorepo) ? monorepo : null,
  };
  if (!valid(standalone) || !valid(monorepo)) {
    return { ...observed, ready: false, reason: "unknown-writer-state" };
  }
  if (standalone === "enabled" && monorepo === "enabled") {
    return { ...observed, ready: false, reason: "dual-writer-risk" };
  }
  if (standalone === "enabled") {
    return { ...observed, ready: false, reason: "standalone-writer-active" };
  }
  if (monorepo === "disabled") {
    return { ...observed, ready: false, reason: "no-active-monorepo-writer" };
  }
  return { ...observed, ready: true, reason: "single-monorepo-writer" };
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
