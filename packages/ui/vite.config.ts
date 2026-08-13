import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// packages/ui is a LIBRARY, not an app: library mode emits a single
// tree-shakeable bundle at dist/index.cjs. react/react-dom are peer
// dependencies every consumer already has, so they're externalized rather
// than bundled.
//
// Format is CJS, not ESM, deliberately: this repo's Vite 8 (Rolldown-based)
// leaves a runtime `require("react")` call inside a nested CJS dependency
// (use-sync-external-store, pulled in transitively by @base-ui/utils) when
// targeting ESM with react externalized -- Rolldown's esmExternalRequire
// interop for this exact shape is a known, currently-open upstream bug
// (vitejs/rolldown-vite#513). That leftover `require()` throws in any
// environment without a global `require`, i.e. plain Node ESM and browsers
// alike, so it is a real defect, not just a local test inconvenience.
// Verified fix: CJS output has no such gap, since `require` is simply real
// there; every bundler this repo's consumers use (Vite, in every app)
// already interops CJS dependencies transparently. Re-check this the next
// time Vite/Rolldown here is upgraded -- ESM may become viable again.
//
// Type declarations are NOT emitted here -- see the "build" script in
// package.json: `vite build` runs first (and empties dist/ as part of
// that), then `tsc --emitDeclarationOnly` adds dist/*.d.ts on top without
// clearing what vite just wrote.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: path.resolve(import.meta.dirname, "src/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: {
      external: [/^react($|\/)/, /^react-dom($|\/)/],
    },
  },
});
