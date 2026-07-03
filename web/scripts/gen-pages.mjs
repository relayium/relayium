// web/scripts/gen-pages.mjs — writes all static pages (legal, landing, articles) + sitemap into public/.
// Run via `npm run gen:pages`; also runs automatically before dev/build.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import privacy from "./pages/content/legal/privacy.mjs";
import terms from "./pages/content/legal/terms.mjs";
import security from "./pages/content/legal/security.mjs";
import { buildLegalPages, buildSitemap } from "./pages/build-pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const legalDocs = [privacy, terms, security];

async function main() {
  const pages = buildLegalPages(legalDocs);
  for (const page of pages) {
    const abs = join(publicDir, page.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, page.html, "utf8");
  }
  await writeFile(join(publicDir, "sitemap.xml"), buildSitemap(legalDocs, { home: true }), "utf8");
  console.log(`gen-pages: wrote ${pages.length} pages + sitemap.xml to public/`);
}

main().catch((err) => {
  console.error("gen-pages failed:", err);
  process.exit(1);
});
