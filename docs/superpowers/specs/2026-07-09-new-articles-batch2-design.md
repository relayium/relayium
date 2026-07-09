# New articles batch 2 (15) — design

**Date:** 2026-07-09
**Status:** Approved slate (user: "write them all")

## Goal

Add 15 more content articles (all 6 languages) covering remaining feature gaps, high-intent
competitor comparisons, platform long-tail how-tos, and educational/trust pieces. After registration +
regeneration they auto-appear in the `/guides` hub and `sitemap.xml`.

Inventory after this batch: 34 articles — guides 11, how-to 11, compare 12.

## Binding constraints & schema (same as batch 1)

- **Non-negotiable factual constraints:** every article MUST honor the constraints in
  `docs/superpowers/specs/2026-07-09-new-articles-batch-design.md` § "Non-negotiable factual constraints"
  (accounts, encryption realtime vs stored, stored links/expiry, connectivity/TURN, file cap, CLI
  commands/flags, self-host, license). They bind here identically. In particular:
  - Same-network (LAN) transfers need **no account**; cross-network pairing code requires the **sender**
    to sign in; the **receiver never needs an account**; stored links require the sender to sign in.
  - Realtime = X25519 + AES-256-GCM + SAS + SHA-256; stored/async = **random** AES-256-GCM key, no key
    exchange, key in URL `#` fragment, server holds ciphertext (do NOT say "never touches the server" for
    stored mode). Expiry 1h/1d/3d/7d or burn-after-read.
  - **The CLI pairing-code mode does NOT interoperate with the browser's today** (different handshakes,
    shared rendezvous only) — never claim CLI↔browser interop; note it's on the roadmap if relevant.
  - No paid/upgrade tier exists — never say "upgrade".
  - CLI exact surface: `push`/`pull` (SSH; `push` also `relayium://` daemon-direct; **`pull` needs relayium
    on the remote, no tar fallback**), `sync <src...> <dest> [--delete] [--watch]`, `send`/`receive`,
    `serve [--dir D] [--port N] [--once] [--allow-delete]` (default port **9031**, interactive first-push
    approval), `authorize <fingerprint>`, `id`, `version`; flags `-i`/`-p`/`--no-resume` (push/pull/serve)
    /`--config-dir` (default `~/.config/relayium`). Daemon-direct = pinned TLS 1.3, TOFU-then-pin. Install:
    `curl -fsSL https://relayium.com/install.sh | sh`.
- **Article schema:** identical to batch 1 — see that spec's "Article schema (match existing files
  exactly)" section (`{title, description, updatedLabel, lead[], sections[], faq?, cta, relatedHeading}`
  per lang; export `{slug, updated: "2026-07-09", langs:{en,zh,ja,ko,de,fr}}`; localized
  updatedLabel/relatedHeading/faq.heading; command/code snippets stay English). CTA `href: "/cli"` for
  CLI/self-host/ops articles; omit (defaults to the app) for browser-mode articles.

## Additional feature facts for this batch (verified in code)

- **QR code:** `web/src/lib/CodePairing.svelte` renders a QR of the join link (dynamic `import("qrcode")`);
  the QR encodes the same join link the pairing code produces. This is the **cross-network** pairing flow
  (sender signs in; receiver scans/opens the link, no account). QR is a convenience — the code/link still
  work if it fails.
