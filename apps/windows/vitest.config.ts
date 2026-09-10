import { defineConfig } from "vite";

export default defineConfig({
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
