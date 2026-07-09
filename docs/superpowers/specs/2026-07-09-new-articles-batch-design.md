# New articles batch (8) — design

**Date:** 2026-07-09
**Status:** Approved slate (pending spec review)

## Goal

Add 8 new content articles to the Guides system, filling real feature/competitor gaps and
strengthening long-tail SEO. Each is a self-contained content module in all 6 languages
(en/zh/ja/ko/de/fr), matching the existing article pattern. After registration + regeneration,
they auto-appear in the `/guides` hub (grouped by slug prefix) and in `sitemap.xml`.

Inventory after this batch: 19 articles — guides 7, how-to 5, compare 7.

## Non-negotiable factual constraints (from the 2026-07-09 code audit)

Every article MUST honor these. Getting them wrong reintroduces the drift we just fixed.

- **Accounts (web):** same-network (LAN) transfers need no account; sending across networks via a
  **pairing code requires the sender to sign in**; the **receiver never needs an account**; creating
  a **stored download link requires the sender to sign in**.
- **Accounts (CLI):** the CLI is completely free, needs no account for any mode (separate rendezvous
  path with no auth), and is self-hostable via `--server`.
- **Encryption (realtime P2P):** X25519 key exchange (libsodium `crypto_kx`) + AES-256-GCM;
  a short **SAS verification code** via commit-then-reveal defeats a malicious signaling server;
  per-file **SHA-256** integrity; resumable transfers.
- **Encryption (stored/async):** a **random** AES-256-GCM key generated in the browser (NO X25519 key
  exchange); the key lives only in the URL **#fragment**; the server stores **ciphertext it cannot
  decrypt** (zero-knowledge). Do not claim "files never touch the server" for this mode.
- **Stored links:** expiry options are **1 hour, 1 day, 3 days, 7 days**, or **burn after first
  complete download**; count against a storage quota; sender must sign in; recipient needs no account.
- **Connectivity:** direct P2P when possible; falls back to a **TURN relay that only sees ciphertext**;
  relay bytes are metered **per account** (monthly relay allowance). No paid/upgrade tier exists yet —
  never tell a user to "upgrade".
- **File cap:** up to **1,000 files per batch** (realtime); no server-side size cap in realtime (limit
  is the receiving browser: Chrome/Edge stream to disk = tens of GB; Firefox/Safari buffer ≈ keep
  <200 MB).
- **CLI commands/flags (exact):** `push`/`pull` (SSH; `push` also `relayium://host[:port]` daemon-direct),
  `sync <src...> <dest> [--delete] [--watch]`, `send`/`receive` (pairing code), `serve [--dir D] [--port N]
  [--once] [--allow-delete]` (default port **9031**; interactive first-push approval), `authorize
  <fingerprint>`, `id`, `version`. Global flags: `-i <file>`, `-p <port>`, `--no-resume`
  (push/pull/serve only), `--config-dir D` (default `~/.config/relayium`). **`pull` requires relayium on
  the remote (no tar fallback); only `push` falls back to a tar stream.** Daemon-direct is pinned TLS 1.3,
  TOFU-then-pin. Install: `curl -fsSL https://relayium.com/install.sh | sh`.
- **Self-host:** root `Dockerfile` + `docker-compose.yml` → `docker compose up -d --build`; env keys
  `RELAYIUM_ADDR`/`RELAYIUM_STATIC`/`RELAYIUM_DB`/`RELAYIUM_BLOB_DIR` (see `server/.env.example`); optional
  `--profile relay` adds coturn TURN + redis metering (`RELAYIUM_TURN_SECRET`); guides in
  `docs/DEPLOYMENT.md`, `docs/coturn.md`, `docs/enable-turn.md`. Point the CLI at it with `--server`.
- **License/openness:** MIT, open source on GitHub (`https://github.com/relayium/relayium`).

