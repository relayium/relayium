import { describe, expect, it } from "vitest";
import firefoxSend from "./content/articles/compare-firefox-send.mjs";
import googleDrive from "./content/articles/compare-google-drive.mjs";
import weTransfer from "./content/articles/compare-wetransfer.mjs";
import dropbox from "./content/articles/compare-dropbox.mjs";
import nextcloud from "./content/articles/compare-nextcloud.mjs";
import safety from "./content/articles/guides-is-it-safe.mjs";
import p2p from "./content/articles/guides-what-is-p2p-file-transfer.mjs";
import largeFiles from "./content/articles/howto-large-files-without-cloud.mjs";
import text from "./content/articles/howto-send-text-between-devices.mjs";
import expiringLink from "./content/articles/howto-share-file-expiring-link.mjs";
import folder from "./content/articles/howto-send-a-folder.mjs";

const revisedArticles = [
  firefoxSend,
  googleDrive,
  weTransfer,
  dropbox,
  nextcloud,
  safety,
  p2p,
  largeFiles,
  text,
  expiringLink,
  folder,
];

describe("materially revised article dates", () => {
  it("exposes the current revision date for SEO metadata", () => {
    for (const article of revisedArticles) {
      expect(article.updated, article.slug).toBe("2026-07-31");
    }
  });
});
