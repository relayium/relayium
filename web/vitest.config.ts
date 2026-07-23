import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  // Svelte's package.json resolves to the server build unless the "browser"
  // condition is present, which would mount .svelte components as no-op SSR
  // stubs (lifecycle_function_unavailable) instead of real client components.
  resolve: { conditions: ["browser"] },
  // Keep vitest's cache out of src/. Left to itself it has landed in
  // src/node_modules, where tsconfig.app.json's allowJs+checkJs then typechecked
  // 6MB of cached transforms (tsconfig's "exclude" now also names that path).
  cacheDir: "node_modules/.vitest",
  test: {
    environment: "jsdom",
    globals: true,
    // Node.js 25 exposes a stub localStorage that populateGlobal skips;
    // setupTest.ts replaces it with the proper jsdom-backed Storage.
    setupFiles: ["./src/setupTest.ts"],
  },
});