For **compare/** articles, only the **Relayium-side** claims are verifiable here; competitor facts must be
written accurately from general knowledge and kept fair (no fabricated competitor limitations).

## Article schema (match existing files exactly)

Each file is `web/scripts/pages/content/articles/<name>.mjs`, structured as:

```js
const en = {
  title: "...",            // <title> and <h1>; ≤ ~60 chars ideal for SEO
  description: "...",       // meta description, ~150–160 chars
  updatedLabel: "Last updated",  // localized per language
  lead: ["...", "..."],    // 1–2 intro paragraphs (rendered as .lead)
  sections: [              // 3–5 sections
    { heading: "...", body: ["..."], bullets: ["..."], code: ["..."] }, // bullets/code optional
  ],
  faq: { heading: "Frequently asked questions", items: [ { q: "...", a: "..." } ] }, // 3–5 Q/A
  cta: { text: "...", button: "...", href: "/cli" }, // href optional; omit → opens the app
  relatedHeading: "Keep reading", // localized
};
// ...zh, ja, ko, de, fr with identical structure + facts, localized voice...
export default { slug: "<prefix>/<slug>", updated: "2026-07-09", langs: { en, zh, ja, ko, de, fr } };
```

`updatedLabel`/`relatedHeading`/`faq.heading` localized values (reuse the wording already used across the
existing articles): updatedLabel — Last updated / 最近更新 / 最終更新 / 마지막 업데이트 / Zuletzt aktualisiert
/ Dernière mise à jour. relatedHeading — Keep reading / 继续阅读 / 続けて読む / 계속 읽기 / Weiterlesen / À
lire ensuite. faq.heading — Frequently asked questions / 常见问题 / よくある質問 / 자주 묻는 질문 / Häufige
Fragen / Questions fréquentes.

Command/code snippets stay in English in every language (repo convention). CTA `href`: use `/cli` for the
CLI/self-host articles (2, 4, 5-partial); omit (defaults to the app) for the browser-mode articles.

## The 8 articles

### 1. `how-to/share-a-file-with-an-expiring-link` — Async/stored mode
- **Title:** "Share a file with a secure, expiring download link"
- **Keyword:** send a file with a link that expires / self-destructing file link.
- **Angle:** the recipient is offline or you just want a link. Browser encrypts (AES-256-GCM), uploads
  zero-knowledge ciphertext, you get a link (key in the `#` fragment). Set expiry 1h/1d/3d/7d or
  burn-after-read. Recipient needs no account; **sender signs in** to create the link.
- **Sections:** what async mode is & when to use it vs realtime; how to create a link (steps); expiry &
  burn-after-read; the zero-knowledge guarantee (key in fragment, server can't decrypt) + honest limits
  (storage quota, sign-in to create). **FAQ:** does the recipient need an account (no); can the server
  read my file (no); how long do links last; is it really deleted after download.

### 2. `guides/self-host-relayium` — Self-hosting
- **Title:** "Self-host Relayium: run your own file-transfer server"
- **Keyword:** self-hosted file transfer / self-host encrypted file sharing.
- **Angle:** run the whole stack yourself for full control. Grounded in `docker-compose.yml` /
  `docs/DEPLOYMENT.md`.
- **Sections:** why self-host (privacy/control, MIT); quick start (`docker compose up -d --build`, the
  `RELAYIUM_*` env keys, what the single image serves); optional TURN relay for cross-network
  (`--profile relay` + `RELAYIUM_TURN_SECRET`, ref docs/coturn.md); point the CLI at it (`relayium ...
  --server https://your-domain`). **FAQ:** do I need TURN (only for cross-network NAT traversal); is the
  CLI free (yes); can I use my own domain/TLS; what data does my server store. CTA → `/cli`.

### 3. `how-to/send-files-between-two-computers-over-the-internet` — Browser cross-network
- **Title:** "Send files between two computers over the internet"
- **Keyword:** send files between computers over the internet / without cloud / peer to peer.
- **Angle:** the browser cross-network pairing-code flow, generalized (vs the device-specific how-tos).
- **Sections:** the direct approach (no cloud middleman); same-network vs across-the-internet (LAN needs
  no account; **cross-network pairing code: sender signs in**, receiver doesn't); step-by-step (open
  relayium.com, sign in, create a code/link, other side joins, verify SAS, transfer); what happens behind
  a strict NAT (TURN relay, ciphertext only). **FAQ:** is it really peer-to-peer; do both need accounts;
  does it work across different networks/countries; is there a size limit (1,000 files/batch, browser-bound).

### 4. `compare/croc` — CLI vs CLI
- **Title:** "Relayium vs croc: encrypted file transfer from the terminal"
- **Keyword:** croc alternative / encrypted CLI file transfer.
- **Angle:** both are free, open-source, encrypted CLI P2P tools. Fair comparison; Relayium's extra
  surface: SSH `push`/`pull` (works against a bare server via tar fallback for push), daemon-direct
  `relayium://` over pinned TLS, incremental folder `sync` (`--delete`/`--watch`), and a self-hostable
  server. **Relayium-side claims must match the audit; describe croc accurately/fairly.**
  CORRECTION (found during writing): the CLI pairing-code mode does NOT interoperate with the browser's
  today (different handshakes, shared rendezvous only) — do not claim "browser interop"; the FAQ states it
  honestly as not-yet/roadmap.
- **Sections:** what they share; where Relayium differs (the modes above); when croc is the simpler pick.
  **FAQ:** is Relayium's CLI free (yes); does it need an account (no); can it talk to a browser (yes, via
  pairing code); can I self-host. CTA → `/cli`.

### 5. `guides/how-relayium-encrypts-your-files` — Encryption explainer (trust)
- **Title:** "How Relayium encrypts your files end-to-end"
- **Keyword:** is Relayium secure / end-to-end encrypted file transfer explained.
- **Angle:** plain-language trust piece. **Sections:** realtime E2E (X25519 + AES-256-GCM, keys negotiated
  only between the two devices); the SAS verification code (commit-then-reveal, why it stops a malicious
  server); integrity (SHA-256 per file); stored/async zero-knowledge (random key in the URL fragment,
  server holds ciphertext); what the server can and cannot see (signaling relays connection info only;
  TURN relay sees ciphertext only; relay bytes counted per account). **FAQ:** can Relayium read my files
  (no); what does the server see; is the relay a weak point (ciphertext only); is it open source (yes, MIT).

### 6. `compare/google-drive` — vs cloud storage
- **Title:** "Relayium vs Google Drive for sending files"
- **Keyword:** send files without Google Drive / share files without uploading to the cloud.
- **Angle:** Drive is great storage but for a one-off hand-off it means uploading your file to Google's
  servers and managing sharing/permissions. Relayium: direct P2P (nothing stored) or zero-knowledge
  ephemeral links. Fair: Drive wins for durable storage/collaboration; Relayium wins for private, direct,
  ephemeral transfer. **FAQ:** does Relayium store my files (no in realtime; ciphertext-only for links);
  do I need an account (LAN no; cross-network sender yes); size limits; is it free.

### 7. `compare/rsync` — vs rsync (pairs with the sync feature)
- **Title:** "Relayium vs rsync: sync folders without the SSH setup"
- **Keyword:** rsync alternative / rsync over the internet / sync folders without SSH config.
- **Angle:** rsync is the gold standard but assumes SSH access + config. Relayium `sync` does incremental
  one-way mirror over SSH **or** daemon-direct (`relayium://`, no SSH), with `--delete` and `--watch`,
  pinned TLS 1.3, per-file SHA-256 + resume. Fair: rsync is more mature/flexible (bidirectional, deltas);
  Relayium is simpler to set up across networks and needs no SSH server. **FAQ:** is it a full rsync
  replacement (no — one-way mirror; honest); does it need SSH (no, daemon-direct works); does it delete
  files (only with `--delete`, and `serve --allow-delete`); real-time sync (`--watch`). CTA → `/cli`.

### 8. `compare/firefox-send` — Firefox Send alternative
- **Title:** "The best Firefox Send alternative (2026)"
- **Keyword:** Firefox Send alternative / Firefox Send replacement.
- **Angle:** Firefox Send shut down in 2020; users still search for a private, link-based, expiring
  file-sharing tool. Relayium's async mode is the closest spirit (encrypt in browser, share a link,
  expiry/burn), plus realtime P2P. Honest: state Firefox Send is discontinued; don't overclaim.
  **Sections:** what Firefox Send was & why people liked it; how Relayium's stored links match it
  (zero-knowledge, expiry, burn); what's different/better (also realtime P2P, CLI, self-host).
  **FAQ:** is Firefox Send coming back (no); is Relayium as private (yes, zero-knowledge); does it expire;
  is it free.

## Implementation

1. Write the 8 content `.mjs` files (each 6 languages) under
   `web/scripts/pages/content/articles/`. Files are independent (no shared file) so they can be written
   in parallel — one writer per article. Each writer reads a sibling article for tone and reads the
   relevant repo code/docs to ground facts; honors the constraints above; passes `validateLangs` (all 6
   langs, every required field).
2. Register all 8 in `web/scripts/pages/gen-pages.mjs`: add an `import` per file and add each to the
   `articles` array. (Single file — done once by the integrator, not in parallel, to avoid races.)
3. `cd web && npm run gen:pages` — regenerates `public/**` (new article pages × 6 langs, cross-links, the
   `/guides` hub now listing 19, and `sitemap.xml`). Then `npm test -- --run` + `npm run build` must pass.
4. Commit source `.mjs` + `gen-pages.mjs` + regenerated `public/**` together.

## Verification

- `npm run gen:pages` succeeds (proves all 6 langs present per article via `validateLangs`).
- New pages exist at `public/<prefix>/<slug>/index.html` and `public/<lang>/<prefix>/<slug>/index.html`.
- `/guides` hub HTML lists all 19 articles under the right categories; `sitemap.xml` gains 8×6 = 48 URLs.
- `npm test -- --run` (256+) and `npm run build` clean.
- Spot-check factual accuracy against the constraints list (esp. account requirements, stored-mode
  encryption, CLI flags, expiry options).

## Self-review notes
- Slate approved by user (8 articles, 6 languages, Firefox Send kept).
- Category balance: +2 guides, +2 how-to, +4 compare → 7/5/7.
- Every article maps to a live feature or a real search intent; constraints list prevents copy drift.
