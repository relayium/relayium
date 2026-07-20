import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { STREAM_ROUTE } from "./src/lib/sw-stream.js";

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
        .replace("__SHARE_ROUTE__", SHARE_ROUTE)
        // STREAM_ROUTE 直接从 lib/sw-stream.ts import：SW 侧和页面侧必须逐字相同，
        // 差一个字符就是「下载到一个网页」。sw-template.js 不参与打包，import 不了，
        // 所以只能在这里替换（和 __SHARE_ROUTE__ 一个路子）。
        .replace("__STREAM_ROUTE__", STREAM_ROUTE);

      this.emitFile({ type: "asset", fileName: "sw.js", source: sw });
    },
  };
}
