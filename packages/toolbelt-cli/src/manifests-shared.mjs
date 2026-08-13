// Single point of contact with apps/toolbelt/scripts/validate-manifests.mjs
// (m3-01). Every other module in this package imports the shared manifest
// utilities from HERE, never by repeating the relative path inline, so the
// path across the packages/ <-> apps/ boundary is written exactly once.
//
// m3-03's issue text is explicit: the registration migration's manifest_hash
// column "MUST be computed via manifestHash() imported from this exact
// module (not reimplemented), matching the convention m3-02's registration
// migrations already established." checkSchemaOwnershipUniqueness is reused
// the same way for the schema-collision check (TB-5, reused here for TB-3's
// "requested schema collides with an existing manifest" case).
//
// This relative path (packages/toolbelt-cli/src -> repo root -> apps/toolbelt)
// only resolves correctly as long as both packages/toolbelt-cli and
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
