// web/scripts/gen-pages.mjs — writes all static pages (legal, landing, articles) + sitemap into public/.
// Run via `npm run gen:pages`; also runs automatically before dev/build.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import privacy from "./pages/content/legal/privacy.mjs";
import terms from "./pages/content/legal/terms.mjs";
import security from "./pages/content/legal/security.mjs";
import landing from "./pages/content/landing.mjs";
import crossNetwork from "./pages/content/cross-network.mjs";
import offlineTransfer from "./pages/content/offline-transfer.mjs";
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
import cliCloudAsync from "./pages/content/articles/cli-cloud-async.mjs";
import howtoShareFileExpiringLink from "./pages/content/articles/howto-share-file-expiring-link.mjs";
import guidesSelfHost from "./pages/content/articles/guides-self-host.mjs";
import howtoSendFilesBetweenComputers from "./pages/content/articles/howto-send-files-between-computers.mjs";
import compareCroc from "./pages/content/articles/compare-croc.mjs";
import guidesHowEncryptionWorks from "./pages/content/articles/guides-how-encryption-works.mjs";
import compareGoogleDrive from "./pages/content/articles/compare-google-drive.mjs";
import compareRsync from "./pages/content/articles/compare-rsync.mjs";
import compareFirefoxSend from "./pages/content/articles/compare-firefox-send.mjs";
import howtoTransferByQrCode from "./pages/content/articles/howto-transfer-by-qr-code.mjs";
import guidesReceiveFromCli from "./pages/content/articles/guides-receive-from-cli.mjs";
import howtoSendAFolder from "./pages/content/articles/howto-send-a-folder.mjs";
import guidesAlwaysOnService from "./pages/content/articles/guides-always-on-service.mjs";
import howtoAutomateServerBackups from "./pages/content/articles/howto-automate-server-backups.mjs";
import compareLocalsend from "./pages/content/articles/compare-localsend.mjs";
import compareScp from "./pages/content/articles/compare-scp.mjs";
import compareMagicWormhole from "./pages/content/articles/compare-magic-wormhole.mjs";
import compareNextcloud from "./pages/content/articles/compare-nextcloud.mjs";
import compareDropbox from "./pages/content/articles/compare-dropbox.mjs";
import howtoAirdropForWindowsAndroid from "./pages/content/articles/howto-airdrop-for-windows-android.mjs";
import howtoMacToWindows from "./pages/content/articles/howto-mac-to-windows.mjs";
import howtoSameWifi from "./pages/content/articles/howto-same-wifi.mjs";
import guidesWhatIsP2pFileTransfer from "./pages/content/articles/guides-what-is-p2p-file-transfer.mjs";
import guidesIsItSafe from "./pages/content/articles/guides-is-it-safe.mjs";
import guidesOwnNode from "./pages/content/articles/guides-own-node.mjs";
import {
  buildLegalPages,
  buildLandingPages,
  buildArticlePages,
  buildGuidesIndexPages,
  buildModePages,
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
  cliCloudAsync,
  howtoShareFileExpiringLink,
  guidesSelfHost,
  howtoSendFilesBetweenComputers,
  compareCroc,
  guidesHowEncryptionWorks,
  compareGoogleDrive,
  compareRsync,
  compareFirefoxSend,
  howtoTransferByQrCode,
  guidesReceiveFromCli,
  howtoSendAFolder,
  guidesAlwaysOnService,
  howtoAutomateServerBackups,
  compareLocalsend,
  compareScp,
  compareMagicWormhole,
  compareNextcloud,
  compareDropbox,
  howtoAirdropForWindowsAndroid,
  howtoMacToWindows,
  howtoSameWifi,
  guidesWhatIsP2pFileTransfer,
  guidesIsItSafe,
  guidesOwnNode,
];

async function main() {
  const pages = [
    ...buildLegalPages(legalDocs),
    ...buildLandingPages(landing, articleLinksByLang(articles)),
    ...buildArticlePages(articles),
    ...buildGuidesIndexPages(guidesIndex, articleGroupsByLang(articles)),
    ...buildModePages(crossNetwork, { slug: "cross-network" }),
    ...buildModePages(offlineTransfer, {
      slug: "offline-transfer",
      learn: articleLinksByLang([cliCloudAsync]),
    }),
  ];
  for (const page of pages) {
    const abs = join(publicDir, page.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, page.html, "utf8");
  }
  await writeFile(
    join(publicDir, "sitemap.xml"),
    buildSitemap(legalDocs, {
      home: true,
      landing,
      articles,
      guidesIndex,
      modes: [
        { def: crossNetwork, slug: "cross-network" },
        { def: offlineTransfer, slug: "offline-transfer" },
      ],
    }),
    "utf8"
  );
  console.log(`gen-pages: wrote ${pages.length} pages + sitemap.xml to public/`);
}

main().catch((err) => {
  console.error("gen-pages failed:", err);
  process.exit(1);
});
