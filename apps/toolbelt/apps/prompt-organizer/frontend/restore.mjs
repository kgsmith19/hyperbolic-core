// SPEC-0005 (SL-008): pure decision for whether a listed version is the
// prompt's current one -- the version-history panel does not offer a
// restore control for it (AC-004). A small standalone module (not folded
// into search.mjs or render.mjs, whose exports are about a different
// concern) because tests/restore.test.mjs needs to import it directly.
export function isCurrentVersion(versionBody, currentBody) {
  return versionBody === currentBody;
}
