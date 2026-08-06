// web/scripts/pages/content/taxonomy.mjs — which group an article belongs to on
// the guides hub, and in what order inside it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Grouping used to be `slug.split("/")[0]`, which meant the URL decided the
// taxonomy. Three things followed from that and all three were visible to
// readers:
//
//   * Heterogeneous content shared one group. `guides/` held a terminal tutorial,
//     an explainer on what P2P is, and a self-hosting runbook — three different
//     readers, one heading.
//   * `cli-*` articles all live under `guides/` because "cli" was once a fourth
//     category that was merged and never cleaned up. The URL still says guides.
//   * Order inside a group was the order of the import statements, so the two
//     articles a beginner should read first sat below every tutorial.
//
// And the labels made it worse: zh called them 教程 and 操作指南, which are
// synonyms. A grouping a reader cannot tell apart is not a grouping.
//
// ── WHY A TABLE RATHER THAN A FIELD PER FILE ────────────────────────────────
// The recommendation asked for explicit metadata. One table IS explicit — more
// so than 37 files each holding a fragment of a taxonomy, where nothing shows
// you the shape of the whole and a mistake looks the same as a decision. It is
// also checkable: a test asserts every article appears exactly once, so a new
// article cannot quietly inherit a group by virtue of its URL prefix.
//
// URLs are deliberately untouched. The grouping is a reading order, not an
// address; moving 37 slugs to make a hub read better would spend real SEO and
// redirect cost on a navigation change.

/** The five groups, in the order they appear on the hub. */
export const GROUPS = ["scenario", "cli", "selfhost", "concept", "compare"];

/**
 * slug → [group, order].
 *
 * `order` is a reading order within the group, lowest first: a beginner path
 * rather than whatever sequence the imports happen to be in.
 */
export const TAXONOMY = {
  // Scenario tasks — "I have these two devices and this file".
  "how-to/send-files-on-the-same-wifi": ["scenario", 10],
  "how-to/send-files-between-two-computers-over-the-internet": ["scenario", 20],
  "how-to/send-files-pc-to-phone-wirelessly": ["scenario", 30],
  "how-to/transfer-files-android-to-iphone": ["scenario", 40],
  "how-to/transfer-files-between-mac-and-windows": ["scenario", 50],
  "how-to/airdrop-for-windows-and-android": ["scenario", 60],
  "how-to/transfer-files-by-scanning-a-qr-code": ["scenario", 70],
  "how-to/send-a-folder": ["scenario", 80],
  "how-to/send-text-between-devices": ["scenario", 90],
  "how-to/send-large-files-without-cloud": ["scenario", 100],
  "how-to/share-a-file-with-an-expiring-link": ["scenario", 110],

  // Command line — the CLI, wherever its URL happens to sit.
  "guides/transfer-files-from-terminal": ["cli", 10],
  "guides/send-a-file-to-someone": ["cli", 20],
  "guides/receive-files-from-the-command-line": ["cli", 30],
  "guides/sync-a-large-folder-between-servers": ["cli", 40],
  "guides/server-to-server-transfers": ["cli", 50],
  "guides/back-up-a-server-over-ssh": ["cli", 60],
  "how-to/automate-server-backups": ["cli", 70],
  "guides/push-to-cloud-pull-on-another-computer": ["cli", 80],

  // Self-hosting and operations — you are running the thing, not using it.
  "guides/self-host-relayium": ["selfhost", 10],
  "guides/bring-your-own-node": ["selfhost", 20],
  "guides/run-relayium-as-an-always-on-service": ["selfhost", 30],

  // Concepts and safety — read before or instead of doing anything.
  "guides/what-is-peer-to-peer-file-transfer": ["concept", 10],
  "guides/is-it-safe-to-send-files-over-the-internet": ["concept", 20],
  "guides/how-relayium-encrypts-your-files": ["concept", 30],

  // Comparisons.
  "compare/airdrop": ["compare", 10],
  "compare/snapdrop": ["compare", 20],
  "compare/localsend": ["compare", 30],
  "compare/wetransfer": ["compare", 40],
  "compare/firefox-send": ["compare", 50],
  "compare/dropbox": ["compare", 60],
  "compare/google-drive": ["compare", 70],
  "compare/nextcloud": ["compare", 80],
  "compare/croc": ["compare", 90],
  "compare/magic-wormhole": ["compare", 100],
  "compare/scp": ["compare", 110],
  "compare/rsync": ["compare", 120],
};

