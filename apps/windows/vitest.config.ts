import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  // The real Svelte plugin, because the tests now execute real rune modules.
  //
  // The foundation ran without one and was right to: only non-rune fixture
  // modules were imported, so nothing needed compiling. The transport slice
  // composes `peer-workspace.svelte.ts`, `mixed-session.svelte.ts` and
  // `peer-caps.svelte.ts` — `$state` in every one — and a test that cannot run
  // them is a test of a copy rather than of the thing that ships.
  //
  // Deliberately the ordinary plugin. A custom transform that stripped or
  // rewrote runes would make these tests pass against code the renderer does
  // not run, which is worse than not having them.
  plugins: [svelte()],
  resolve: {
    // `web/src/lib/*` is imported directly rather than vendored — a copied
    // protocol is silent divergence with a green board on both sides, which is
    // what the frozen cross-language fixtures exist to prevent.
    //
    // Deduping matters because two package roots are in play: this one and
    // `web/`. Two copies of libsodium would each initialise their own WASM
    // instance, and two copies of Svelte would give the renderer two runtimes
    // with separate reactive contexts.
    dedupe: ["libsodium-wrappers", "svelte"],
  },
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    // Serial: the IO tests each own a real temp directory and several patch
    // `FileHandle.prototype` to simulate a partial OS write. Parallel workers
    // would have them patching one shared prototype.
    fileParallelism: false,
  },
});
