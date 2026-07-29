// web/scripts/pages/content/related-map.mjs — the curated "keep reading" list
// for each article.
//
// Every article used to end with a link to all 35 others. That is a complete
// graph: PageRank flows uniformly, no page is signalled as more related to any
// other, and the carefully placed CTA above it competed with 35 equally-weighted
// links. It also meant the "related" block carried literally zero information —
// diff two articles' lists and the only difference was which one was missing.
//
// Four links, chosen for this article. The rule of thumb used below:
//   - 2 that answer the obvious next question a reader of THIS page has
//   - 1 from a different category, so the graph is not three disconnected islands
//   - 1 concept/trust page (encryption, is-it-safe, what-is-p2p) where it fits
//
// The full index still lives at /guides/, which is linked from every article
// footer — nothing is orphaned by trimming this (site-graph.test.mjs enforces
// that, and related-map.test.mjs enforces the shape of this file).
export const RELATED = {
  // ── compare/* — a reader here is choosing between tools ──────────────────
  "compare/airdrop": [
    "how-to/airdrop-for-windows-and-android",
    "how-to/transfer-files-android-to-iphone",
    "compare/snapdrop",
    "how-to/send-files-on-the-same-wifi",
  ],
  "compare/croc": [
    "compare/magic-wormhole",
    "guides/transfer-files-from-terminal",
    "guides/send-a-file-to-someone",
    "guides/what-is-peer-to-peer-file-transfer",
  ],
  "compare/dropbox": [
    "compare/google-drive",
    "how-to/share-a-file-with-an-expiring-link",
    "how-to/send-large-files-without-cloud",
    "guides/how-relayium-encrypts-your-files",
  ],
  "compare/firefox-send": [
    "how-to/share-a-file-with-an-expiring-link",
    "compare/wetransfer",
    "guides/how-relayium-encrypts-your-files",
    "guides/is-it-safe-to-send-files-over-the-internet",
  ],
  "compare/google-drive": [
    "compare/dropbox",
    "how-to/send-large-files-without-cloud",
    "how-to/share-a-file-with-an-expiring-link",
    "guides/is-it-safe-to-send-files-over-the-internet",
  ],
  "compare/localsend": [
    "how-to/send-files-on-the-same-wifi",
    "compare/snapdrop",
    "compare/airdrop",
    "guides/what-is-peer-to-peer-file-transfer",
  ],
  "compare/magic-wormhole": [
    "compare/croc",
    "guides/send-a-file-to-someone",
    "guides/transfer-files-from-terminal",
    "guides/how-relayium-encrypts-your-files",
  ],
  "compare/nextcloud": [
    "guides/self-host-relayium",
    "guides/bring-your-own-node",
    "compare/dropbox",
    "how-to/share-a-file-with-an-expiring-link",
  ],
  "compare/rsync": [
    "guides/sync-a-large-folder-between-servers",
    "compare/scp",
    "guides/server-to-server-transfers",
    "how-to/automate-server-backups",
  ],
  "compare/scp": [
    "guides/back-up-a-server-over-ssh",
    "compare/rsync",
    "guides/server-to-server-transfers",
    "guides/transfer-files-from-terminal",
  ],
  "compare/snapdrop": [
    "how-to/send-files-on-the-same-wifi",
    "compare/localsend",
    "compare/airdrop",
    "guides/what-is-peer-to-peer-file-transfer",
  ],
  "compare/wetransfer": [
    "how-to/share-a-file-with-an-expiring-link",
    "compare/firefox-send",
    "how-to/send-large-files-without-cloud",
    "guides/is-it-safe-to-send-files-over-the-internet",
  ],

  // ── guides/* — concepts, CLI tasks and self-hosting ──────────────────────
  "guides/back-up-a-server-over-ssh": [
    "how-to/automate-server-backups",
    "guides/server-to-server-transfers",
    "compare/scp",
    "guides/sync-a-large-folder-between-servers",
  ],
  "guides/bring-your-own-node": [
    "guides/self-host-relayium",
    "guides/run-relayium-as-an-always-on-service",
    "guides/how-relayium-encrypts-your-files",
    "compare/nextcloud",
  ],
  "guides/how-relayium-encrypts-your-files": [
    "guides/is-it-safe-to-send-files-over-the-internet",
    "guides/what-is-peer-to-peer-file-transfer",
    "how-to/share-a-file-with-an-expiring-link",
    "guides/self-host-relayium",
  ],
  "guides/is-it-safe-to-send-files-over-the-internet": [
    "guides/how-relayium-encrypts-your-files",
    "how-to/share-a-file-with-an-expiring-link",
    "guides/what-is-peer-to-peer-file-transfer",
    "how-to/send-large-files-without-cloud",
  ],
  "guides/push-to-cloud-pull-on-another-computer": [
    "guides/transfer-files-from-terminal",
    "guides/send-a-file-to-someone",
    "how-to/share-a-file-with-an-expiring-link",
    "guides/receive-files-from-the-command-line",
  ],
  "guides/receive-files-from-the-command-line": [
    "guides/send-a-file-to-someone",
    "guides/run-relayium-as-an-always-on-service",
    "guides/transfer-files-from-terminal",
    "compare/croc",
  ],
  "guides/run-relayium-as-an-always-on-service": [
    "guides/receive-files-from-the-command-line",
    "guides/server-to-server-transfers",
    "how-to/automate-server-backups",
    "guides/bring-your-own-node",
  ],
  "guides/self-host-relayium": [
    "guides/bring-your-own-node",
    "compare/nextcloud",
    "guides/how-relayium-encrypts-your-files",
    "guides/run-relayium-as-an-always-on-service",
  ],
  "guides/send-a-file-to-someone": [
    "guides/receive-files-from-the-command-line",
    "guides/transfer-files-from-terminal",
    "compare/croc",
    "how-to/send-files-between-two-computers-over-the-internet",
  ],
  "guides/server-to-server-transfers": [
    "guides/sync-a-large-folder-between-servers",
    "guides/back-up-a-server-over-ssh",
    "compare/rsync",
    "guides/run-relayium-as-an-always-on-service",
  ],
  "guides/sync-a-large-folder-between-servers": [
    "compare/rsync",
    "guides/server-to-server-transfers",
    "how-to/automate-server-backups",
    "guides/back-up-a-server-over-ssh",
  ],
  "guides/transfer-files-from-terminal": [
    "guides/send-a-file-to-someone",
    "guides/receive-files-from-the-command-line",
    "guides/push-to-cloud-pull-on-another-computer",
    "compare/croc",
  ],
  "guides/what-is-peer-to-peer-file-transfer": [
    "guides/how-relayium-encrypts-your-files",
    "guides/is-it-safe-to-send-files-over-the-internet",
    "how-to/send-files-between-two-computers-over-the-internet",
    "how-to/send-files-on-the-same-wifi",
  ],

  // ── how-to/* — a reader here has a task in hand ──────────────────────────
  "how-to/airdrop-for-windows-and-android": [
    "compare/airdrop",
    "how-to/send-files-on-the-same-wifi",
    "how-to/transfer-files-between-mac-and-windows",
    "compare/localsend",
  ],
  "how-to/automate-server-backups": [
    "guides/back-up-a-server-over-ssh",
    "guides/run-relayium-as-an-always-on-service",
    "guides/sync-a-large-folder-between-servers",
    "compare/rsync",
  ],
  "how-to/send-a-folder": [
    "how-to/send-large-files-without-cloud",
    "guides/sync-a-large-folder-between-servers",
    "how-to/send-files-between-two-computers-over-the-internet",
    "guides/what-is-peer-to-peer-file-transfer",
  ],
  "how-to/send-files-between-two-computers-over-the-internet": [
    "how-to/transfer-files-by-scanning-a-qr-code",
    "how-to/send-files-on-the-same-wifi",
    "guides/what-is-peer-to-peer-file-transfer",
    "how-to/send-large-files-without-cloud",
  ],
  "how-to/send-files-on-the-same-wifi": [
    "how-to/airdrop-for-windows-and-android",
    "how-to/transfer-files-between-mac-and-windows",
    "compare/localsend",
    "guides/what-is-peer-to-peer-file-transfer",
  ],
  "how-to/send-files-pc-to-phone-wirelessly": [
    "how-to/transfer-files-android-to-iphone",
    "how-to/transfer-files-by-scanning-a-qr-code",
    "how-to/send-files-on-the-same-wifi",
    "compare/airdrop",
  ],
  "how-to/send-large-files-without-cloud": [
    "how-to/send-a-folder",
    "how-to/share-a-file-with-an-expiring-link",
    "compare/wetransfer",
    "guides/what-is-peer-to-peer-file-transfer",
  ],
  "how-to/share-a-file-with-an-expiring-link": [
    "compare/wetransfer",
    "guides/how-relayium-encrypts-your-files",
    "how-to/send-large-files-without-cloud",
    "guides/is-it-safe-to-send-files-over-the-internet",
  ],
  "how-to/transfer-files-android-to-iphone": [
    "how-to/send-files-pc-to-phone-wirelessly",
    "compare/airdrop",
    "how-to/transfer-files-by-scanning-a-qr-code",
    "how-to/send-files-on-the-same-wifi",
  ],
  "how-to/transfer-files-between-mac-and-windows": [
    "how-to/send-files-on-the-same-wifi",
    "how-to/airdrop-for-windows-and-android",
    "compare/airdrop",
    "how-to/send-files-between-two-computers-over-the-internet",
  ],
  "how-to/transfer-files-by-scanning-a-qr-code": [
    "how-to/send-files-pc-to-phone-wirelessly",
    "how-to/send-files-between-two-computers-over-the-internet",
    "how-to/transfer-files-android-to-iphone",
    "guides/what-is-peer-to-peer-file-transfer",
  ],
};
