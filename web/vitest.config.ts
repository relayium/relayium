import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: "jsdom",
    globals: true,
    // Node.js 25 exposes a stub localStorage that populateGlobal skips;
    // setupTest.ts replaces it with the proper jsdom-backed Storage.
    setupFiles: ["./src/setupTest.ts"],
  },
});
