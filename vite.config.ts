import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Dev: proxy /api to a running ACC server (`npm run gui` in the ACC repo).
// changeOrigin makes the Host header pass ACC's loopback check; the proxy is
// same-origin from the browser's view, so ACC's no-CORS/X-ACC model holds.
// Prod: `npm run build` → dist/, served same-origin by ACC's --ui-dist.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    proxy: { "/api": { target: process.env.ACC_API || "http://127.0.0.1:43117", changeOrigin: true } },
  },
});
