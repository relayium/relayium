import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  // The bundle is served over the registered `app://relayium/` scheme, so asset
  // URLs must be relative rather than rooted at `/`.
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    // No inline scripts: the renderer's CSP has no `'unsafe-inline'` in
    // `script-src`, and an inlined chunk would silently need one.
    modulePreload: { polyfill: false },
  },
  resolve: {
    // Two package roots are in play — this one and `web/`. Two copies of
    // libsodium would each initialise their own WASM instance; two copies of
    // Svelte would give the renderer two runtimes with separate reactive
    // contexts.
    dedupe: ["libsodium-wrappers", "svelte"],
  },
});
