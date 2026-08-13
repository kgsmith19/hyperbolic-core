// Single point of contact with apps/toolbelt/scripts/validate-manifests.mjs
// (m3-01) and apps/toolbelt/scripts/validate-migrations.mjs (Finding 26's
// fix, independent security review of this repo, re-verified against
// current HEAD). Every other module in this package imports these shared
// utilities from HERE, never by repeating the relative path inline, so each
// path across the packages/ <-> apps/ boundary is written exactly once.
//
// m3-03's issue text is explicit: the registration migration's manifest_hash
// column "MUST be computed via manifestHash() imported from this exact
// module (not reimplemented), matching the convention m3-02's registration
// migrations already established." checkSchemaOwnershipUniqueness is reused
// the same way for the schema-collision check (TB-5, reused here for TB-3's
// "requested schema collides with an existing manifest" case).
//
// discoverMigrationDirs is reused the same way again for Finding 27's fix
// (independent security review, re-verified against current HEAD:
// "Registration and schema versions are allocated independently... Allocate
// globally unique ordered versions for every emitted migration"):
// src/scaffold.mjs's buildPlan calls it to build the GLOBAL set of existing
// migration basenames a new timestamp must avoid colliding with, so the
// namespace this CLI defends against at generation time is provably the
// exact same one apps/toolbelt/scripts/validate-migrations.mjs's
// checkVersionCollisions enforces at CI/deploy time -- two independently
// maintained notions of "the global migration-directory set" could drift
// silently out of sync; importing the one real implementation cannot.
//
// These relative paths (packages/toolbelt-cli/src -> repo root -> apps/toolbelt)
// only resolve correctly as long as both packages/toolbelt-cli and
// apps/toolbelt keep their current positions two levels under the repo root
// (ADR-01's target tree). src/paths.mjs's REPO_ROOT is computed independently
// (via import.meta.url, not by importing this constant) and is asserted equal
// to this module's own resolved TOOLBELT_ROOT in tests/paths.test.mjs, so a
// future repo reshuffle that breaks one breaks the other loudly instead of
// silently resolving to the wrong tree.
export {
  TOOLBELT_ROOT,
  SCHEMA_PATH,
  findManifestPaths,
  checkManifestShape,
  checkSchemaOwnershipUniqueness,
  canonicalize,
  canonicalJSON,
  manifestHash,
} from "../../../apps/toolbelt/scripts/validate-manifests.mjs";

export { discoverMigrationDirs } from "../../../apps/toolbelt/scripts/validate-migrations.mjs";
