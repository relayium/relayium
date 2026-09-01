<p align="center">
  <img src="web/public/og-image.jpg" alt="Relayium — end-to-end encrypted peer-to-peer file and text transfer" width="640">
</p>

<h1 align="center">Relayium</h1>

<p align="center">
  <strong>Open-source, end-to-end encrypted peer-to-peer file transfer — and ephemeral encrypted text — right in your browser.</strong><br>
  On a LAN, realtime files and messages move directly between devices; across networks, an encrypted relay forwards only ciphertext it cannot read.
</p>

<p align="center">
  <a href="https://relayium.com/"><img src="https://img.shields.io/badge/live%20demo-relayium.com-aa3bff" alt="Live demo"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0%20%2F%20Apache--2.0-blue" alt="License: AGPL-3.0 (server, web) / Apache-2.0 (apps)"></a>
  <img src="https://img.shields.io/badge/status-active%20development-2ea44f" alt="Status: Active development">
  <img src="https://img.shields.io/badge/built%20with-Go%20%C2%B7%20Svelte%20%C2%B7%20WebRTC-2ea44f" alt="Built with Go, Svelte, WebRTC">
</p>

---

## What is Relayium?

Relayium is a serious attempt at a **next-generation file and ephemeral text transfer protocol**:
press one button to send, and the software picks the right path while keeping content
**end-to-end encrypted by default** — the keys only ever exist on the sender and the receiver.

Two up-to-date browsers do not choose between the two at all — on a LAN and in a pairing-code
(cross-network) room alike. Picking the other device opens **one shared workspace**: a single
end-to-end encrypted connection with one verification step, a composer visible by default and the
file and folder controls under it, so files and messages travel together without reconnecting
between them. Across networks that same one connection is carried by the encrypted relay, which
forwards only ciphertext, and it runs under a bounded lifetime derived from the relay credential —
the workspace warns before that boundary and ends the link truthfully at it. A browser peer that
does not announce this exact capability — an older Relayium Web build — is shown a notice saying so
and offered no transfer controls, rather than a quietly degraded path: the separate file and message
flows the Web client used to fall back to have been removed. The released macOS client and the CLI
are not that fallback; they are current clients connecting over their own supported protocol
surfaces — see **Delivery status** below for what each one ships today.

The same protocol also carries **ephemeral text**. When both devices are online, a message session
opens an independent end-to-end encrypted connection — with its own optional verification code to compare — and carries a link,
a command, or a block of multiline code instead of a file. (Inside the shared workspace above it is
not a separate connection: that message lane rides the one link you already verified.)
On a LAN, browser messages move directly;
cross-network browser sessions use TURN that carries only ciphertext; CLI text is direct-only.
Messages are session-scoped:
never stored by Relayium, and gone from its session when that session ends. There is no offline messaging
or server-side history, though either endpoint can retain received text — one message is at most
**65,536 UTF-8 bytes**, delivered byte for byte,
and anything larger is a file.

