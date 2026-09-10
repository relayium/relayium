// Builds the Inbox runtime: shared protocol TypeScript in, one fixed Node
// artifact out.
//
// Why a bundle at all: `tsconfig.main.json` sets `rootDir: "src"`, so a
// main-process file cannot import `web/src/lib` (TS6059, under both --noEmit
// and emit). The shared modules are therefore a source input here rather than
// a vendored copy or a published package.
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Node semantics, not browser: this runs in the Electron main process.
    ssr: true,
    target: "node22",
    outDir: "dist/main",
    // MUST stay false. `dist/main` is tsc's output for the whole main process;
    // emptying it here would delete the compiled app and leave only this file.
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: { entry: "build/inbox-runtime.entry.ts", formats: ["es"] },
    rollupOptions: {
      // Left external on purpose:
      //  - electron and node builtins are provided by the host process;
      //  - libsodium-wrappers is ~450KB of wasm that `device-seal.ts` loads
      //    lazily once, and bundling it would both bloat the artifact and
      //    change that lazy-load behaviour.
      // They resolve at runtime because the artifact sits beside the app's
      // node_modules, which is what electron-builder packs.
      external: [
        "electron",
        "libsodium-wrappers",
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
      output: {
        // NOT `build.lib.fileName`: in Vite 8 lib mode that has no effect and
        // the artifact came out as `inbox-runtime.entry.mjs`. A fixed name is
        // required — `src/main/inbox/runtime.ts` imports it by literal path —
        // so it is pinned where it actually applies.
        entryFileNames: "inbox-runtime.js",
      },
    },
  },
});
