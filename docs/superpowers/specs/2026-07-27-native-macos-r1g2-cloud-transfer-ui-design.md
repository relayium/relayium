# Native macOS R1-G2 — cloud transfer UI — design

Drag files in, get a `#k=` link. Paste a link, get the files on disk with Reveal
in Finder. The first round where the macOS app does the thing the product is for.

## Background

G1 shipped the app shell and account (`40144d12`); G1.5 made builds signed and
moved the bearer token into the data-protection keychain (`bc58dbda`). The
`Cloud` and `StoredWire` modules landed in R1-D and are covered by `swift test`,
but nothing calls them from the UI — `ContentView` still renders only the account
screen.

G2's scope from the R1-G decomposition
(`2026-07-26-native-macos-r1g1-app-shell-account-design.md:28`): *cloud transfer
UI: drag in → upload → `#k=` link; paste link → download → Reveal in Finder*.

The web is the reference implementation, and the program design states the
constraint plainly: R1 must not be a reduction against it
(`2026-07-24-native-macos-ios-design.md`, "Interop-safety (the core 'no
reduction' risk)"). That constraint is what makes this round bigger than
"connect the existing Kit to some views".

## What the Kit already has, and the one thing it does not

Present and tested:

- `CloudClient.download(id:key:onChunk:)` (`Cloud/CloudClient.swift:56`) —
  streams the blob, decrypts chunk by chunk through `StoreDecryptor`, follows the
  302 to a storage node, retries once on a first-attempt 403, and enforces the
  expected plaintext total against the manifest. Memory is bounded by the chunk,
  not the file.
- `CloudClient.fetchMeta(id:)`, `buildDownloadLink`, `parseDownloadFragment`
  (`Cloud/CloudModels.swift:27,32`), `encodeStoreKey` / `decodeStoreKey`,
  `generateStoreKey`, manifest encrypt/decrypt.
- `PlanInfo.retentionSecs` (`Account/AccountModels.swift:45`), already in hand
  via the `UsageResponse` that `AccountSession` fetches for `.ready`.

The gap is upload. `CloudClient.upload(key:manifest:files:…)`
(`Cloud/CloudClient.swift:10`) takes `files: [[UInt8]]` — every byte of plaintext
in memory — and `encodeUploadBody` (`Cloud/UploadBody.swift:5`) assembles the
entire ciphertext into one `[UInt8]` before `Data(…)` goes into `httpBody`. Peak
memory is roughly twice the file size.

The server's default single-file cap is **1 GiB**
(`server/main.go:113`, `RELAYIUM_MAX_FILE_SIZE`). A 1 GiB send would therefore
ask a sandboxed desktop app for 2 GiB or more of resident memory.

The web does not do this. `web/src/lib/stored-file.ts` uses a chunked flow
against `POST /api/uploads`, `PATCH /api/uploads/{id}`, `POST
/api/uploads/{id}/finalize`, `GET /api/uploads/{id}`
(`server/account/files.go:71-74`), packing into a buffer and PATCHing it out, so
its peak is "chunk size plus one frame, independent of file size" — about 8.6
MiB. It keeps the single-shot path only as a fallback for a server too old to
offer the chunked endpoints.

So the single-shot uploader is not merely suboptimal here. Shipping it as the
app's only upload path would be both a memory hazard and exactly the kind of
reduction against web the program design forbids. The chunked uploader belongs in
this round.

## Scope

**In:**

- **Kit — `CloudUploader`**: the chunked flow against the four `/api/uploads`
  endpoints, with bounded memory and progress reporting, plus per-chunk retry
  that resyncs from `GET /api/uploads/{id}` rather than restarting the upload.
  Falls back to the existing `CloudClient.upload` when the chunked endpoints are
  unusable, mirroring `uploadFileResumable`'s safety net.
- **Kit — a config read** for `/api/config`'s `maxFileSize`, so the app can
  refuse an oversize file before spending an upload on a 413.
- **AppKit — `CloudUploadModel` and `CloudDownloadModel`**: two `@MainActor`
  `ObservableObject`s with explicit state enums, in the same shape as
  `AccountSession`, so `swift test` covers every transition without a view.
- **App target — views**: a drop zone and upload pane (TTL, burn-after-read,
  progress, result link with copy), and a download pane (paste link, manifest
  preview, save, progress, Reveal in Finder).
- **`ErrorCopy` extension** for `CloudError` and `StoredWireError`. The type was
  built to be extended this way and says so (`ErrorCopy.swift`).

**Out, each for a reason:**

- **Universal Links** — G4. G2 accepts a pasted link only. This is the boundary
  the decomposition already drew, and it keeps G2 free of the AASA and
  entitlement work.
- **Sign in with Apple** — see Non-goals; it is signing-configuration work
  wearing a UI costume.
- **Background `URLSession`** — the program design names it for cloud transfer,
  and it earns its keep on iOS in R3, where the app gets suspended. On macOS the
  window stays open for the length of a transfer. Deferring it keeps `CloudUploader`
  a plain `async` type rather than a delegate-driven state machine with a
  restoration path. Recorded as R3's problem.
- **Folder upload** — the manifest is a flat file list. Recursing a directory
  raises name-collision and symlink questions that have nothing to do with this
  round.
- **QR code and the `relayium down …` command hint** — both are on the web
  upload screen. Neither is on the path to a working transfer, and both are
  cheap to add to a pane that already exists.

## Architecture

Three layers, following the split G1 established and justified.

**`RelayiumKit` (pure logic, no UI):** `CloudUploader` joins `CloudClient`. It
takes the same inputs as `CloudClient.upload` except that files arrive as a
sequence the uploader pulls from, not an array it holds. Progress is a callback.
It knows nothing about SwiftUI, `AccountSession`, or where the files came from.

**`RelayiumAppKit` (view models, `@MainActor`, testable):** two models rather
than one `TransferSession`. Upload and download share no state — different
inputs, different lifecycles, different auth requirements — and a combined type
would be a state enum with two disjoint halves. Each is separately testable and
small enough to hold in one screen.

```
CloudUploadModel.state:   idle → picked([URL]) → uploading(progress) → done(link, expiresAt) → failed(message)
CloudDownloadModel.state: idle → resolving → ready(manifest, expiresAt, burnAfterRead)
                               → downloading(progress) → done([URL]) → failed(message)
```

Both expose `cancel()`. Both use the operation-identity pattern `AccountSession`
already uses (`AccountSession.swift:43`) so a late callback from a superseded
transfer cannot resurrect a screen the user has moved on from.

**App target (SwiftUI views):** `TransferView` hosting an upload pane and a
download pane, plus a drop zone. Views hold no logic worth testing, matching G1.

## Upload flow

1. Files arrive by drag-and-drop or an open panel. Both give security-scoped
   URLs the sandbox already permits (`com.apple.security.files.user-selected.read-write`).
2. The model checks each file against `maxFileSize` and refuses locally, naming
   the file and the cap.
3. TTL and burn-after-read are chosen in the pane. TTL options mirror the web's
   (1h / 1d / 3d / 7d / 14d) clamped by `plan.retentionSecs` from the usage the
   account session already holds. When the cap is unknown — signed out, or a
   usage fetch that failed — offer every option and let the server truncate, the
   same call the web makes and for the same reason.
4. `CloudUploader` generates a key, builds the manifest, and runs the chunked
   flow, reporting progress.
5. On success the pane shows `buildDownloadLink(origin:id:keyB64url:)` with a
   copy button and the expiry.

**The key never leaves the client**, which is the whole point of the `#k=`
fragment, and the link is the only place it exists after the upload. If the user
loses the link, the data is gone — the pane says so rather than implying the
upload is recoverable from an account page.

## Download flow

1. The user pastes a link. `parseDownloadFragment` extracts the key; the id comes
   from the `/d/<id>` path. A malformed link fails here, before any network call.
2. `fetchMeta` + `decryptManifest` produce the file list, total size, expiry and
   burn-after-read flag. The pane shows them and warns when burn-after-read means
   *this download consumes the link*.
3. The user picks a destination. **Single file** → `NSSavePanel` defaulting to
   `~/Downloads` with the manifest's name. **Multiple files** → a directory
   picker; files are written into a new subdirectory named `relayium-<id>`, using
   the transfer id from the link, so a multi-file download cannot scatter into an
   existing folder or overwrite by name collision. If that directory already
   exists, the download refuses rather than merging into it.
4. `CloudClient.download`'s `onChunk` writes straight to disk through a file
   handle. Peak memory stays at one chunk.
5. On completion, `NSWorkspace.activateFileViewerSelecting` reveals the result.

**Download must work signed out.** Anonymous download is what a share link *is* —
`fetchMeta` and the blob route take no bearer token, and the web's `/d/` page has
no session requirement. This has a consequence for the shell: `ContentView`
currently renders a login form for every state that is not `.ready`
(`ContentView.swift:10-49`), which would make a pasted link unusable until the
recipient signs up. The download pane must therefore be reachable from the
logged-out shell. Upload, which needs the bearer token, stays behind sign-in.

## Error handling

`ErrorCopy` gains `CloudError` and `StoredWireError`. The mapping that matters:

- `.quota` (413) and `.rateLimited` (429) are the two the user can act on —
  storage full or daily quota spent, versus slow down. Collapsing them into
  "something went wrong" would hide the only two states a user can fix.
- `.notFound` on a download means expired, burned, or mistyped, and the copy
  should say all three rather than assert one.
- `StoredWireError.lengthMismatch` and `.truncatedStream` mean the ciphertext did
  not match the manifest. That is a tampering or corruption signal, not a network
  hiccup, and the copy must not invite a blind retry.

Partial downloads are deleted on failure. A truncated file in `~/Downloads` with
a plausible name is worse than no file.

## Testing

**Unit (`swift test`, the whole logic layer):** every state transition of both
models against a stubbed client, including cancellation mid-transfer and a
superseded callback arriving late; TTL clamping against `retentionSecs`,
including the unknown-cap case; oversize refusal; link parsing, including the
malformed and missing-fragment paths; the uploader's chunk loop against a stub
that fails one chunk and resyncs.

**Bounded memory is a test, not a hope.** The uploader's peak buffer is asserted
directly, the way `stored-file.ts` tracks its own packing-buffer peak. A
regression that reintroduces whole-file buffering must fail a test rather than
wait for a user with a large file.

**Interop is the round's real risk.** This is the first native code that writes
data another implementation must read. The program design mandates a native ↔
cloud ↔ browser E2E rather than trusting unit tests
(`2026-07-24-native-macos-ios-design.md`, Interop-safety). G2 covers both
directions by hand at minimum — upload from the app, download in a browser; and
the reverse — and extends `web/e2e/lan-transfer.mjs` with the cloud path if that
harness can host a Swift peer without becoming its own project. Whichever holds,
the round states which one it did; "we ran the unit tests" is not interop
evidence.

## Done when

- `swift test` passes with 0 failures, the new model and uploader tests included.
- A file dragged into the app produces a link that downloads correctly **in a
  browser**, and a link produced **by the web app** downloads correctly in the
  app, with byte-identical contents both ways.
- A multi-file transfer round-trips, landing in its own directory.
- Uploading a file at least 5× the chunk size holds peak process memory to a
  small multiple of the chunk, verified by measurement rather than assertion.
- Burn-after-read consumes the link: a second download of the same link reports
  not-found rather than failing obscurely.
- The download pane is reachable and usable while signed out.
- Cancelling mid-transfer leaves no partial file and no stuck UI.

## Non-goals

**Sign in with Apple.** G1 deferred it to "the first sub-round that has a Team
ID" (`…r1g1-app-shell-account-design.md:55-57`), which is now this one, and the
server side is already built and dormant behind `EnableApple`
(`server/account/handlers.go:112-114`, `POST /api/auth/apple/native`). It still
does not belong here, and the reason is concrete rather than aesthetic: the
entitlement `com.apple.developer.applesignin` must be carried by the provisioning
profile, and the profile we just installed does not carry it — its entitlements
are exactly `application-identifier`, `team-identifier` and
`keychain-access-groups`. Adding it means enabling the capability on the App ID
in Apple's portal, regenerating `Relayium Mac`, and rotating
`MACOS_PROVISIONING_PROFILE_BASE64` in CI. That is the signing configuration
G1.5 just closed, reopened inside a round about transfer UI, where a failure
would present as a UI bug. It is a small, self-contained round of its own — the
recommendation is to run it directly after G2, before G3.

**Realtime transfer** — G3. **Universal Links and notifications** — G4.
**Notarization and distribution** — G5.
