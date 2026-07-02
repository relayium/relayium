import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const SHARE_ROUTE = "/share-target";

/**
 * Emits a hand-written service worker (`/sw.js`) that precaches the app shell.
 * The precache list is the built JS/CSS plus the root document + manifest; the
 * cache version is a hash of that list, so it changes exactly when a hashed
 * asset name changes — old shells then evict themselves on activate. No Workbox.
 */
export function pwaPlugin(): Plugin {
  return {
    name: "relayium-pwa",
    apply: "build",
    generateBundle(_options, bundle) {
      const templatePath = fileURLToPath(new URL("./src/sw-template.js", import.meta.url));
      const template = readFileSync(templatePath, "utf8");

      const assets = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f))
        .map((f) => "/" + f);
      const precache = ["/", "/site.webmanifest", ...assets].sort();
      const version = createHash("sha1").update(precache.join("\n")).digest("hex").slice(0, 12);

      const sw = template
        .replace("__PRECACHE__", JSON.stringify(precache))
        .replace("__VERSION__", version)
        .replace("__SHARE_ROUTE__", SHARE_ROUTE);

      this.emitFile({ type: "asset", fileName: "sw.js", source: sw });
    },
  };
}
