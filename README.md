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

On a LAN, two up-to-date browsers do not choose between the two at all. Picking the other
device opens **one shared workspace**: a single end-to-end encrypted connection with one
verification step, a composer and an attachment control, so files and messages travel together
without reconnecting between them. Pairing-code (cross-network) rooms and the native clients keep
the existing separate file and message flows, which is also what an older browser on the LAN falls
back to.

The same protocol also carries **ephemeral text**. When both devices are online, a message session
opens an independent end-to-end encrypted connection — with its own optional verification code to compare — and carries a link,
a command, or a block of multiline code instead of a file. (Inside the shared LAN workspace above it is
not a separate connection: that message lane rides the one link you already verified.)
On a LAN, browser messages move directly;
cross-network browser sessions use TURN that carries only ciphertext; CLI text is direct-only.
Messages are session-scoped:
never stored by Relayium, and gone from its session when that session ends. There is no offline messaging
or server-side history, though either endpoint can retain received text — one message is at most
**65,536 UTF-8 bytes**, delivered byte for byte,
and anything larger is a file.

Relayium is in **active, pre-1.0 development**. The production web app and CLI
are live. A universal macOS app has passed Developer ID signing, Apple
notarization, and Gatekeeper validation on an earlier build; it remains an
**engineering build** being prepared for a first public release, with nothing
to download from the site yet. The iOS app runs its transfer,
nearby and account workflows in the foreground, and is likewise **not public**:
there is no App Store listing and nothing to download.

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
  from transport. It already backs the shipped CLI, the macOS engineering
  build, and the iOS app now under development (see
  [Delivery status](#delivery-status)).

## Features

- 🔒 **End-to-end encrypted** — per-transfer ephemeral X25519 keys → AES-256-GCM per chunk. Keys never leave the two devices.
- 🛡️ **Optional SAS verification code** — turn on *advanced verification* (off by default) and both browsers show a six-digit code derived from the X25519 endpoint public keys; the CLI shows one derived from the pinned TLS certificate fingerprints (`--verify` stops for it). Matching it out of band detects endpoint impersonation or key substitution — when someone actually compares it. It is a different value from the six-digit pairing code, and the encryption never depends on it: commit-then-reveal and AEAD integrity fail closed either way.
- 📡 **Private paths, stated precisely** — on a LAN, realtime file bytes flow directly over WebRTC. Cross-network browser sessions use a TURN relay by design, but it carries only end-to-end encrypted ciphertext; the CLI is direct-only. Stored download links are encrypted in your browser first, and the server holds only ciphertext it has no key for (see [docs/billing-transparency.md](docs/billing-transparency.md)).
- 📦 **Multi-file batches** (up to 1,000) — streamed straight to disk where supported; other browsers may buffer in memory.
- ✅ **Per-file SHA-256 integrity check** on the receiving end.
- 💬 **Ephemeral encrypted text** — send a link, a command, or a block of multiline code to a device that's online right now, over a connection of its own that is end-to-end encrypted, with the same optional SAS comparison as a transfer. Relayium never stores message bodies or server-side history; either endpoint can retain received text. At most 65,536 UTF-8 bytes per message, delivered exactly as typed; anything larger is a file.
- 🌐 **9 languages** — English, 中文, 日本語, 한국어, Deutsch, Français, العربية, Español, Português — auto-detected, switchable.
- ⚡ **Browser-first** — just open a URL; installing the CLI is optional. Realtime files and text on the same LAN need **no account**; creating a cross-network file or text pairing code requires sign-in, while anyone joining with that code needs no account. Creating stored download links also requires sign-in.
- 🪶 **Self-hostable footprint** — one static SPA + a single Go server binary, with optional CLI and node binaries.

## Command-line client (CLI)

Prefer the terminal? Install the self-hostable, end-to-end-encrypted CLI in one command:

```sh
curl -fsSL https://relayium.com/install.sh | sh
```

**Completely free — and direct.** The CLI connects your machines directly; file and message bytes never pass through Relayium's servers. Among the direct modes below, only `send`/`receive`/`text` touch our servers, and only for a tiny rendezvous handshake (never the content).

Four direct modes — three that move files, one that moves text:

- **`push` / `pull` over your own SSH** — `relayium push ./photos user@host:backups/` (bytes travel over SSH; no Relayium account).
- **`text` — ephemeral encrypted messages** — run `relayium text` with no code on one machine to mint a code (with your account, as `send` does); it prints the exact `relayium text 483920` command the other machine runs, then waits in the live session for it. Both machines must be online at the same time: this is not a mailbox. One line per message interactively; pipe stdin (`pbpaste | relayium text 483920`) to send multiline content or exact bytes. End-to-end encrypted over a pinned-TLS direct connection of its own, exactly like a file transfer; Relayium stores no message body or server-side history, though either endpoint can retain text. Verification is opt-in: add `--verify` to stop and compare the SAS (that needs a terminal to answer, so a piped `--verify` run refuses rather than pretending it was confirmed); `--yes` is still accepted and means the same as the default. One message is at most 65,536 bytes of UTF-8 — anything larger is a file. CLI to CLI: exactly as with file transfers, the terminal and the browser are separate transports and don't pair with each other.
- **`send` / `receive` by pairing code** — `relayium send ./file.zip` mints a code with your account (after `relayium login`) and prints what the other end runs: `relayium receive 483920`. Codes are 6 digits and last 5 minutes; the receiver needs no account. Cross-network and direct peer-to-peer — a small rendezvous handshake introduces the two ends, the file goes straight between them, no relay. Sending to someone with a browser instead? Use `relayium up` for a download link.
- **`serve` + `push relayium://` daemon direct** — `relayium serve --dir ~/inbox` then `relayium push ./file relayium://host` (server-to-server over pinned TLS; no relay, no SSH, no code — the listener approves each new pusher on its first push and remembers it).

Keep a folder mirrored with **`sync`** — incremental (only changed files transfer), optionally `--delete` to mirror and `--watch` to re-sync in real time:

```sh
relayium sync ./site relayium://host --delete --watch
```

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
| Server-imposed size cap  | ❌ none                 | ❌ none          | ✅ (e.g. 2 GB free) | ❌ none             |
| Open source              | ✅ AGPL-3.0 / Apache-2.0 | ❌               | ❌                 | ✅                  |

\* Realtime files and text over the **same LAN** need no account. Creating a cross-network **pairing code**
for files or text requires sign-in; anyone joining with that code needs no account. Creating a
**stored download link** also requires sign-in.

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
- **Keys:** a fresh ephemeral X25519 keypair per transfer (persistent device identity is a later milestone);
  ECDH yields the session keys.
- **Encryption:** each chunk is AES-256-GCM with a unique nonce. The nonce counter is **global across a batch**
  (it never resets per file), so no nonce is ever reused under a session key.
- **Integrity:** per-chunk GCM tag **and** a per-file SHA-256 verified end-to-end.
- **Anti-MITM:** the browser SAS is derived from the two X25519 endpoint public keys; comparing it out of
  band detects endpoint impersonation or key substitution. Displaying it and stopping for that comparison
  is opt-in (*advanced verification*, off by default; `--verify` in the CLI) — the commitment check that
  makes a ~20-bit code worth comparing is not, and rejects a mismatched reveal on every connection.
- **Metadata minimization:** the server sees room membership (public IP), a device nickname, presence,
  and signaling envelopes. On a LAN, content travels directly over the DataChannel; cross-network browser
  TURN carries only end-to-end encrypted ciphertext; CLI transfers are direct-only. Relayium never stores
  message bodies.

That's what the server *can't* see. For what it *does* record — TURN relay bytes, stored-transfer
sizes, quota bookkeeping — and exactly what that's billed against, see
[`docs/billing-transparency.md`](docs/billing-transparency.md): a code-grounded, file-and-line-linked
account of the metering and billing paths, so the privacy claim above is something you can verify
rather than take on faith.

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

- **Web — live:** LAN and cross-network realtime file/text transfer, encrypted
  stored download links, accounts and usage controls, and nine languages are
  deployed at [relayium.com](https://relayium.com/).
- **CLI and nodes — live:** published binaries provide pairing-code file/text
  transfer, encrypted upload/download links, SSH and daemon-direct transfer,
  folder sync, self-hosting, and managed relay/storage nodes.
- **macOS — engineering build, not public:** the universal app supports account
  registration and sign-in with device and stored-file management, six-digit
  pairing-code transfer of files and text, folder transfer, nearby sending and
  passive receiving, encrypted stored links to send and open, notifications and
  deep links, the same nine languages as the web client (Arabic included, laid
  out right to left), and a signed Sparkle update foundation. Signing in still
  goes out to the browser for device approval — that is not a native Sign in
  with Apple, which only the iOS app has. Its single window is a desktop shell
  whose sidebar names all five destinations at once — Nearby, Pairing code,
  Send a link, Open a link, Account — so the capabilities that need no account
  (nearby sending and receiving, joining someone else's pairing code, and opening
  a link somebody sent) are reachable without signing in; an account is asked
  for only where it is actually required, with the reason stated. A DMG of an
  earlier build is Developer ID-signed, accepted by Apple notarization,
  stapled, and Gatekeeper-validated. Public release, the Mac App Store and the
  website download switch are all still pending, and the release-readiness
  manifest is still unapproved — nothing on the site offers this app yet.
- **iOS — in development, not public:** a native SwiftUI app now exists at
  [`apps/ios`](apps/ios) and builds against the same shared Swift package. Five
  tabs divide it, and which ones need an account is structural rather than a
  gate over the whole app. *Receive* opens an encrypted stored link without an
  account — paste the link, inspect the decrypted manifest and its
  delete-after-download warning, and save the files into the app's own folder in
  the Files app. *Send* encrypts files, folders, photos or videos on the device
  and creates a stored link with a chosen lifetime and optional
  delete-after-first-download; the key never reaches Relayium, and this half
  needs an account. *Direct* is the six-digit pairing code for a small live
  handoff of files or text — creating a code needs an account, joining one does
  not. *Nearby* lists the devices Relayium's code-less rendezvous groups with
  yours, sends files or text to a peer you pick explicitly, and accepts one
  unsolicited session at a time; seeing a device there proves neither the same
  Wi-Fi nor its identity, and the app says so. *Account* registers, signs in
  with an email and password or natively with Apple, and shows plan and usage
  alongside device and stored-file management. It ships the same nine languages.
  Nothing runs while the app is in the background: it has no background
  execution, so suspending or closing it stops whatever was in flight. A stored
  upload survives that much, because *Send* copies the selected bytes into
  app-private storage on the device before uploading them — reopening the app
  offers the interrupted job back with the choice to resume it or discard the
  staged copy, and only that explicit tap continues the upload. The app never
  resumes anything on its own, nothing continues while it is closed, and the
  realtime *Direct* and *Nearby* sessions stage nothing, so they end with the
  foreground. Tapping a relayium.com share or pairing link opens the app on the
  right tab with the link already filled in — it resolves the encrypted manifest
  or prefills the six-digit code, and never joins a session or saves a file on
  its own; a link that arrives mid-transfer waits rather than replacing it.
  A **Share Extension** is now built into the engineering build: sharing files,
  folders, photos or videos to Relayium from any app copies them into shared
  app-private storage on the device and tells you they are saved there and that
  nothing has been uploaded. You then open Relayium yourself and they are waiting
  on *Send*, until you choose them and press Send — iOS does not let a share
  extension open its containing app, so that last step is yours rather than
  something the sheet can do for you. The extension makes no network request,
  reads no account and holds no key — it stages local copies and stops, and the
  app is still the only thing that encrypts, uploads or produces a link. A
  waiting share is shown even when nobody is signed in, stays on the device until
  it is sent or discarded, and is never expired or sent on its own. None of that
  is verified against a real share sheet yet: the App Group has not been
  registered on the developer portal, the extension has never run on a device,
  and what real providers hand over for a shared folder is untested. There is
  still no notification or push, no in-app purchase, no App Store release, and
  no download to install. The link association itself is verified by the OS at
  install time, so it is one of the things that still needs a real device rather
  than a simulator.
- **Next:** complete the native core product on both platforms first, and verify
  that completeness independently — distribution comes after it, not alongside
  it. On iOS the core is still bounded by what this build cannot do: background
  execution — which keeps realtime sessions foreground-only and leaves a stored
  upload waiting for the user to reopen the app and resume it by hand — plus
  notifications and push. Universal-link routing is
  wired and covered by tests, but its association is only verified on a real
  install, so it stays on the real-device list below rather than the built list
  above. The share extension is in the same position and needs more: its App
  Group has to be registered on the developer portal and carried by both
  provisioning profiles, and only a signed install can show what the real share
  sheet offers, what providers vend for a shared folder, and whether returning to
  the app puts the waiting share in front of the user as intended. macOS
  is further along and is held to the same bar rather than to its own. Both
  then need hands-on real-device QA and an explicit native-versus-web workflow
  audit, and neither has had either yet. Only once
  that verification passes do the distribution steps follow — TestFlight,
  in-app purchase, App Store and Mac App Store submission, and the website's
  download switch. Persistent device identity, broader protocol documentation,
  and additional distribution formats remain future work.

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
│   └── src/lib/i18n.svelte.ts  #   runes-driven i18n (9 languages)
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
Yes — free and open source. The browser app needs no install. Same-LAN realtime files and text need no account.
Creating a cross-network pairing code for files or text requires sign-in; joining with that code does not.
Creating a stored download link also requires sign-in. See [License](#license) for which
open-source license covers which part.

**Do my files get uploaded to a server?**
On a LAN, file bytes stream directly between devices over WebRTC. Cross-network browser transfers use a
TURN relay by design, but it sees only end-to-end encrypted ciphertext, never readable files, names, or keys.
The CLI is direct-only. Stored download links are encrypted before upload, so the server stores ciphertext.

**Is it really end-to-end encrypted?**
Yes. A per-transfer X25519 key exchange derives an AES-256-GCM key; keys exist only on the sender and
receiver. With advanced verification on, a 6-digit SAS code shown on both screens lets you detect a man-in-the-middle on the signalling endpoints; it is separate from the 6-digit pairing code, and the encryption itself does not depend on anyone comparing it.

**Can I send files between different operating systems — say a Windows PC and an iPhone?**
Yes. Relayium runs in the browser, so it's fully cross-platform: Windows ↔ iPhone, Android ↔ Mac,
Linux ↔ anything. Unlike AirDrop it isn't limited to Apple devices.

**What's the file-size limit?**
Realtime transfer has no server-imposed limit. In Chrome/Edge files stream straight to disk (size bound only by free space).
In Firefox/Safari they're buffered in memory, so Relayium warns above roughly 256 MB — a deliberately conservative estimate, not a hard limit.
That missing cap is not a recommendation: a realtime transfer rides one live session, so either side closing or
reloading the page ends it (brief transport drops can resume while both pages remain active). For large files use a
stored download link. Keep the sender page open until its upload finishes; after that the link remains available
until expiry even when either side closes the tab. Stored links are bounded by a per-file size cap and a daily quota;
realtime is at its best for quick small files and text.

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
larger changes.

## License

Relayium is **open core** — different parts of this repository use different open-source licenses,
chosen per part rather than one blanket license for everything. See the [`LICENSE`](LICENSE) file for
the full index; in short:

| Part | License | What that means for you |
| --- | --- | --- |
| [`server/`](server) (signaling server, relay node, CLI) and [`web/`](web) (the app you use at relayium.com) | [AGPL-3.0](server/LICENSE) | You can run, study, modify, and redistribute it freely — including self-hosting it for yourself or your org. The one extra condition versus a permissive license: if you modify it and run your modified version as a network service for *other* people, you must publish your changes' source under the same license. This is what stops someone taking the whole stack (SEO content included) and standing up a competing hosted service without giving back. |
| [`apps/`](apps) (RelayiumKit, the macOS app, the iOS app) | [Apache-2.0](apps/LICENSE) | A fully permissive license — use it, embed it, ship modified versions closed-source if you like, no obligation to publish changes. It's Apache-2.0 rather than AGPL specifically so these clients can be distributed through the Apple App Store, whose terms conflict with GPL-family "no further restrictions" clauses. |
| [`docs/`](docs) (including the wire protocol spec in `docs/protocol/`) | [CC BY 4.0](docs/LICENSE) | Implement the protocol however you like, in any codebase, under any license — just credit Relayium as the source of the spec. Same terms for the rest of the docs (design notes, testing procedures). |

**If you already have a copy of Relayium from before this relicensing** (any commit prior to the one that
added this table), that copy remains MIT-licensed forever — relicensing doesn't and can't revoke a license
already granted. It only applies to versions published from here on.

Contributions are accepted under the [DCO](DCO) (sign off your commits with `git commit -s`) — see
[CONTRIBUTING.md](CONTRIBUTING.md#license).
