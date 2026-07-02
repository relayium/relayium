// web/scripts/gen-legal.mjs — writes the legal pages + sitemap into public/.
// Run via `npm run gen:legal`; also runs automatically before dev/build.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import privacy from "./legal/content/privacy.mjs";
import terms from "./legal/content/terms.mjs";
import security from "./legal/content/security.mjs";
import { buildAllPages, buildSitemap } from "./legal/build-pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const docs = [privacy, terms, security];

async function main() {
  const pages = buildAllPages(docs);
  for (const page of pages) {
    const abs = join(publicDir, page.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, page.html, "utf8");
  }
  await writeFile(join(publicDir, "sitemap.xml"), buildSitemap(docs, { home: true }), "utf8");
  console.log(`gen-legal: wrote ${pages.length} pages + sitemap.xml to public/`);
}

main().catch((err) => {
  console.error("gen-legal failed:", err);
  process.exit(1);
});
