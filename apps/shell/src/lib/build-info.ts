// Version/build info (docs/planning/05-a-hyperbolic-core.md section 8,
// "Version/build info per zone"). Values are injected at build time by
// vite.config.ts's `define` block (see src/vite-env.d.ts for the ambient
// declarations) so the running app never needs a server round-trip just to
// report what it is.
export const APP_VERSION = __APP_VERSION__;
export const BUILD_SHA = __BUILD_SHA__;
export const BUILD_TIME = __BUILD_TIME__;
