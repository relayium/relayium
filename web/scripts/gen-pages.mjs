// web/scripts/gen-pages.mjs — writes all static pages (legal, landing, articles) + sitemap into public/.
// Run via `npm run gen:pages`; also runs automatically before dev/build.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import privacy from "./pages/content/legal/privacy.mjs";
import terms from "./pages/content/legal/terms.mjs";
import security from "./pages/content/legal/security.mjs";
import landing from "./pages/content/landing.mjs";
import guidesIndex from "./pages/content/guides-index.mjs";
import compareSnapdrop from "./pages/content/articles/compare-snapdrop.mjs";
import compareAirdrop from "./pages/content/articles/compare-airdrop.mjs";
import compareWetransfer from "./pages/content/articles/compare-wetransfer.mjs";
import howtoAndroidToIphone from "./pages/content/articles/howto-android-to-iphone.mjs";
import howtoPcToPhoneWirelessly from "./pages/content/articles/howto-pc-to-phone-wirelessly.mjs";
import howtoLargeFilesWithoutCloud from "./pages/content/articles/howto-large-files-without-cloud.mjs";
import cliGettingStarted from "./pages/content/articles/cli-getting-started.mjs";
import cliBackupSsh from "./pages/content/articles/cli-backup-server-ssh.mjs";
import cliSendToSomeone from "./pages/content/articles/cli-send-to-someone.mjs";
import cliServerToServer from "./pages/content/articles/cli-server-to-server.mjs";
import cliSyncLargeFolder from "./pages/content/articles/cli-sync-large-folder.mjs";
import howtoShareFileExpiringLink from "./pages/content/articles/howto-share-file-expiring-link.mjs";
import guidesSelfHost from "./pages/content/articles/guides-self-host.mjs";
import howtoSendFilesBetweenComputers from "./pages/content/articles/howto-send-files-between-computers.mjs";
import compareCroc from "./pages/content/articles/compare-croc.mjs";
import guidesHowEncryptionWorks from "./pages/content/articles/guides-how-encryption-works.mjs";
import compareGoogleDrive from "./pages/content/articles/compare-google-drive.mjs";
import compareRsync from "./pages/content/articles/compare-rsync.mjs";
import compareFirefoxSend from "./pages/content/articles/compare-firefox-send.mjs";
import {
  buildLegalPages,
  buildLandingPages,
  buildArticlePages,
  buildGuidesIndexPages,
  buildSitemap,
  articleLinksByLang,
  articleGroupsByLang,
} from "./pages/build-pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const legalDocs = [privacy, terms, security];
const articles = [
  compareSnapdrop,
  compareAirdrop,
  compareWetransfer,
  howtoAndroidToIphone,
  howtoPcToPhoneWirelessly,
  howtoLargeFilesWithoutCloud,
  cliGettingStarted,
  cliBackupSsh,
  cliSendToSomeone,
  cliServerToServer,
  cliSyncLargeFolder,
  howtoShareFileExpiringLink,
  guidesSelfHost,
  howtoSendFilesBetweenComputers,
  compareCroc,
  guidesHowEncryptionWorks,
  compareGoogleDrive,
  compareRsync,
  compareFirefoxSend,
];

async function main() {
  const pages = [
    ...buildLegalPages(legalDocs),
    ...buildLandingPages(landing, articleLinksByLang(articles)),
    ...buildArticlePages(articles),
    ...buildGuidesIndexPages(guidesIndex, articleGroupsByLang(articles)),
  ];
  for (const page of pages) {
    const abs = join(publicDir, page.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, page.html, "utf8");
  }
  await writeFile(
    join(publicDir, "sitemap.xml"),
    buildSitemap(legalDocs, { home: true, landing, articles, guidesIndex }),
    "utf8"
  );
  console.log(`gen-pages: wrote ${pages.length} pages + sitemap.xml to public/`);
}

main().catch((err) => {
  console.error("gen-pages failed:", err);
  process.exit(1);
});