- **Folder send (browser):** `web/src/lib/drag.ts` (`webkitdirectory`, relative paths), `platform.ts`
  `folderUploadSupported = !isIOS()` (iOS can't pick folders), up to **1,000 files/batch**. On the
  RECEIVING side, browsers without the File System Access API (Firefox/Safari) get the folder as one
  **store-only .zip** preserving relative paths (`web/src/lib/zip.ts`, <4 GiB, no ZIP64); Chrome/Edge write
  files straight to a chosen directory.
- **LAN mode (no code):** `server/internal/signal/route.go` `RoomFor` — without a pairing code the room is
  derived from the client IP (same public IP / same network), unlimited peers, `lan=true`. So two devices
  "on the same network just open relayium.com and see each other," no account, no code.
- **CLI receive/serve:** `receive <code> [destdir]` receives a cross-network pairing-code send;
  `serve [--dir D] [--port N=9031] [--once] [--allow-delete]` listens for daemon-direct `relayium://`
  pushes with interactive first-push fingerprint approval; `authorize <fingerprint>` pre-authorizes for
  non-interactive/systemd use; `id` prints this host's fingerprint. Ground in `server/cmd/relayium/serve.go`,
  `daemon.go`, `run.go`.
- **Self-host / ops:** root `Dockerfile` + `docker-compose.yml` (`docker compose up -d --build`),
  `RELAYIUM_*` env in `server/.env.example`, optional `--profile relay` (coturn + redis, `RELAYIUM_TURN_SECRET`),
  docs in `docs/DEPLOYMENT.md`, `docs/coturn.md`, `docs/enable-turn.md`. MIT, github.com/relayium/relayium.

## The 15 articles

### A. Feature-gap fillers

**A1. `how-to/transfer-files-by-scanning-a-qr-code`** — file `howto-transfer-by-qr-code.mjs`
- Title: "Transfer files by scanning a QR code". Keyword: transfer files with a QR code / QR file transfer.
- Angle: the pairing flow with the QR — sender (signed in) creates a code, a QR of the join link appears,
  the other person scans it with their phone camera and the transfer connects (direct P2P, SAS). No app to
  install; receiver needs no account. Ground: `CodePairing.svelte`, `share.ts`. CTA opens app.

**A2. `guides/receive-files-from-the-command-line`** — file `guides-receive-from-cli.mjs`
- Title: "Receive files from the command line". Keyword: receive files terminal / CLI receive.
- Angle: the receiving side of the CLI (complements the send-side guides). Three ways to receive: `receive
  <code>` (someone sends you across networks by pairing code), `serve` (listen for daemon-direct
  `relayium://` pushes, approve the first push interactively or pre-`authorize` a fingerprint), and `pull`
  (you fetch from a server you can ssh into — needs relayium on the remote). Ground: `serve.go`, `run.go`,
  `daemon.go`. CTA → `/cli`.

**A3. `how-to/send-a-folder`** — file `howto-send-a-folder.mjs`
- Title: "How to send a whole folder, not just files". Keyword: send a folder online / transfer a folder.
- Angle: browser folder send — pick a folder (Chrome/Edge/Firefox desktop; not iOS), relative paths
  preserved, up to 1,000 files, each SHA-256 verified. Receiving side: Chrome/Edge write into a chosen
  directory; Firefox/Safari download one .zip that unpacks to the same structure. Realtime P2P (nothing
  stored) or a stored link. Ground: `drag.ts`, `platform.ts`, `zip.ts`. CTA opens app.

**A4. `guides/run-relayium-as-an-always-on-service`** — file `guides-always-on-service.mjs`
- Title: "Run Relayium as an always-on receive service". Keyword: relayium systemd / always-on file
  receiver / self-hosted drop server.
- Angle: keep `relayium serve` running so machines can push to it any time. Cover: `serve --dir --port
  --allow-delete`; first-push interactive approval vs non-interactive `authorize <fingerprint>` (get the
  pusher's `id`); running under systemd (a sample unit); daemon-direct `relayium://host:9031` pinned TLS.
  Ops/self-host audience. Ground: `serve.go`, `daemon.go`, `run.go`. CTA → `/cli`.

**A5. `how-to/automate-server-backups`** — file `howto-automate-server-backups.mjs`
- Title: "Automate encrypted server backups with a cron job". Keyword: automated server backup / cron file
  backup / scheduled backup over SSH.
- Angle: schedule `relayium push` (or `sync`) from cron to copy a directory to another machine on a
  schedule — encrypted, resumable, SHA-256-verified, incremental with `sync`. Show a crontab example and
  both transports (SSH `user@host:dest`, daemon-direct `relayium://`). Note `pull` needs relayium on the
  remote. Ground: `run.go`, `sync.go`. CTA → `/cli`.

### B. Competitor comparisons

**B1. `compare/localsend`** — file `compare-localsend.mjs`
- Title: "Relayium vs LocalSend: which local file transfer to use". Keyword: LocalSend alternative /
  LocalSend vs.
- Angle: LocalSend is a popular open-source cross-platform LAN app (needs an install on each device).
  Relayium's LAN mode runs in the browser (nothing to install) AND adds cross-network (pairing code) and
  a CLI. Fair: LocalSend is offline-only/no-server and app-based; describe it accurately. Relayium LAN =
  no account, no install. CTA opens app.

**B2. `compare/scp`** — file `compare-scp.mjs`
- Title: "Relayium vs scp: simpler file transfer over SSH". Keyword: scp alternative / easier than scp.
- Angle: `relayium push`/`pull` ride your existing SSH just like scp, but add per-file resume, SHA-256,
  progress, and a tar fallback for `push` on a bare server (no relayium needed remotely for push; pull
  needs it). Plus daemon-direct and cross-network modes scp doesn't have. Fair: scp is universal/preinstalled.
  Ground: `run.go`, `sshx`. CTA → `/cli`.

**B3. `compare/magic-wormhole`** — file `compare-magic-wormhole.mjs`
- Title: "Relayium vs magic-wormhole: CLI file transfer". Keyword: magic-wormhole alternative.
- Angle: both are code-based encrypted CLI transfer tools. Describe magic-wormhole fairly (PAKE, short
  codes, relay-assisted). Relayium adds SSH push/pull, daemon-direct pinned TLS, folder `sync`, self-host,
  browser app. Honest: magic-wormhole's relay completes transfers behind strict NAT; Relayium's CLI
  cross-network is direct-only (fails without a direct path). CTA → `/cli`.

**B4. `compare/nextcloud`** — file `compare-nextcloud.mjs`
- Title: "Relayium vs Nextcloud for sending files". Keyword: Nextcloud file sharing alternative / lighter
  than Nextcloud.
- Angle: Nextcloud is a full self-hosted cloud (storage, sync, apps) — great if you want durable storage;
  heavy to run. Relayium is focused on transfer: direct P2P or zero-knowledge ephemeral links, optional
  self-host that's a single container. Fair to Nextcloud's breadth. CTA opens app (or `/cli`).

**B5. `compare/dropbox`** — file `compare-dropbox.mjs`
- Title: "Relayium vs Dropbox for sending a file". Keyword: send files without Dropbox.
- Angle: like the Google Drive piece but Dropbox-framed and kept distinct (focus on shared-link sending
  and the "I don't want it sitting in someone's cloud" concern). Dropbox = durable sync/storage; Relayium =
  direct/ephemeral. Don't duplicate the Drive article's exact wording. CTA opens app.

### C. Platform / long-tail how-tos (distinct primary keywords — cross-link, don't duplicate)

**C1. `how-to/airdrop-for-windows-and-android`** — file `howto-airdrop-for-windows-android.mjs`
- Title: "AirDrop for Windows, Linux and Android". Keyword: AirDrop for Windows / AirDrop for Android /
  AirDrop alternative cross-platform.
- Angle: the "AirDrop-like" experience for non-Apple / mixed fleets — same-network instant sharing in the
  browser (no account, no install), plus across-the-internet via pairing code. Distinct from the existing
  `compare/airdrop` (which is a head-to-head) — this is the "AirDrop equivalent for X" how-to intent.

**C2. `how-to/transfer-files-between-mac-and-windows`** — file `howto-mac-to-windows.mjs`
- Title: "Transfer files between a Mac and a Windows PC". Keyword: transfer files Mac to Windows / Windows
  to Mac. Angle: the specific cross-OS pair, both same-network and over the internet; browser-based, no
  install. Distinct keyword from the generic pieces.

**C3. `how-to/send-files-on-the-same-wifi`** — file `howto-same-wifi.mjs`
- Title: "Send files between devices on the same Wi-Fi". Keyword: send files over Wi-Fi / same network /
  local file transfer. Angle: the LAN mode explainer — open relayium.com on both devices on the same
  network, no account, no code, direct P2P. Distinct from the device-pair how-tos (this is the generic
  same-network intent). Ground: `route.go` LAN room.

### D. Educational / trust

**D1. `guides/what-is-peer-to-peer-file-transfer`** — file `guides-what-is-p2p-file-transfer.mjs`
- Title: "What is peer-to-peer file transfer?". Keyword: what is p2p file transfer / p2p file sharing
  explained. Angle: plain explainer of P2P transfer (vs upload-to-cloud), how WebRTC direct connections
  work, when a relay (TURN) is needed and that it only sees ciphertext, why P2P is private/fast. Uses
  Relayium as the worked example without being a hard sell. CTA opens app.

**D2. `guides/is-it-safe-to-send-files-over-the-internet`** — file `guides-is-it-safe.mjs`
- Title: "Is it safe to send files over the internet?". Keyword: is it safe to send files online / secure
  file transfer. Angle: broader safety piece (risks of email/cloud/USB, what end-to-end encryption and
  zero-knowledge mean, what to check). Complements — does NOT duplicate — the batch-1
  `guides/how-relayium-encrypts-your-files` (that one is the mechanism; this one is the layperson "is it
  safe / what to look for" framing). Cross-link to it. CTA opens app.

## Implementation

1. Write the 15 content `.mjs` files under `web/scripts/pages/content/articles/` (each 6 languages).
   Independent files → one writer per article in parallel; each writer reads a sibling for tone, reads the
   grounding code/docs, honors the constraints, and passes `validateLangs`. **Writers create only their
   own file — no git, no gen:pages, no build** (avoids the index/public races seen before).
2. Integrator registers all 15 in `web/scripts/pages/gen-pages.mjs` (imports + `articles` array).
3. `cd web && npm run gen:pages`; then `npm test -- --run` + `npm run build` must pass.
4. Commit source `.mjs` + `gen-pages.mjs` + regenerated `public/**` together.

## Verification

- `gen:pages` succeeds (proves all 6 langs per article). New pages exist at both `public/<slug>/` and
  `public/<lang>/<slug>/`. `/guides` hub lists 34; sitemap gains 15×6 = 90 URLs.
- `npm test -- --run` + `npm run build` clean.
- Spot-check accuracy against the constraints (accounts, stored-mode wording, CLI flags, no
  CLI↔browser-interop claim, no "upgrade", expiry options).
- Cross-cutting: the three near-neighbor LAN how-tos (C1/C2/C3 + existing pc-to-phone) each lead with a
  distinct primary keyword and cross-link rather than repeat.
