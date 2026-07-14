import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  // Svelte's package.json resolves to the server build unless the "browser"
  // condition is present, which would mount .svelte components as no-op SSR
  // stubs (lifecycle_function_unavailable) instead of real client components.
  resolve: { conditions: ["browser"] },
  test: {
    environment: "jsdom",
    globals: true,
    // Node.js 25 exposes a stub localStorage that populateGlobal skips;
    // setupTest.ts replaces it with the proper jsdom-backed Storage.
    setupFiles: ["./src/setupTest.ts"],
  },
});
