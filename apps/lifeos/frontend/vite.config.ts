import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
