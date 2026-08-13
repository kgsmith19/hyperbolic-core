import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 05-a section 4 / 10-cicd-deployment.md section 4: this zone is served
  // from "/life/*" behind the one-origin route table
  // (docs/ops/tailscale-serve-apply.sh), not from the origin root -- every
  // built asset URL and the router `basename` (App.tsx) must agree on this
  // exact prefix, trailing slash included (Vite's own `base` doc: a value
  // without one is treated as a bare relative path, not a root-anchored
  // one). Does not affect `vitest`'s own test run (jsdom's default
  // document location is unrelated to this build-time asset-URL setting).
  base: "/life/",
  plugins: [react(), tailwindcss()],
  resolve: {
    // @hyperbolic/ui resolves its OWN `require("react")` starting from
    // `packages/ui`'s directory, which is part of the hyperbolic-core root
    // npm workspace and therefore finds the ROOT `node_modules/react` --
    // a DIFFERENT copy than this standalone package's own
    // `node_modules/react` (this app is not in that workspace; see
    // package.json's `file:` dependency comment). Two separate React
    // module instances share no internal hook dispatcher state, which
    // surfaced as a real, reproduced browser error ("Cannot read
    // properties of null (reading 'useState')") the first time Chrome
    // actually mounted under Vite dev's pre-bundled dependency graph.
    // `dedupe` is Vite's documented fix for exactly this shape of monorepo
    // duplicate-package problem: forces every resolution of `react`/
    // `react-dom`, regardless of which package.json asked for it, to the
    // one copy resolved from THIS project's own root.
    dedupe: ["react", "react-dom"],
  },
  // @hyperbolic/ui (package.json dependency) is a `file:` link to a sibling
  // directory OUTSIDE this package's own tree, not a published npm package
  // -- see package.json's own comment on why. Vite's dev server treats a
  // linked/symlinked dependency as local source to preserve for HMR and
  // serves it raw via "/@fs/..." instead of running it through esbuild's
  // dependency pre-bundling step, which is where CJS named-export detection
  // actually happens; `dist/index.cjs` genuinely does export `Chrome` (a
  // plain `exports.Chrome = ...` assignment, confirmed by reading the built
  // file directly) but Vite's raw-serve interop failed to see it --
  // reproduced with a real "does not provide an export named 'Chrome'"
  // browser error before this line existed. Forcing it through
  // `optimizeDeps` regardless of the link is the documented Vite fix for a
  // linked monorepo dependency that ships pre-built CJS/ESM output rather
  // than raw TypeScript (contrast `@hyperbolic/platform-client`, whose
  // `file:` link needs no such entry: its `exports` field points straight
  // at a `.ts` source file, which Vite's own React/TS transform handles
  // like any other source module, the same way it already handles this
  // app's own `src/*`).
  optimizeDeps: {
    include: ["@hyperbolic/ui"],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
    // Component tests idle on real timers (userEvent, Testing Library polling),
    // so a busy machine — not a slow test — is what blows the 5s default.
    testTimeout: 20000,
  },
});