The production web app and CLI are live, and the CLI and node binaries are still
in **pre-1.0 versioning** (`v0.x`). The macOS app is on its own track and is at
**1.3.9**: a universal, Developer ID-signed, Apple-notarized and stapled
build, published as a direct download from its own GitHub Release,
[`macos-v1.3.9`](https://github.com/relayium/relayium/releases/tag/macos-v1.3.9).
A separately versioned Mac App Store release is also public, currently
[1.3.8](https://apps.apple.com/app/id6801142976); the two channels ship the same
product behaviour on independent version lines. There is no Relayium app for
iOS, Android or Windows — on those platforms the browser is the client, and
Windows and Linux can also install the CLI.

> 👉 **Try it now: [relayium.com](https://relayium.com/)** — use two devices on
> the same LAN without an account, or sign in to create a cross-network pairing
> code.

## Why not just use Snapdrop / PairDrop?

Those are great, and Relayium starts from the same "browser + WebRTC + LAN-style" idea. The difference
is **how seriously we take end-to-end encryption**:

- **App-layer E2E + SAS, not just WebRTC's DTLS.** WebRTC's DTLS fingerprints are exchanged *through the
  signaling server*, so a malicious server could MITM them. Relayium adds an **X25519 + AEAD layer on top
  of the DataChannel** — keys never reach the server — plus a commit-then-reveal handshake that always
  runs and always fails closed on tampering. On top of that sits an **optional short verification code
  (SAS)**: turn on *advanced verification* (off by default) and two humans can compare it out of band to
  detect a key-swapping server.
- **A protocol, not just a page.** The crypto layer is deliberately decoupled
  from transport. The same X25519/AEAD/SAS implementation backs the browser, the
  shipped CLI and the released macOS app, and the wire is specified in
  [`docs/protocol/`](docs/protocol) so anything else can speak it (see
  [Delivery status](#delivery-status)).

## Features

- 🔒 **End-to-end encrypted** — per-transfer ephemeral X25519 keys → AES-256-GCM per chunk. Keys never leave the two devices.
- 🛡️ **Optional SAS verification code** — turn on *advanced verification* (off by default) and both browsers show a six-digit code derived from the X25519 endpoint public keys; the CLI shows one derived from the pinned TLS certificate fingerprints (`--verify` stops for it). Matching it out of band detects endpoint impersonation or key substitution — when someone actually compares it. It is a different value from the six-digit pairing code, and the encryption never depends on it: commit-then-reveal and AEAD integrity fail closed either way.
- 📡 **Private paths, stated precisely** — on a LAN, realtime file bytes flow directly over WebRTC. Cross-network browser sessions use a TURN relay by design, but it carries only end-to-end encrypted ciphertext; the CLI's transfer modes are direct-only apart from `up`/`down`, which deliberately use the same hosted encrypted storage as a browser stored link. Stored download links are encrypted in your browser first, and the server holds only ciphertext it has no key for (see [docs/billing-transparency.md](docs/billing-transparency.md)).
- 📦 **Multi-file batches** (up to 1,000) — streamed straight to disk where supported; other browsers may buffer in memory.
- ✅ **Per-file SHA-256 integrity check** on the receiving end.
- 💬 **Ephemeral encrypted text** — send a link, a command, or a block of multiline code to a device that's online right now, over a connection of its own that is end-to-end encrypted, with the same optional SAS comparison as a transfer. Relayium never stores message bodies or server-side history; either endpoint can retain received text. At most 65,536 UTF-8 bytes per message, delivered exactly as typed; anything larger is a file.
- 🌐 **English and 简体中文** — the two maintained product languages, auto-detected and switchable; any other language resolves to English. Seven earlier locales (日本語, 한국어, Deutsch, Français, العربية, Español, Português) stay reachable as archived tutorial pages rather than as product languages.
- 📥 **Device Inbox / My Devices** — send a file from any browser to a folder on a machine *you* own: a Mac, a PC, a NAS, or a server running the CLI. The file is encrypted in the browser and its content key is sealed to that device's own X25519 public key, so the server can open neither. The task waits in a queue while the device is offline; the device dials out, claims it, decrypts, verifies, and writes. It is only ever reported **saved** once that device says the bytes are on disk — ciphertext reaching Relayium is deliberately a different state. A public download link authenticates nothing and can never make a device write to disk. See [relayium.com/device-inbox](https://relayium.com/device-inbox) and [`docs/protocol/relayium-device-inbox-v1.md`](docs/protocol/relayium-device-inbox-v1.md).
- ⚡ **Browser-first** — just open a URL; installing the CLI is optional. Realtime files and text on the same LAN need **no account**; creating a cross-network file or text pairing code requires sign-in, while anyone joining with that code needs no account. Creating stored download links and using Device Inbox also require sign-in.
- 💳 **A free tier, not a free service** — direct paths are unmetered and always free: same-LAN browser transfers, and the CLI's direct modes (`push`/`pull` over SSH, `sync`, `serve`/daemon-direct, pairing-code `send`/`receive`, and `text`). `relayium up` is deliberately not one of them: it stores an encrypted copy in Relayium's hosted storage, exactly like a stored download link created in the browser. What is metered is what costs real money to run — cross-network browser **relay bandwidth**, and **temporary encrypted hosted storage**. They are bounded by four separate limits, not one: a **monthly traffic allowance** that counts hosted uploads, hosted downloads and relayed bytes together; a **storage cap** on how much ciphertext you keep live at once, which is occupancy rather than a monthly total; a **retention window**; and a rolling **daily upload quota**. Every account, Free included, gets an allowance of each, and the paid tiers (Plus, Pro, Max) raise them. Current figures are at [relayium.com/pricing](https://relayium.com/pricing) rather than in this file, because an operator can edit a plan. Self-hosting a relay/storage node removes the metering entirely.
- 🪶 **Self-hostable footprint** — one static SPA + a single Go server binary, with optional CLI and node binaries.

## Command-line client (CLI)

Prefer the terminal? Install the self-hostable, end-to-end-encrypted CLI in one command:

```sh
curl -fsSL https://relayium.com/install.sh | sh
```

**Free and open source — and direct in the modes below.** In these modes the CLI connects your machines
directly: file and message bytes never pass through Relayium's servers, and nothing is metered. Among
them, only `send`/`receive`/`text` touch our servers at all, and only for a tiny rendezvous handshake
(never the content).

**The hosted, asynchronous stored-link mode is `relayium up`** (and the `relayium down` that fetches it). It
uploads a client-side-encrypted copy to Relayium's hosted storage so that a browser can open the link,
which is the whole point of it — and that means it counts against your account plan's storage cap and
retention window, exactly like a stored download link created in the browser. Downloading with
`relayium down` still needs no account. It isn't the only CLI feature that involves our servers: the
Device Inbox is hosted and asynchronous too, and the CLI is its receive side (see below).

Four direct modes — three that move files, one that moves text:

- **`push` / `pull` over your own SSH** — `relayium push ./photos user@host:backups/` (bytes travel over SSH; no Relayium account).
  What you get depends on what is installed on the far end, and the two are not the same. With **relayium installed on the remote**,
  the whole push is refused up front if any destination already exists, and each file is verified by SHA-256 and staged before it is
  installed. It is not a transaction, though, and re-running is not the recovery step: files are installed one at a time as they pass,
  so a connection lost partway through leaves the files that already landed in place — and re-running the same push is then refused,
  because those files now exist. Push does not resume a partial file either (the collision check runs first, so there is never one to
  continue from); `sync` is the mode that skips what already matches and does resume.
  **Without it**, `push` falls back to a zero-dependency tar stream piped into the remote's own
  `tar -x -k`: no resume, no per-file verification. Files already on the receiver are kept rather than overwritten, but tar extracts
  in order, so a collision can happen after other new files from the same batch have already been written — leaving the batch partly
  applied — and whether that collision is reported at all depends on the remote's tar (GNU tar exits non-zero, bsdtar keeps the file
  and exits 0). `pull` has no fallback: it needs relayium on the remote, which acts as the sender.
- **`text` — ephemeral encrypted messages** — run `relayium text` with no code on one machine to mint a code (with your account, as `send` does); it prints the exact `relayium text 483920` command the other machine runs, then waits in the live session for it. Both machines must be online at the same time: this is not a mailbox. One line per message interactively; pipe stdin (`pbpaste | relayium text 483920`) to send multiline content or exact bytes. End-to-end encrypted over a pinned-TLS direct connection of its own, exactly like a file transfer; Relayium stores no message body or server-side history, though either endpoint can retain text. Verification is opt-in: add `--verify` to stop and compare the SAS (that needs a terminal to answer, so a piped `--verify` run refuses rather than pretending it was confirmed); `--yes` is still accepted and means the same as the default. One message is at most 65,536 bytes of UTF-8 — anything larger is a file. CLI to CLI: exactly as with file transfers, the terminal and the browser are separate transports and don't pair with each other.
- **`send` / `receive` by pairing code** — `relayium send ./file.zip` mints a code with your account (after `relayium login`) and prints what the other end runs: `relayium receive 483920`. Codes are 6 digits and last 5 minutes; the receiver needs no account. Cross-network and direct peer-to-peer — a small rendezvous handshake introduces the two ends, the file goes straight between them, no relay. Sending to someone with a browser instead? Use `relayium up` for a download link.
- **`serve` + `push relayium://` daemon direct** — `relayium serve --dir ~/inbox` then `relayium push ./file relayium://host` (server-to-server over pinned TLS; no relay, no SSH, no code — the listener approves each new pusher on its first push and remembers it). This is the direct route between two servers you control, and it needs no Relayium account on either side: a listener accepts a pusher only when that pusher's fingerprint is in the listener's own `authorized_fingerprints` file. Being logged in grants nobody filesystem access, and the two decisions are independent. For a non-interactive listener, pre-authorize with `relayium authorize <fingerprint>` using the *same* `--config-dir` the listener runs with; a running listener honors it on the next connection without a restart. `serve` listens on every interface unless you pass `--bind ADDR`, so firewall the port or bind it narrowly, and it requires `--dir` to be an existing writable directory before it binds.

The CLI's **Device Inbox is the receive side only** — it accepts files your account sends to that machine, and there is no CLI command that sends into an inbox (you send to one from the Web or a native app). To move files between two of your own servers, use `serve` with `push`/`sync` above.

Keep a folder mirrored with **`sync`** — direct too, over SSH or daemon-direct, incremental (only changed files transfer), optionally `--delete` to mirror and `--watch` to re-sync in real time:

```sh
relayium sync ./site relayium://host --delete --watch
```

`--delete` is deliberately hard to turn into data loss, and who has to agree to it depends on the destination.
For a `relayium://` destination the receiving listener is a separate process someone started, so it must have
been started with `--allow-delete`; without that nothing is deleted and the sender is told so. Over **SSH there
is no separate listener to consent**: `sync` starts the receiver itself, through your own SSH session, as you —
there is no `--allow-delete` to set, and passing `--delete` does delete. Either way deletion is confined to the
top-level directories that transfer actually sends, so mirroring `./site` can prune stale files inside `site/`
and can never touch a sibling folder, an unrelated file, or another source's tree under the listener's `--dir`.
An empty source refuses outright on both ends.

Full docs at [relayium.com/cli](https://relayium.com/cli); prebuilt binaries on the [releases page](https://github.com/relayium/relayium/releases).

## How does Relayium compare?

|                          | **Relayium**            | AirDrop          | WeTransfer / Drive | Snapdrop / PairDrop |
| ------------------------ | :---------------------: | :--------------: | :----------------: | :-----------------: |
| Cross-platform           | ✅ any browser          | ❌ Apple only    | ✅                 | ✅                  |
| Content path             | LAN direct; cross-network ciphertext relay | direct | uploaded | LAN direct |
| End-to-end encrypted     | ✅ X25519 + AES-256-GCM | ✅               | ❌ / at rest only  | ⚠️ DTLS only        |
| MITM verification (SAS)  | ✅ 6-digit code, opt-in | n/a              | n/a                | ❌                  |
| No install               | ✅                      | ✅               | ⚠️ size limits      | ✅                  |
| No account               | ⚠️ LAN\*                | ✅               | ⚠️ size limits      | ✅                  |
| Server-imposed size cap  | ⚠️ none for realtime\*\* | ❌ none          | ✅ (e.g. 2 GB free) | ❌ none             |
| Open source              | ✅ AGPL-3.0 / Apache-2.0 | ❌               | ❌                 | ✅                  |

\* Realtime files and text over the **same LAN** need no account. Creating a cross-network **pairing code**
for files or text requires sign-in; anyone joining with that code needs no account. Creating a
**stored download link** also requires sign-in.

\*\* The "no cap" applies to **realtime** transfers only, and it is a property of the path rather
than a promise: the bytes go device to device, so no server decides how big they may be. The
**stored download link** path is different, because Relayium is holding the ciphertext — it is
bounded by a per-file size cap, a per-account daily quota, a monthly traffic allowance and a
retention window, all shown in the app and at [relayium.com/pricing](https://relayium.com/pricing).
Comparing an unbounded realtime transfer against WeTransfer's 2 GB is comparing two different
things; the stored-link path is the one that is actually like theirs.

The gap from Snapdrop/PairDrop is the **application-layer E2E + SAS**: WebRTC's DTLS fingerprints are
exchanged *through the signaling server*, so a malicious server could MITM them. Relayium adds an
X25519 + AES-256-GCM layer **on top of** the DataChannel (keys never reach the server) plus a commit-then-reveal
handshake and an optional short code two humans can compare out of band.

## How it works

```
┌─────────────┐   WebSocket (signaling)   ┌────────────────────┐   WebSocket (signaling)   ┌─────────────┐
│  Browser A  │◀─────────────────────────▶│  Signaling server  │◀─────────────────────────▶│  Browser B  │
│  (sender)   │                           │  (Go) groups peers │                           │ (receiver)  │
│             │                           │  by public IP and  │                           │             │
│             │                           │  relays SDP/ICE/key │                          │             │
└──────┬──────┘                           └────────────────────┘                           └──────┬──────┘
       │                                                                                          │
       └──────────────── WebRTC DataChannel (content, end-to-end encrypted) ─────────────────────┘
                      LAN: direct · browser cross-network: TURN carries ciphertext only
```

1. Both browsers connect to the signaling server over WebSocket and are grouped into a **room by public IP**.
2. The sender creates a WebRTC offer (carrying its X25519 public key); the server relays it to the receiver.
3. ICE candidates are exchanged, the DataChannel opens, and both sides derive shared session keys via ECDH.
4. With *advanced verification* on (off by default), both screens show a **SAS code** derived from the
   X25519 endpoint public keys — comparing it out of band detects endpoint impersonation or key
   substitution. The commit-then-reveal handshake that makes the SAS meaningful runs either way, and a
   mismatched reveal fails the connection whether or not anyone is looking at a code.
5. The receiver explicitly **accepts** (this click is the user gesture that lets the browser stream to disk).
6. The sender chunks each file, encrypts every chunk with AES-256-GCM, and streams it over the DataChannel;
   the receiver decrypts, writes to disk, and verifies SHA-256 per file.

## Security model

- **Threat model:** the signaling server may passively observe or try to impersonate either endpoint; the
  network may be eavesdropped. The server can read **no file or message content**, and — when advanced
  verification is on and a person actually compares them — a browser SAS compared out of band detects
  X25519 endpoint-key substitution. The CLI uses a separate SAS derived from the two pinned TLS
  certificate fingerprints (`--verify`) to detect endpoint impersonation during rendezvous. With the
  comparison off, the residual exposure is precisely that: an active substitution of the signalling
  endpoints goes unnoticed by the humans. It buys the attacker nothing against a passive server, and the
  commit-then-reveal check that bounds it still runs unconditionally.
- **Keys:** two different key regimes, for two different questions. A **realtime transfer** (browser
  or CLI) uses a fresh **ephemeral X25519 keypair per transfer** with no long-term endpoint identity,
  and ECDH yields the session keys — which is why its SAS is compared per session. **Device Inbox**
  is the one place with **persistent device identity**: a device you enrolled registers a long-term
  X25519 public key under your account (rotatable, revocable), and a task's content key is sealed to
  it, so an inbox delivery is bound to a device rather than to a live session. Neither regime
  authenticates the other's path, and no private key ever reaches the server in either.
- **Encryption:** each chunk is AES-256-GCM with a unique nonce. The nonce counter is **global across a batch**
  (it never resets per file), so no nonce is ever reused under a session key.
- **Integrity:** per-chunk GCM tag **and** a per-file SHA-256 verified end-to-end.
- **Anti-MITM:** the browser SAS is derived from the two X25519 endpoint public keys; comparing it out of
  band detects endpoint impersonation or key substitution. Displaying it and stopping for that comparison
  is opt-in (*advanced verification*, off by default; `--verify` in the CLI) — the commitment check that
  makes a ~20-bit code worth comparing is not, and rejects a mismatched reveal on every connection.
- **Metadata minimization:** the server sees room membership (public IP), a device nickname, presence,
  and signaling envelopes. On a LAN, content travels directly over the DataChannel; cross-network browser
  TURN carries only end-to-end encrypted ciphertext; CLI transfers are direct-only except `up`/`down`,
  which move the same client-side-encrypted ciphertext through hosted storage. Relayium never stores
  message bodies.

That's what the server *can't* see. For what it *does* record — TURN relay bytes, stored-transfer
sizes, quota bookkeeping — and exactly what that's billed against, see
[`docs/billing-transparency.md`](docs/billing-transparency.md): a code-grounded, file-and-line-linked
account of the metering and billing paths, so the privacy claim above is something you can verify
rather than take on faith.

The server also keeps three first-party, identifier-free monthly aggregate action totals for the
cross-network pairing path: successful code mints, the first admitted socket for each live code, and
the first transition to two admitted peers. They are bounded, best-effort lower-bound counts—not
unique users, a cohort, or an exact conversion rate. Any displayed ratio is division of same-month
action totals, not cohort conversion. Persistence contains only UTC month, one of those three fixed
stages, and a nonnegative integer count. The full implementation and privacy contract is
documented in [`docs/activation-funnel.md`](docs/activation-funnel.md).

> ⚠️ Relayium is pre-1.0 and has **not** had an independent security audit.
> Don't rely on it for high-stakes threats yet. Issues and review are very
> welcome.

## Quick start (run it locally)

**Prerequisites:** Go 1.22+ and Node 20+.

```bash
# 1. Build the web client
cd web
npm install
npm run build          # outputs web/dist/

# 2. Build and run the signaling server (it serves the static client too)
cd ../server
go build -o relayium-server .
./relayium-server -addr :8080 -static ../web/dist
```

Then find the machine's LAN IP (`ipconfig getifaddr en0` on macOS, `hostname -I` on Linux) and open
`http://<LAN-IP>:8080` **on two devices on the same network**. They'll discover each other within a couple
of seconds; on a LAN, choosing the other device opens the shared workspace, where the same screen
sends files and messages while both devices are online.

> **HTTPS note:** the Web Crypto API and streaming-to-disk require a **secure context**. `localhost` counts,
> but any real deployment must be served over **HTTPS** (e.g. behind Caddy/nginx/Cloudflare). The live site
> at [relayium.com](https://relayium.com/) runs over HTTPS.

The frontend dev server (`cd web && npm run dev`) is handy for UI work, but WebSocket signaling is same-origin —
for an actual two-device transfer, serve the built `dist/` from the Go server as above.

## Browser support

| Browser        | Transfer | Large files                                                            |
| -------------- | :------: | ---------------------------------------------------------------------- |
| Chrome / Edge  |    ✅    | Streamed to disk via `showSaveFilePicker` / `showDirectoryPicker`.     |
| Firefox        |    ✅    | Buffered in memory; Relayium warns above ~256 MB (a conservative estimate, not a hard limit). |
| Safari         |    ✅    | Buffered in memory; Relayium warns above ~256 MB (a conservative estimate, not a hard limit). |

Same-LAN / same-public-IP file and text transfers work with no account. Cross-network browser sessions use
an encrypted TURN relay by design, which only ever sees ciphertext. Creating a cross-network file or text
pairing code requires sign-in; joining with that code does not.

## Delivery status

| Platform | Availability | What to expect |
| --- | --- | --- |
| **Web** | [Live at relayium.com](https://relayium.com/) | LAN and cross-network file/text transfer, encrypted stored links, accounts, and usage controls. |
| **CLI and nodes** | [Published on GitHub](https://github.com/relayium/relayium/releases) | Pairing-code transfer, encrypted links, direct transfer, folder sync, self-hosting, and relay/storage nodes. |
| **macOS** | [1.3.9 direct download](https://github.com/relayium/relayium/releases/tag/macos-v1.3.9) and [1.3.8 on the Mac App Store](https://apps.apple.com/app/id6801142976) | The independently versioned channels share product behavior but use Developer ID/Sparkle and Mac App Store/StoreKit delivery respectively. |
| **iPhone, iPad, Android, Windows, Linux** | The web app, plus the CLI on Windows and Linux | Relayium publishes no app for these platforms. The browser is the client and is not a fallback there — it carries the same end-to-end encrypted transfer, with nothing to install. |

Relayium currently maintains English and Simplified Chinese; the seven earlier
locales are archived translations, not product languages. Detailed native
implementation notes, release evidence, acceptance procedures, and future work
live in [`docs/`](docs/) rather than on this project overview.

**On iOS:** `apps/ios/` exists in this repository and its development is
**paused**. It has never been publicly released — there is no App Store listing
and this site offers no iOS download — and nothing here should be read as a
commitment to ship it. The material under `apps/ios/` and the iOS sections of
[`apps/README.md`](apps/README.md) are a record of where that work stopped, not
of work in progress.

**Self-hosting:** a root [`Dockerfile`](Dockerfile) + [`docker-compose.yml`](docker-compose.yml) build a
single self-contained image (`docker compose up -d --build`). See [`docs/self-hosting.md`](docs/self-hosting.md).

See [`docs/`](docs/) for the full design spec and the manual acceptance procedure.

## Project structure

```
relayium/
├── web/                       # Svelte SPA (client)
│   ├── src/App.svelte          #   UI, transfer orchestration
│   ├── src/lib/crypto.ts       #   X25519 + AES-256-GCM + SAS (libsodium)
│   ├── src/lib/webrtc.ts       #   RTCPeerConnection / DataChannel setup
│   ├── src/lib/signaling.ts    #   WebSocket signaling client
│   ├── src/lib/transfer.ts     #   batch framing, chunking, integrity
│   ├── src/lib/filesink.ts     #   stream-to-disk / directory / Blob fallback
│   └── src/lib/i18n.svelte.ts  #   runes-driven i18n (en + zh, archive alongside)
├── server/                    # Go signaling server
│   ├── main.go                 #   HTTP + WebSocket + static file serving
│   ├── account/, ext/, httpx/, authx/, selfupdate/  #   importable outside internal/, see note below
│   └── internal/signal/        #   hub (rooms by public IP), envelopes
└── docs/                      # design spec + manual test procedure
```

`server/account`, `server/ext`, `server/httpx`, `server/authx`, and `server/selfupdate` live outside
`internal/` so they're importable by other Go modules — everything else under `server/internal/` stays
Go-`internal/`-only by design. Importable does not mean stable: these packages' API is not yet frozen and
may change without notice until this note says otherwise.

## FAQ

**Is Relayium free?**
The software is free and open source — see [License](#license) for which license covers which part,
and self-host it with no limits at all. The hosted service has a **free tier** rather than being
free without limit. Free forever, unmetered: same-LAN realtime files and text (no account), and
the CLI's direct modes — `push`/`pull` over SSH, `sync`, `serve`/daemon-direct, pairing-code
`send`/`receive`, and `text`. Metered: cross-network browser **relay bandwidth** and **temporary
hosted storage** for stored download links, including the ones `relayium up` creates — the two
things that cost real money to run. They are bounded by four separate limits every account has, Free
included: a **monthly traffic allowance** (hosted uploads + hosted downloads + relayed bytes,
combined), a **storage cap** on how much you keep stored at once, a **retention window**, and a
rolling **daily upload quota**. Paid tiers (Plus, Pro, Max) raise all four; current figures are at
[relayium.com/pricing](https://relayium.com/pricing). Creating a cross-network pairing code for
files or text requires sign-in; joining with that code does not. Creating a stored download link,
or sending to your own machine with Device Inbox, also requires sign-in.

**Do my files get uploaded to a server?**
On a LAN, file bytes stream directly between devices over WebRTC. Cross-network browser transfers use a
TURN relay by design, but it sees only end-to-end encrypted ciphertext, never readable files, names, or keys.
The CLI's direct modes — `push`/`pull`, `sync`, daemon-direct, `send`/`receive` and `text` — never route
bytes through us; `relayium up` deliberately does. Stored download links, whether created in the browser
or by `relayium up`, are encrypted before upload, so the server stores ciphertext.

**Is it really end-to-end encrypted?**
Yes. A per-transfer X25519 key exchange derives an AES-256-GCM key; keys exist only on the sender and
receiver. With advanced verification on, a 6-digit SAS code shown on both screens lets you detect a man-in-the-middle on the signalling endpoints; it is separate from the 6-digit pairing code, and the encryption itself does not depend on anyone comparing it.

**Can I send files between different operating systems — say a Windows PC and an iPhone?**
Yes. Relayium runs in the browser, so it's fully cross-platform: Windows ↔ iPhone, Android ↔ Mac,
Linux ↔ anything. Unlike AirDrop it isn't limited to Apple devices, and nobody needs to install
anything — the only native app is the optional macOS one, and the CLI on macOS, Linux and Windows.

**What's the file-size limit?**
Realtime transfer has no server-imposed limit. In Chrome/Edge files stream straight to disk (size bound only by free space).
In Firefox/Safari they're buffered in memory, so Relayium warns above roughly 256 MB — a deliberately conservative estimate, not a hard limit.
That missing cap is not a recommendation: a realtime transfer rides one live session, so either side closing or
reloading the page ends it (brief transport drops can resume while both pages remain active). For large files use a
stored download link. Keep the sender page open until its upload finishes; after that the link remains available
until expiry even when either side closes the tab. Stored links are the bounded path: a per-file size cap, a
per-account daily quota, a monthly traffic allowance and a retention window, all shown in the app and at
[relayium.com/pricing](https://relayium.com/pricing). Realtime is at its best for quick small files and text.

**Can I send text, not just files?**
Yes. When both devices are online you can open a message session — its own end-to-end encrypted
peer-to-peer connection, with its own optional SAS to compare: links, commands, and multiline code arrive
exactly as typed, up to 65,536 UTF-8 bytes per message. Relayium never stores message bodies or server-side
history; there's no offline messaging, though either endpoint can retain received text. Anything
larger goes as a file. The terminal has its own equivalent, `relayium text <code>` — CLI to CLI,
since the two transports don't pair.

**Can I send across different networks / over the internet?**
Yes — via a pairing code. Browser cross-network sessions use an encrypted TURN relay by design that only
ever sees ciphertext. Creating a file or text code requires sign-in; joining with that code does not. See the
[Security page](https://relayium.com/security).

**How is this different from Snapdrop or PairDrop?**
Same browser + WebRTC + LAN idea, but Relayium adds an application-layer E2E encryption layer
(X25519 + AES-256-GCM) and an optional SAS verification code on top of WebRTC's DTLS — so a malicious signaling
server can't read or MITM the transfer undetected. See the [comparison table](#how-does-relayium-compare).

## Contributing

Issues, ideas, and PRs are welcome — especially security review of the crypto and transfer layers.

```bash
# Web tests / type-check
cd web && npx vitest run && npm run check

# Server tests
cd server && go test ./...
```

Please read [`docs/superpowers/specs/`](docs/superpowers/specs/) for the design rationale before proposing
larger changes — but read it as **dated design history, not as current implementation authority**. Those
plans and specs record what was intended on the day they were written; several describe slices that were
later reshaped, deferred, or dropped. When a spec and the code disagree, the code, its tests, and the wire
contracts in [`docs/protocol/`](docs/protocol) are what is true. See
[`docs/superpowers/README.md`](docs/superpowers/README.md).

## License

Relayium is **open core** — different parts of this repository use different open-source licenses,
chosen per part rather than one blanket license for everything. See the [`LICENSE`](LICENSE) file for
the full index; in short:

| Part | License | What that means for you |
| --- | --- | --- |
| [`server/`](server) (signaling server, relay node, CLI) and [`web/`](web) (the app you use at relayium.com) | [AGPL-3.0](server/LICENSE) | You can run, study, modify, and redistribute it freely — including self-hosting it for yourself or your org. The one extra condition versus a permissive license: if you modify it and run your modified version as a network service for *other* people, you must publish your changes' source under the same license. This is what stops someone taking the whole stack (SEO content included) and standing up a competing hosted service without giving back. |
| [`apps/`](apps) (RelayiumKit, the macOS app, and the paused iOS source) | [Apache-2.0](apps/LICENSE) | A fully permissive license — use it, embed it, ship modified versions closed-source if you like, no obligation to publish changes. It's Apache-2.0 rather than AGPL specifically so these clients can be distributed through the Apple App Store, whose terms conflict with GPL-family "no further restrictions" clauses. |
| [`docs/`](docs) (including the wire protocol spec in `docs/protocol/`) | [CC BY 4.0](docs/LICENSE) | Implement the protocol however you like, in any codebase, under any license — just credit Relayium as the source of the spec. Same terms for the rest of the docs (design notes, testing procedures). |

**If you already have a copy of Relayium from before this relicensing** (any commit prior to the one that
added this table), that copy remains MIT-licensed forever — relicensing doesn't and can't revoke a license
already granted. It only applies to versions published from here on.

Contributions are accepted under the [DCO](DCO) (sign off your commits with `git commit -s`) — see
[CONTRIBUTING.md](CONTRIBUTING.md#license).
