import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
// @ts-expect-error — plain ESM JS shared with the static-page build (no types).
import { buildShells, applyShell } from "./scripts/pages/shells.mjs";
// @ts-expect-error — see above.
import crossNetwork from "./scripts/pages/content/cross-network.mjs";
// @ts-expect-error — see above.
import offlineTransfer from "./scripts/pages/content/offline-transfer.mjs";
// @ts-expect-error — see above.
import apps from "./scripts/pages/content/apps.mjs";
// @ts-expect-error — see above.
import { pricing, cli, deviceInbox } from "./scripts/pages/content/spa-pages.mjs";
// @ts-expect-error — see above.
import { CLI_ARTICLES } from "./scripts/pages/content/cli-articles.mjs";

/**
 * Emits one HTML file per English SPA route (`cross-network.html`,
 * `pricing.html`, `device-inbox.html`, …) next to `index.html`, each being the
 * same built shell with its SEO-HEAD/SEO-BODY regions swapped for that route's
 * own metadata and prose.
 * See scripts/pages/shells.mjs for why, and the production nginx config (now
 * in the private relayium-ops repo; see docs/self-hosting.md for self-hosting)
 * for the `try_files $uri $uri.html` rule that serves them.
 *
 * It runs in closeBundle, not generateBundle, because it needs the FINAL
 * index.html — the one vite has already rewritten to point at the hashed asset
 * names. Reading it off disk also means the plugin never has to know how the
 * entry HTML was transformed.
 */
export function routeShellsPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "relayium-route-shells",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      // outDir is resolved against root, and auto-deploy.sh passes an absolute
      // --outDir to stage a release, so resolve() has to handle both.
      const outDir = resolve(config.root, config.build.outDir);
      const index = readFileSync(join(outDir, "index.html"), "utf8");
      const shells = buildShells({
        modes: [
          { def: crossNetwork, slug: "cross-network" },
          { def: offlineTransfer, slug: "offline-transfer" },
          { def: apps, slug: "apps" },
        ],
        pricing,
        cli,
        deviceInbox,
        cliArticles: CLI_ARTICLES,
      });
      for (const shell of shells) {
        writeFileSync(join(outDir, shell.file), applyShell(index, shell), "utf8");
      }
      this.info?.(`route shells: wrote ${shells.length} per-route SPA shells`);
    },
  };
}
