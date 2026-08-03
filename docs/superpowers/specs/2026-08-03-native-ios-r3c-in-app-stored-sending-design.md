# Native iOS R3-C — in-app stored sending — design

Date: 2026-08-03
Milestone: R3-C, the third iOS vertical slice. Development only. Not public.
Topology: Claude authors; Codex reviews, validates, delivers and verifies.

## Outcome

A signed-in iPhone or iPad user can pick files, folders, photos or videos from
inside the app, watch them upload end-to-end encrypted to their Relayium
account, and hand the resulting link to anyone through the system share sheet.
A user who is not signed in is told why, in their own language, and taken to the
place that fixes it — not shown a greyed-out button.

And a user who never signs in at all keeps exactly the app R3-A shipped:
receiving an anonymous stored link, with no account, no token and no session.
That is the same clause R3-B was built around, and it is load-bearing again
here for a sharper reason: R3-C is the first slice that puts a *credential-using*
feature next to the credential-free one. The temptation this round creates is a
shared "is the user signed in" gate above the tab bar. There is none, and the
surface guard checks for its absence by name.

Below the surface this is the macOS send path, unchanged: `SelectionStore` →
`expandSelection` → `CloudUploadModel` → `stageCloudFiles` → `CloudUploader`.
What iOS genuinely needs that macOS does not is the two things the platform
does differently — a security-scoped file picker instead of an `NSOpenPanel`
whose grant is ambient, and a photo library that vends a *temporary* file it
deletes out from under you. Both of those are new package types with tests,
not `#if os(iOS)` inside a SwiftUI view.

Two more things this slice owes, and the ones easiest to get wrong quietly:

- **account isolation.** Everything here is an authenticated, account-owned
  operation, so nothing it produces — a selection, a staged file, a link, a plan
  cap, or an upload in flight — may survive the account that produced it. That
  work is **app-scoped and driven by the session**, never by a view's lifetime.
- **ownership of every byte the app copies out of a system provider.** A photo
  the framework decodes and then drops must still clean up after itself, because
  when that happens nothing in this app is called.

## Non-negotiable invariants

Recorded before implementation because this slice touches a credential, a
sandbox capability, and a data-loss boundary (a selection whose bytes must be
the bytes that get sent).

1. **Anonymous receive survives, structurally, in every session state.** The
   receive tab is rendered unconditionally, holds no reference to
   `AccountSession`, and its requests carry no `Authorization` header. Adding a
   third tab does not move that: `RootView` still never reads `session.state`,
   and the send tab's gate lives *inside* the send tab.
2. **Every security scope that is started is stopped.** Apple's contract on
   `fileImporter`'s URLs is explicit: they are security scoped, every successful
   `startAccessingSecurityScopedResource()` must be balanced by a
   `stopAccessingSecurityScopedResource()`, the final stop loses access
   immediately, and leaked scopes exhaust a per-process resource. The balance is
   owned by one package type with a test that counts starts and stops, not by
   a SwiftUI view whose lifetime SwiftUI decides.
3. **Access is held across expansion and staging.** The scope starts *before*
   `expandSelection` enumerates a folder and is still held when
   `stageCloudFiles` has opened and pinned a descriptor for every file. This is
   ordering, not luck, and a test asserts the enumeration observed the scope as
   held.
4. **No whole-file `Data` for a photo, and no second byte copy.** Photos arrive
   through `CoreTransferable`'s `FileRepresentation`; the import callback copies
   the provider's temporary file into an app-owned inbox *before returning*,
   because the provider deletes it at that moment; the second step **moves** that
   owned file into the batch, on the same `tmp` filesystem, so it is a rename.
   `DataRepresentation` and `loadTransferable(type: Data.self)` are absent and
   guarded against by name.
5. **Every copied byte has exactly one owner, and that owner is ARC.** A
   `PhotoCandidate` owns the inbox directory it was copied into and releases it
   exactly once — on explicit `discard()`, on a successful ownership transfer to
   the staging area, or in `deinit`. A `StagedPhotoFile` the framework decodes
   and then drops therefore cleans itself up with no app code running. **No
   runtime sweep of a shared inbox exists**, because a sweep would race a
   provider callback still completing after cancellation.
6. **A newer picker result always wins.** Choosing files supersedes an in-flight
   photo import; a second photo import supersedes the first; Clear, a
   zero-item model call, and account isolation supersede any import. Superseded
   work discards its own batch and candidates when it resumes and repaints
   nothing. Refusing a newer intent because an older one is still running would
   make the app ignore the user; the model's guards exist to defend against
   **late callbacks and programmatic races**, and the *UI* is what merely
   disables controls during a normal import.
7. **A picker result replaces the selection when it starts, not when it
   finishes.** A photo import releases scopes, deletes the previously adopted
   batch, and clears `SelectionStore` *and* `CloudUploadModel.lastPicked`
   **before its first `await`**. That is what makes "one failed item leaves
   nothing selected" true rather than approximately true.
8. **A selection cannot silently become a different selection.** The bytes that
   go on the wire are the bytes of the descriptors `stageCloudFiles` pinned.
   Replacing or clearing a selection while an upload is in flight is refused by
   the model, not only disabled in the view. `upload.isBusy` is the *only*
   condition that refuses a new selection.
9. **The bearer is not cached, published, or held beyond one upload.** The view
   reads `session.bearerToken` once, inside the send action, and stores it in no
   `@State`, no stored property and no `@Published`.
   `CloudUploadModel.start(token:)` necessarily captures it for the duration of
   that one authenticated upload task — an authenticated upload cannot be
   performed without it — and nothing else does. It never reaches a log or a URL.
   No `print`/`NSLog`/`os_log`/`debugPrint`/`dump` exists in the app or the
   view-model layer.
10. **Nothing account-owned survives the account, and the session is what says
    so.** The model observes `AccountSession`'s published state for its whole
    app-scoped life. On every transition out of a ready account — sign-out,
    invalidation, failure, *and any change of the ready user's id* — an in-flight
    upload is **cancelled synchronously, first**, then imports are superseded and
    the selection, scopes, staged candidates, model state, config task and caps
    are cleared. This must hold **with no `SendView` on screen at all**.
11. **Plan limits are applied only under a ready account, and only if still
    current.** Retention comes from `usage.plan.retentionSecs` and is applied
    synchronously; the per-file size hint comes from `GET /api/config` via the
    existing `CloudClient.fetchConfig()`, in an independent task guarded by an
    operation generation **and** the ready user's id. A later account event
    cancels that task rather than queueing behind it.
12. **The app claims no capability it does not have.** `Relayium.entitlements`
    stays an empty `<dict/>`. No Associated Domains, no background modes, no
    local-network permission, no push, no IAP, no App Group, no Share Extension
    target. `PhotosPicker` adds **no** `NSPhotoLibraryUsageDescription`: the
    picker runs out of process and returns only what the user chose, which is
    exactly why it needs no library permission.
13. **Foreground-only is stated, not implied.** No background `URLSession`, no
    resume claim, and no copy suggesting an upload survives suspension.
14. **No server endpoint is invented.** Cancel — including the cancel account
    isolation performs — abandons the chunked-upload session; the server
    reclaims it after `pendingUploadTTL`
    (`server/account/uploads_resumable.go`). There is no client `DELETE`.
15. **No availability claim.** The simulator build stays unsigned, no
    `DEVELOPMENT_TEAM` and no provisioning profile is introduced, and
    `apps/mac/release-readiness.json` stays `approved: false`.

### Adversarial acceptance cases

The cases the design is built around, listed here so the tests are not written
to fit whatever the implementation turned out to do.

**Scopes**

- **A folder picked, then replaced by a second folder.** Exactly one scope is
  held afterwards, and the first folder's scope was stopped exactly once.
- **The same folder chosen twice in one picker result.** One start, one stop —
  the batch is de-duplicated by standardized path before any scope is started.
- **A picker result the upload model refuses** (an oversized file). No scope is
  left held, and the *previous* selection is not restorable — its access is
  already gone, so `reset()` returning to it would return to files the app can
  no longer open.
- **A start that fails.** Only the roots that started are stopped; the
  enumeration proceeds and fails honestly on the unreadable item.
- **The owner is deallocated with a selection live.** Every held scope is
  stopped in `deinit` — which is why the scope holder is a plain final class
  with a lock, not a `@MainActor` type whose isolated state a `deinit` cannot
  legally touch.

**Photos**

- **An import in flight, and the user chooses files instead.** The files win
  immediately; the older import, on resuming, discards its own batch and its
  already-returned candidate and repaints nothing. The importing flag is down
  from the moment the files are chosen.
- **A second import started while the first is still loading.** The second wins;
  the first discards. The flag stays up, because a newer import owns it.
- **An import in flight, and Clear** — or a **zero-item model call**, or
  **account isolation**. Same outcome, and the flag is down afterwards, because
  no newer import owns it.
- **A photo import where item 3 of 5 fails.** Nothing is selected — including
  nothing of the file selection that existed *before* the import started. The
  batch directory is gone, and the already-returned candidates are gone.
- **A `StagedPhotoFile` the framework decodes and then drops** — a cancelled
  `loadTransferable`, a superseded import, a torn-down task. Its candidate's
  `deinit` removes the inbox directory. No app code ran; nothing leaked; nothing
  was swept.
- **A move into the batch that fails.** The candidate still owns its directory
  and still cleans it up. Ownership transfers only *after* a successful move.
- **Two photos with the same provider filename.** Both are staged under distinct
  names, so the manifest carries two distinct paths — otherwise the receiving
  side raises `error.manifest.duplicatePath` on the app's own doing.
- **A provider name that is only an extension** (`.mov`) and **a 300-character
  multibyte name**. The first becomes `photo.mov`; the second is truncated on a
  character boundary, keeps its extension, and *still* fits the byte budget
  after a `(2)` collision suffix.
- **The user opens the picker, chooses the same two photos again.** It imports
  again — the binding was reset to empty immediately after the previous capture.
- **The user opens the picker and cancels.** No binding change, therefore no
  product change: the current selection is untouched.
- **A relaunch after a crash mid-import.** The previous launch's staging
  directory and the whole inbox are swept **once, at app-scoped construction**,
  before any import can exist.

**Account**

- **A sign-out that lands between the button being enabled and the button being
  tapped.** `bearerToken` is nil at read time; the upload is refused with
  `error.cloud.unauthorized` rather than started with an empty bearer.
- **A sign-out while an upload is in flight, with the Send tab never having been
  on screen.** The upload is cancelled and everything is cleared anyway, because
  the session drives it.
- **A sign-out while a photo import is in flight.** The import is superseded, the
  importing flag goes down, the config task is cancelled, and the candidate that
  arrives afterwards self-discards without repainting.
- **A file or photo picker callback that starts only after sign-out.** It is
  refused before taking a scope or loading a candidate, so the synchronous
  isolation pass remains final and hidden logged-out state cannot be recreated.
- **Account A → account B without an intervening sign-out.** A's link, selection
  and caps are gone before B's context is applied.
- **Account A's `/api/config` response arriving after sign-out and after B signed
  in.** Nothing is applied: `maxFileSize` stays 0 and B's retention choices are
  untouched.
- **Two account events in quick succession while a fetch is slow.** The second
  event is processed immediately; it does not queue behind the first fetch.
- **`/api/config` failing outright.** `maxFileSize` stays 0, the send flow
  remains fully usable, and no error is shown.

## Scope

In:

- a third tab, **Send**, with a real gate and a real flow — no disabled
  placeholder;
- `fileImporter` over files *and* folders, with a package-owned security-scope
  lifecycle;
- `PhotosPicker` over images and videos, via a two-step
  `FileRepresentation` → owned candidate → batch flow;
- the existing `CloudUploadModel` path: TTL choice, delete-after-download,
  progress, cancel, retry, clear, send-another;
- app-scoped account observation: isolation, retention, and the advisory
  `GET /api/config` size hint;
- the success state as `ShareLink` + selectable text, with the one-statement
  key notice and the expiry line preserved;
- nine new copy keys and five corrected shared strings, in all nine catalogs;
- deliberate updates to `IOSSurfaceGuardTests`, to the `Relayium.entitlements`
  comment, and to the `UploadPresentation` comments and tests that pin the old
  noun.

Out, and deliberately not stubbed:

- **the Share Extension** — see the roadmap correction below;
- background `URLSession`, resume, notifications, APNs;
- Universal Links / Associated Domains, `onOpenURL`;
- device management and stored-file management (R3-D);
- realtime, pairing code, LAN/nearby, ephemeral text;
- IAP/StoreKit, App Store distribution, app icon, release approval;
- drag and drop, multi-window, Files-app "Open in";
- any web, server, AASA or `relayium-ops` change.

**No dead controls.** The Send tab is the test of that rule this round: it exists
because it works, and where it cannot work it explains and routes.

## Roadmap correction: the Share Extension leaves R3-C

R3-B's roadmap said "**R3-C — sending.** Files/Photos picker → `CloudUploadModel`,
then the Share Extension." The second half is withdrawn, and saying so is part of
the record rather than a quiet omission.

A Share Extension cannot follow inside this slice, and not for effort reasons:

- it is a **separate target and a separate binary**, with its own bundle id, its
  own `Info.plist` `NSExtension` dictionary, its own build and its own signing;
- it runs in **its own process**, so it reaches neither the host app's
  `AccountSession` nor its keychain items. Sharing the bearer needs a shared
  keychain access group, which needs the `keychain-access-groups`
  **entitlement** — the exact entitlement R3-B's invariant 3 was written to
  refuse, and which fails with `errSecMissingEntitlement` (-34018) on a signed
  device build if claimed without provisioning to match;
- sharing the *stored-link keys* it writes needs the same group, or the account
  tab could not rebuild a link the extension created — a data-loss outcome,
  since that key exists nowhere else;
- handing bytes across the process boundary needs an **App Group** container, a
  third capability, with its own staging and cleanup rules;
- all three are provisioning-profile entries, which means a development team,
  which means the signing and trust work this development build does not have.

The Share Extension is therefore deferred to a later, separately designed
capability/release slice, alongside Associated Domains. R3-C is *in-app
sending*, full stop. The `README.md` bullet already lists the Share Extension
under "still to be built" and stays truthful; what changes is the plan's promise
about *when*.

## Navigation structure

```
RelayiumApp
└─ RootView                       ← still never reads session.state
   └─ TabView
      ├─ Receive   ReceiveView(model: download)               unchanged from R3-A
      ├─ Send      SendView(upload:selection:onOpenAccount:)  new
      └─ Account   AccountTab()                               unchanged from R3-B
```

`RootView` gains one tab and one closure. The closure is how the Send tab routes
to Account (`onOpenAccount: { selection = .account }`) — a tab selection change,
not a session read, which is what keeps the shell ignorant of session state.

## The Send tab

Two layers, in this order:

```
SendAvailability.state(for: session.state)
├─ .checking            labelled ProgressView (account.restoring)
├─ .needsAccount        send.accountTitle · send.accountBody · send.openAccount
├─ .accountUnavailable  content.accountLoadFailed · send.accountUnavailableBody · send.openAccount
└─ .ready               the upload flow below
```

`SendAvailability` is a pure package enum with an exhaustive `switch` over
`SessionState`, mapped case by case in a test — the seam shape
`SignInPresentation` established in R3-B, for the same reason: a product rule
inside a SwiftUI `switch` is a rule no test can read.

`.restoring` and `.authenticating` are `.checking`; `.ready` is `.ready`;
`.unavailable` is `.accountUnavailable`; everything else — `.loggedOut`,
`.failed`, `.emailUnverified`, `.pendingDeletion` — is `.needsAccount`.

`.unavailable` is split out because the two are different facts: one user needs
to sign in, the other *is* signed in and the account did not load. Both route to
the Account tab. Neither renders a second sign-in form: one form, one call site,
still.

**This gate is presentation only.** It decides what is *drawn*; it never decides
what is *cancelled or cleared*. That is invariant 10's job and it happens in the
model, driven by the session, whether or not this view has ever been mounted.
A gate that switched to "you need an account" while an upload continued behind
it would be hiding a live transfer; after isolation there is nothing to hide.

### The upload flow, under `.ready`

```
.idle                two choose buttons
   │ chooseFiles / importPhotos
(importing)          send.preparingPhotos · both pickers AND Send disabled
   │
.picked(files)       selection summary · Clear · TTL picker · delete-after-download · Send
   │ start(token:)
.uploading(sent,total) determinate progress · upload.keepOpen · Cancel
   │
.done(link,expiresAt,keyWarning)
                     upload.linkReady · ONE key statement · selectable link ·
                     ShareLink · expiry · Send another
   │
.failed(message)     message · Try again
```

Every one of those states is `CloudUploadModel`'s existing behavior, reused
verbatim. What this slice adds around it is the two selection sources, the
resource ownership they need, and the account observation above them.

Disabling the pickers and Send during an import is a **courtesy**, not the
safety mechanism: it stops a user tapping through a half-prepared batch. The
model would handle those taps correctly anyway, by superseding — which is what
makes the disabling safe to be merely cosmetic.

## Security-scoped file selection

`fileImporter` returns security-scoped URLs. Apple's rule is that
`startAccessingSecurityScopedResource()` must be balanced by
`stopAccessingSecurityScopedResource()`, that the last stop revokes access
immediately, and that leaked scopes exhaust a finite per-process resource. A
SwiftUI view is the wrong owner twice over: SwiftUI decides when a view is torn
down and rebuilt, and a view cannot be unit-tested.

So the contract lives in the package:

```swift
public protocol SecurityScopedResourceAccessing: Sendable {
    func startAccess(to url: URL) -> Bool
    func stopAccess(to url: URL)
}

/// The real thing. The only place in the product that calls the two URL APIs.
public struct SystemSecurityScopedResource: SecurityScopedResourceAccessing { … }

/// Holds at most one batch of started scopes, and stops exactly what it started.
public final class SecurityScopedAccess: @unchecked Sendable {
    public init(resource: SecurityScopedResourceAccessing = SystemSecurityScopedResource())

    /// De-duplicates by standardized path, starts access for each distinct URL,
    /// releases whatever batch was held before, and returns the de-duplicated
    /// list — including the ones whose start returned false.
    @discardableResult public func replace(with urls: [URL]) -> [URL]

    public func clear()
    public var heldURLs: [URL] { get }      // for tests
    public var startedURLs: [URL] { get }   // for tests

    deinit { /* the same stops as clear() */ }
}
```

Five decisions inside that small surface, each of which is a bug if made the
other way:

- **`replace` is one operation, not `begin` + `adopt`.** An API that could start
  scopes and then *not* take ownership of them has a leak path in its own shape.
- **De-duplication by standardized path happens before any start**, matching
  `expandSelection`'s own root de-duplication. Two URL objects for one path
  would otherwise take two sandbox extensions and need two stops.
- **Only successful starts are stopped.** A `false` return consumed no
  extension; stopping anyway is unbalanced in the other direction.
- **A failed start is not an error here.** A URL whose start genuinely failed
  will fail again, visibly, when `expandSelection` reads it, with copy that names
  the item.
- **`@unchecked Sendable` final class with an `NSLock`, not `@MainActor`.** A
  `deinit` cannot touch main-actor-isolated state, and `deinit` is precisely the
  release path that must not be skippable.

### The ordering that makes it correct

`SendSelectionModel.chooseFiles` is the only caller:

```
guard accountUserId != nil else { return }  // a late callback after sign-out
guard !upload.isBusy else { return }        // the only ready-account refusal
supersedeImports()                          // a newer intent wins; flag goes down
photos.clear()                              // drop the adopted photo batch
let roots = access.replace(with: urls)      // ── scope starts HERE
upload.clearSelection()                     // the old list is unreachable now
store.replace(with: roots)                  // expansion runs INSIDE the scope
… push the expansion into the model …       // stageCloudFiles later, still inside
```

- **Within a ready account, `upload.isBusy` is the only refusal.** A picker
  callback that starts after sign-out is refused before touching resources. An
  in-flight photo import does *not*
  block a file choice: the user asking for files is a newer intent, and the
  correct answer is to supersede, not to ignore them. Everything from
  `supersedeImports()` down runs synchronously, so the older import cannot
  interleave; when it resumes it finds a newer generation and discards.
- `upload.clearSelection()` **before** `pick` is the answer to the refusal case:
  the previous selection's scopes have just been released by `replace`, so
  `lastPicked` must not still name those files. Without it, a refused new
  selection leaves `reset()` able to return the user to files the app can no
  longer open. The rule this states, and that a test pins: **a new selection
  replaces the old one even when it is refused.**
- The scope stays held for the whole life of the selection — through
  `expandSelection`, through the user choosing a TTL, and through
  `stageCloudFiles` opening a descriptor per file inside `start(token:)`'s task.
  Releasing it earlier would require proving that every descriptor was already
  pinned, which is a proof about a background task's progress; holding it until
  the selection changes needs no proof at all.

## Photos: two steps, because `Transferable` is static

`PhotosPicker` with `matching: .any(of: [.images, .videos])` and an explicit
`maxSelectionCount`.

The constraint that shapes everything: **`Transferable.transferRepresentation`
is a static property, and `loadTransferable(type:)` takes only a type.** There is
no way to hand the import closure a batch or a destination — and a global mutable
"current batch" or a `TaskLocal` read inside a system-invoked closure is exactly
the ambient state that breaks under supersession. So the flow splits at that
seam, and the seam is *ownership*.

**Step 1 — the static representation, which needs no context.**

```swift
/// One picked item, already copied out of the provider's temporary storage —
/// and the OWNER of the inbox directory it lives in.
///
/// A class, not a struct, because ownership has to be releasable exactly once
/// and by ARC. The framework can decode a `StagedPhotoFile` and then drop it —
/// a cancelled `loadTransferable`, a superseded import, a torn-down task — and
/// when it does, nothing in this app is ever called. `deinit` is the only
/// cleanup hook that survives that. It is also why there is NO runtime sweep of
/// a shared inbox: a sweep would race a provider callback still completing after
/// cancellation and delete a directory that is about to be filled.
public final class PhotoCandidate: @unchecked Sendable {
    /// The copied file, inside the owned directory. Safe to move.
    public let url: URL
    /// What the provider called it, unsanitized. Naming is step 2's decision.
    public let suggestedName: String

    /// Give up the directory now. Idempotent; safe from any thread.
    public func discard()

    /// Exactly-once ownership transfer, for the staging area only. Returns the
    /// directory to remove, or nil if ownership has already gone.
    func relinquish() -> URL?

    deinit { discard() }
}

public enum PhotoInbox {
    /// `<tmp>/PhotoInbox`, created on demand. Launch-independent on purpose:
    /// step 1 cannot know which launch or which import it belongs to.
    public static func directory(_ fileManager: FileManager = .default) throws -> URL

    /// The narrow function the static representation calls, and its ONLY job:
    /// copy the provider's file to a unique location this app owns, right now,
    /// before the transfer callback returns. Each candidate gets its own UUID
    /// directory, so this step needs no collision rule at all — which is what
    /// lets it be context-free.
    public static func take(_ providerFile: URL,
                            in inbox: URL? = nil,
                            _ fileManager: FileManager = .default) throws -> PhotoCandidate

    /// Remove everything in the inbox. Called EXACTLY ONCE, at app-scoped model
    /// construction, before any import can exist — it is for crash leftovers
    /// from a previous launch and nothing else. There is no runtime sweep.
    public static func sweepLeftovers(_ inbox: URL? = nil,
                                      _ fileManager: FileManager = .default)
}
```

The app target's `Transferable` conformance is a shim with no state:

```swift
struct StagedPhotoFile: Transferable {
    let candidate: PhotoCandidate
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            StagedPhotoFile(candidate: try PhotoInbox.take(received.file))
        }
        FileRepresentation(importedContentType: .movie) { received in
            StagedPhotoFile(candidate: try PhotoInbox.take(received.file))
        }
    }
}
```

Both representations are import-only (`FileRepresentation(importedContentType:)`,
available since iOS 16), both are `throws`, and neither reads anything outside
its argument. Image first, then movie: that is the negotiation order.

**Step 2 — the model, which has all the context.** In user selection order, it
**moves** each returned candidate into its batch under a collision-safe name:

```swift
/// Moves `candidate.url` into `batch` as `stagedFileName(suggested:taken:)`.
///
/// Ownership transfers ONLY after the move succeeds: on failure this throws and
/// the candidate still owns — and still cleans up — its inbox directory. On
/// success the candidate relinquishes, and the emptied directory is removed
/// here, so the candidate's later `deinit` is a no-op and can never delete a
/// file that now belongs to the batch.
///
/// A move, not a copy: the inbox and the batch root are both under `<tmp>`
/// deliberately, so this is a rename and a multi-gigabyte video is not written
/// twice. `FileManager.moveItem` stays correct if that ever stops holding on
/// some future volume layout — it would just be slow.
public func adopt(_ candidate: PhotoCandidate, into batch: PhotoStagingBatch) throws -> URL
```

### The staging area

```
<app container>/tmp/PhotoInbox/<candidate UUID>/<provider name>     step 1
<app container>/tmp/PhotoImports/<launch UUID>/<batch UUID>/<final> step 2
```

- **`tmp`, not `Documents`.** `Documents` is published to the Files app by
  `UIFileSharingEnabled`; staging copies there would litter the folder the user
  browses for *received* files. `tmp` is the documented place for files that need
  not persist, and — the operational reason — it puts inbox and batch on one
  filesystem, which is what makes step 2 a rename.
- **A per-launch batch root** makes leftover cleanup provably safe: at
  construction the app deletes every *sibling* of this launch's directory, and a
  live batch is always inside the directory the sweep excludes by construction.
- **A per-batch directory** makes discard a single `removeItem`, which is what
  supersession and partial failure both need.
- **A flat inbox** cannot be launch-scoped, because step 1 has no context. It is
  not swept at runtime either — candidates own themselves. The one sweep is at
  app-scoped model construction, for leftovers from a launch that crashed.

### Naming, ordering, bounds

```swift
/// Pure, and therefore the part that gets the table-driven test.
public func stagedFileName(suggested: String, taken: Set<String>) -> String
```

The rules, in order:

1. take `lastPathComponent`, so a name containing a separator cannot escape the
   batch directory;
2. strip control characters, `/` and `:`; trim whitespace;
3. split into stem and extension at the **last** dot. A name that is *only* an
   extension — `.mov`, `.HEIC` — therefore yields an **empty stem**, not a stem
   called `mov`. An "extension" longer than 16 bytes is not treated as one;
4. strip any remaining leading dots from the stem, so nothing lands hidden;
5. an empty stem becomes `photo` — which is what turns `.mov` into `photo.mov`;
6. for attempt *n* = 1, 2, 3 …, the suffix is `""`, `" (2)"`, `" (3)"` …
   **The stem is truncated per attempt** so that `stem + suffix + ext` is
   ≤ **200 UTF-8 bytes**, and truncation removes whole `Character`s from the end
   — never a byte slice, which can split a scalar or a grapheme cluster. The cap
   therefore holds *after* the collision suffix, not merely before it;
7. if the stem truncates to empty because the extension alone consumes the
   budget, the stem becomes `photo` and the extension is dropped;
8. the first attempt not in `taken` wins — the same step-aside convention
   `ReceiveDestination` uses on the receiving side.

200 bytes is far below `MANIFEST_MAX_NAME_BYTES` (1024), so a staged name can
never be the reason a manifest is refused. Uniqueness within the batch is not
cosmetic: `stageCloudFiles` puts the relative path in `ManifestFile.name`, and
two identical names would make the app produce a manifest the receiving side
refuses with `error.manifest.duplicatePath`.

- **Ordering is the user's selection order.** Items are loaded and adopted
  serially, in index order; the resulting URLs are the roots in that order, and
  `expandSelection` preserves it. Serial rather than concurrent: it makes the
  order and the collision resolution deterministic without a rename pass, and
  the bottleneck is disk, which concurrency does not widen.
- **`PHOTO_IMPORT_MAX = 50`**, a package constant the picker's
  `maxSelectionCount` reads. `MAX_FILES` (1000) is the wrong bound for this
  path: that bound is about what a manifest can *describe*, and this path copies
  every byte first. Because the picker enforces it, there is no "too many
  photos" error string — a message for an unreachable case is a dead control
  made of words.

### The picker binding, and the change that must be ignored

`PhotosPicker`'s selection binding keeps whatever was chosen. If it is left
alone, reopening the picker and choosing the *same* items produces no change and
therefore no import — the app appears to ignore the user. So the view resets it:

```
onChange(of: picked):
    captured = picked
    if captured is empty      → ignore entirely       (our own reset, or nothing)
    picked = []                                       (so the same items re-fire)
    importPhotos(count: captured.count, load: …)      (from the CAPTURED array)
```

Two facts that must not be conflated, and are therefore separated in a pure,
testable seam rather than in the view's head:

```swift
public enum PhotoPickerChange: Equatable {
    /// Our own programmatic reset, or a change carrying nothing. Do NOTHING —
    /// in particular, do not clear the product selection.
    case ignore
    case importItems(count: Int)
    public static func decide(itemCount: Int) -> PhotoPickerChange
}
```

- **An empty binding change is never a product change.** It is the reset the
  view just performed. Calling `importPhotos(count: 0)` there would clear a
  selection the user never asked to clear.
- **Cancelling the system picker changes the binding not at all**, so it also
  changes nothing. That is the platform's behavior and this design relies on it
  rather than trying to detect a cancel.
- **A genuine `importPhotos(count: 0)` remains a defensive supersede-and-clear
  path in the model** — it is what "the caller told us there is nothing" should
  mean — and it is tested directly on the model, never reached from the view.

### Replacement, failure, supersession, cleanup

`importPhotos` does all of this **before its first `await`**:

```
guard accountUserId != nil else { return }   // a late callback after sign-out
guard !upload.isBusy else { return }         // the only ready-account refusal
guard count > 0 else { supersedeImports(); clear(); return }
photoGeneration += 1 ; let g = photoGeneration
isImportingPhotos = true                     // this import now owns the flag
importError = nil
access.clear()          // file scopes go now, not when the loads finish
photos.clear()          // the previously adopted batch goes now
store.clear()
upload.clearSelection() // lastPicked goes now: nothing may be restored
batch = try photos.makeBatch()
```

Then, per index: `await load(index)` → check `g == photoGeneration` → adopt into
the batch. And:

- **A second import is not refused.** There is no `isImportingPhotos` guard at
  the entry: the newer import bumps the generation, so the older one discards
  when it resumes, and the flag stays up because the newer import owns it.
- **The flag is owned by the current generation.** Every exit path lowers it only
  when `g == photoGeneration`. `supersedeImports()` — called by `chooseFiles`,
  `clear()`, the zero-item path and account isolation — bumps the generation and
  lowers the flag directly, because in those cases *no newer import owns it*.
- **Partial failure refuses the whole batch.** Any load or adopt failure
  discards the just-returned candidate, discards the batch, and shows
  `error.photoImport.failed`. Because the replacement already happened, "nothing
  is selected" is literally true — including of the file selection that existed
  before. A superseded import reports no error at all: the failure belongs to a
  selection the user has already replaced.
- **Candidates clean themselves.** Every exit path calls `discard()` on a
  candidate it is dropping, and any candidate that never reaches app code — a
  cancelled load, a dropped `StagedPhotoFile` — is released by ARC. There is no
  path that depends on a sweep.
- **Replace and clear** delete the previously adopted batch; `deinit` deletes
  the live one. `PhotoStagingArea` and `PhotoCandidate` are plain non-isolated
  types with locks, for the same `deinit` reason as `SecurityScopedAccess`.
- **A photo batch and a file selection are mutually exclusive**, in both
  directions. Staged photos are the app's own files and must never be handed to
  `SecurityScopedAccess`, which would start scopes it does not need and stop
  scopes it never took.

Adopted photos then feed the identical bounded path: `expandSelection` →
`SelectionStore` → `CloudUploadModel.pick` → `stageCloudFiles`.

## Ownership, injection, and what the view can observe

Everything that must outlive a view rebuild is constructed once, in
`RelayiumApp.init`, and injected:

```swift
@MainActor init() {
    _download = StateObject(wrappedValue: AppEnvironment.makeDownloadModel())
    let account = AppEnvironment.makeSession()
    _session = StateObject(wrappedValue: account)
    // ONE key store, built from AppEnvironment.keychainConfiguration — the iOS
    // row: com.relayium.app, no access group. R3-B made this per-platform
    // precisely so this call site needs no #if.
    let keys = AppEnvironment.makeStoredLinkKeyStore()
    let uploads = AppEnvironment.makeUploadModel(keyStore: keys)
    _upload = StateObject(wrappedValue: uploads)
    let sending = AppEnvironment.makeSendSelectionModel(upload: uploads)
    // App-scoped, for the model's whole life, and BEFORE any view exists.
    sending.observe(account.$state)
    _send = StateObject(wrappedValue: sending)
}
```

- **The stored-link key store is built exactly once, here.** It is the same
  object R3-D's account management model will read; two stores would mean an
  upload whose link the Account tab cannot rebuild.
- **`CloudUploadModel` and `SendSelectionModel` are app-scoped**, so an upload in
  flight and the selection behind it survive a tab switch or a view rebuild.
- **`SendSelectionModel` owns `SelectionStore`, `SecurityScopedAccess` and
  `PhotoStagingArea`.** macOS keeps its `SelectionStore` as a `@StateObject`
  inside `UploadPane` and bridges it with `.onChange(of: selection.revision)`.
  That is defensible on macOS, where nothing is security scoped. Here the bridge
  *is* the scope lifecycle, so it belongs where `swift test` can reach it.

### Account observation is app-scoped, not view-driven

The account work — cancel, isolate, apply caps, fetch the size hint — **must not**
hang off a `.task(id:)` inside `SendView`. SwiftUI mounts a `TabView`'s tabs
lazily and may tear down an off-screen one; a user who signs out while looking
at the Receive tab would then get no isolation at all, and an authenticated
upload would keep running under an account that is gone. Account-owned work is
app-scoped, so it observes the app-scoped thing that knows: the session.

```swift
/// Installed once, at app construction, for this model's whole life.
public func observe<P: Publisher>(_ states: P)
    where P.Output == SessionState, P.Failure == Never
```

Four properties, each deliberate:

- **Synchronous on the main actor.** `AccountSession` is `@MainActor`, so
  `$state` only ever fires there. The `sink` closure is non-`@Sendable` and is
  formed inside a `@MainActor` method, so it inherits main-actor isolation and
  calls the handler *synchronously with the state write*. This is deliberately
  **not** the `Task { @MainActor in … }` hop `NearbyReceiveModel` uses: that
  model defers precisely because it re-reads its sources and `@Published` fires
  in `willSet`, whereas this handler consumes the **emitted value** and never
  re-reads `session.state` (which would still be the old one). A hop here would
  leave a window in which an account-owned transfer runs under an account that
  is already gone, and a test asserts the cancellation has happened by the time
  the state write returns.
- **A publisher, not the session.** `observe` takes `P.Output == SessionState`
  rather than an `AccountSession`, so a test drives transitions through a
  `CurrentValueSubject` with no network, no keychain and no view — which is what
  makes "isolation happens with no `SendView` in existence" a real assertion
  rather than a claim.
- **De-duplicated on the derived context.** States are mapped to
  `SendAccountContext` and `removeDuplicates()`d, so a usage refresh that changes
  nothing the send screen cares about does not re-fetch. A test counts fetches.
- **Lifetime by ARC.** The `AnyCancellable` cancels itself when the model is
  released, and the config task is held in a small non-isolated box whose
  `deinit` cancels it. Neither depends on a `deinit` reaching main-actor state,
  which a `@MainActor` class's `deinit` cannot safely do.

The handler itself:

```swift
private func accountStateChanged(_ context: SendAccountContext) {
    if context.userId != accountUserId { isolateFromPreviousAccount() }
    accountGeneration += 1
    let g = accountGeneration
    accountUserId = context.userId
    configTask.cancel()                       // an older fetch is now irrelevant
    guard context.userId != nil else { upload.apply(.unknown); return }
    // Retention is known NOW; the size hint is not. The pair is applied twice on
    // purpose: the screen is usable immediately and gets sharper if the advisory
    // fetch lands.
    upload.apply(UploadCaps(retentionSecs: context.retentionSecs, maxFileSize: 0))
    configTask.replace(with: Task { [weak self] in
        guard let config = try? await self?.fetchConfig() else { return }
        await self?.applyFetchedConfig(config, generation: g, context: context)
    })
}
```

Everything above the `Task` is synchronous, so a sign-out cancels the upload
before anything else observes the new state; and because each event **cancels
and replaces** the fetch task rather than awaiting it, a slow `/api/config` can
never delay a later account event. `applyFetchedConfig` applies only when
`g == accountGeneration` **and** `accountUserId == context.userId`: the
generation catches a re-entry into the same account, the id catches everything
else.

### Observation is forwarded, not inherited

A SwiftUI view observing `SendSelectionModel` does **not** observe the
`SelectionStore` nested inside it: `ObservableObject` conformance does not
propagate through a stored property, and a nested object's `objectWillChange`
never reaches the parent's subscribers. So the model forwards what the view
renders, as its own published state:

```swift
@Published public private(set) var summary: String?          // the picked line
@Published public private(set) var selectionError: String?   // preparation failed
@Published public private(set) var isImportingPhotos: Bool
@Published public private(set) var importError: String?
```

That is the whole render surface. `accountUserId` and `accountGeneration` are
**internal isolation state**, not UI: they are not `@Published`, nothing renders
them, and no test claims they are rendered.

`SelectionStore` stays a `private let`, the view never names it, and a source
guard asserts that.

**The division of labour between `selectionError` and `upload.state`** is what
makes this real rather than decorative:

- a **preparation** failure — the importer handing back an error, or
  `expandSelection` refusing the roots — sets `selectionError` and **does not
  touch `CloudUploadModel`**. Nothing was ever picked, so reporting it as an
  upload failure would put the upload model into `.failed` for something that
  never reached it, and would give the user a "Try again" that retries nothing.
  Resources are released and the store is cleared.
- an **upload-model refusal** after a successful expansion — an oversized file —
  stays exactly what it is: `upload.state == .failed(message)`, with the scopes
  released, because the model is the thing that refused.

The first case is also the observation test's real path: it changes
`selectionError` and nothing else, so a view relying on `CloudUploadModel`
redraws would show nothing at all.

## Caps: retention from the plan, size from `/api/config`

Both sources already exist:

- **retention** — `usage.plan.retentionSecs`, from the ready state, exactly as
  macOS uses it;
- **max file size** — `ServerConfig.maxFileSize`, from
  `CloudClient.fetchConfig()` (`GET /api/config`), which
  `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudConfig.swift` has had since
  the cloud client was written and which nothing has called yet. The server side
  is `handleConfig` in `server/account/handlers.go`, returning `maxFileSize`
  among the effective stored-transfer settings, public and session-free.

The endpoint being public does not make the *hint* account-independent in this
product's UI: it is a sending limit, shown on a screen only a signed-in user
reaches, and it must appear and apply **only while an account is ready**. So the
session supplies the trigger and the identity:

```swift
/// What a ready account contributes to the send screen. `.none` for every other
/// session state — including `.unavailable`, where a token is held but the plan
/// is unknown.
public struct SendAccountContext: Equatable, Sendable {
    public let userId: String?          // nil == no ready account
    public let retentionSecs: Int64
    public static let none = SendAccountContext(userId: nil, retentionSecs: 0)
    public static func context(for state: SessionState) -> SendAccountContext
}

/// The pair that is applied and reset together, so one cannot outlive the other.
public struct UploadCaps: Equatable, Sendable {
    public let retentionSecs: Int64     // 0 == unknown
    public let maxFileSize: Int64       // 0 == unknown
    public static let unknown = UploadCaps(retentionSecs: 0, maxFileSize: 0)
}

extension CloudUploadModel {
    public func apply(_ caps: UploadCaps)   // retention choices + size gate
}
```

- **The fetch is advisory.** Any failure — offline, 500, a decoding change —
  leaves `maxFileSize` at 0 and the send flow fully usable, with no error shown.
  The server enforces the real cap during `PATCH` either way, and hiding a
  working feature because a hint request failed is the worse error. This mirrors
  `allowedTTLs`'s existing "unknown cap offers everything" rule.
- **`fetchConfig` is an injected `@Sendable () async throws -> ServerConfig`**,
  defaulted in `AppEnvironment` to the real client, so the staleness tests can
  gate the response and land it at a chosen moment.
- **Reset is the invariant, not a side effect.** Leaving `.ready` applies
  `.unknown`: the TTL list returns to all five and the size gate turns off. The
  *selected* TTL is left where the user put it — a cap is a limit, a selection is
  a preference, and 1 hour is in every plan's list.

## Account isolation

`isolateFromPreviousAccount()` is one ordered, synchronous sequence:

```
upload.cancel()          // FIRST, if busy — an authenticated upload dies with its account
supersedeImports()       // bump the photo generation; lower the importing flag
configTask.cancel()      // a fetch for the account being left applies to nobody
access.clear()
photos.clear()
store.clear()
upload.clearSelection()  // drops lastPicked and any `.done` link
upload.apply(.unknown)
selectionError = nil ; importError = nil ; publishRenderState()
```

Why cancel rather than let it finish: the upload is authorized by a bearer that
belongs to the account being left. If the sign-out revoked it, the remaining
chunks fail anyway — but with the failure surfacing on a screen the user has
already left. If it has *not* been revoked yet, letting it run means an
account-owned transfer continuing invisibly after the user believes they signed
out, and then a `.done` link belonging to account A sitting on account B's
screen. Neither is acceptable. The partial chunked-upload session is abandoned
and reclaimed after `pendingUploadTTL`; no `DELETE` is sent, because none exists.

A photo import that was in flight resumes later, finds a newer generation,
discards its batch, and its candidate — already returned or still to come —
discards itself. Nothing repaints.

Triggered by **any** transition out of `.ready`, or any change of the ready
user's `id` between two `.ready` states. `NativeUser.id` is the identity; email
is not, because it can change.

## Lifecycle: foreground only, and said so

There is no background `URLSession` and no resume. An upload interrupted by the
app being suspended fails, and the user starts it again:

- while `.uploading`, the pane shows `upload.keepOpen` — *"Keep Relayium open
  until this finishes. Leaving the app can stop the upload, and it can't be
  resumed in the background yet."* — as ordinary text in reading order;
- nothing is cancelled on `scenePhase` change. A brief interruption does not
  suspend the process, and cancelling on `.inactive` would abort uploads that
  would have survived. The one cancellation this slice adds is account
  isolation's, which is about authorization, not lifecycle;
- **Cancel** calls `CloudUploadModel.cancel()`, which cancels the task and bumps
  its generation so a late progress callback cannot repaint;
- **no notification** is posted on completion; that needs R3-F's capability.

## The success state

```
upload.linkReady                       heading
UploadPresentation.keyNotice(...)      exactly ONE statement about the key
<the link>                             .textSelection(.enabled), truncated in the middle
ShareLink(item: link)                  the platform's own hand-off
common.expires <date>                  from expiresAt, medium date + short time
upload.sendAnother                     → model.reset()
```

- **`ShareLink` and text selection, never a pasteboard.** `NSPasteboard` does not
  exist here and `UIPasteboard` is on the guarded list — an app that writes the
  clipboard behind the user's back is doing the thing this product promises not
  to do, and iOS would surface the paste notification for it besides.
- **The one-statement rule is preserved exactly.** `UploadPresentation.keyNotice`
  returns either the reassurance or the warning, never both. Both halves of the
  E2E claim survive: the key is on *this device*, and it was never sent to
  Relayium's servers.
- Cancel, retry (`reset()` after a failure), clear (`clearSelection()`), and
  send-another (`reset()` after a success) keep their existing distinct meanings.
  On iOS, clear additionally releases scopes, deletes the staged batch and
  supersedes any import — that is `SendSelectionModel.clear()`.

## Copy: the platform-wrong strings this slice actually reaches

R3-B recorded nineteen catalog keys whose wording names a platform, and guarded
them by name. Re-deriving that set from the catalogs found **twenty-two**. The
three it missed are `error.storedKey.keychain.save`, `.read` and `.remove` —
each of which says *"macOS wouldn't …"*. They were missed because the R3-B review
enumerated the keys saying **Mac** plus the one saying **macOS**, and there were
three more of the latter. Recording the miscount is part of fixing it.

Of the twenty-two, **five** are reachable through this sending slice, and each
is corrected **in place**, in all nine catalogs, to device-neutral wording that
remains true on macOS — never duplicated under an `.ios` key.

| Key | Reached by | Correction |
|---|---|---|
| `upload.keyKept` | `UploadPresentation.keyKeptText()` on every successful send | "on this Mac" → the language's *this device* |
| `error.storedKey.keychain.save` | `keyStore.save` failing in `CloudUploadModel.finish` → `storedLinkKeyMessage(operation: .save)` | "macOS wouldn't save …" → "The keychain wouldn't save …" |
| `error.storedKey.badId.save` | same call, `StoredLinkKeyError.invalidIdentifier` | "on this Mac" → *this device* |
| `error.storedKey.badKey.save` | same call, `StoredLinkKeyError.invalidKey` on the way **in** | "on this Mac" → *this device* |
| `error.plaintext.tooManyOpenFiles` | `stageCloudFiles` → `FileURLSource` exhausting descriptors | "This Mac ran out …" → "This device ran out …" |

**`error.storedLinkKey.invalidKey` is not corrected, because this slice cannot
reach it.** R3-B's table listed it under R3-C — inherited from the old roadmap
rather than derived. `ErrorCopy.storedLinkKeyMessage` routes
`StoredLinkKeyError.invalidKey` to `errorStoredKeyBadKeySave` on `.save`, and to
`errorStoredLinkKeyInvalidKey` only on `.read`; the direct
`ErrorCopy.message(for:)` arm is likewise a read-path message. Sending never
reads a stored key. It moves to **R3-D** and stays guarded until then.

After this slice the guarded list is **seventeen**: nine for R3-D
(`account.thisMac`, `account.revokeThisMac`, `account.keyNotOnThisMac`,
`account.keyLookupFailed`, `account.keyCleanupWarning`, `account.bearerInvalid`,
`error.storedLinkKey.invalidKey`, `error.storedKey.keychain.read`,
`error.storedKey.keychain.remove`), seven for R3-E/R3-F (`nearby.explain`,
`nearby.pausedBody`, `nearby.acceptanceNote`, `notify.incomingFiles`,
`notify.incomingText`, `verify.explainEncryption`, `error.nearby.noAnswer`), and
`error.keychain.signIn`, which nothing renders on either platform yet. The count
is asserted.

### Reconciling what pinned the old noun

- `CloudUploadModelTests.testTheSuccessNoticeSaysTheKeyIsKeptOnThisMacAndNeverSent`
  asserts `notice.text.contains("this Mac")`. The substance it guards is *where
  the key lives*, not the word Mac. It becomes an assertion that the notice names
  the device and still says "never sent to Relayium", keeping its "must not say
  *only*" clause.
- `LocalizedCopyTests.testTheKeyIsKeptNoticeMakesItsClaimInEveryLanguage` asserts
  `contains("Mac")` across all nine languages — which worked only because "Mac"
  is a brand name kept verbatim in translation. It becomes a nine-entry table of
  the device noun each catalog uses, plus the unchanged brand assertion.
- `UploadPresentation`'s doc comments, `CloudUploadModel.UploadState.done`'s
  comment, and `SelectedFile.url`'s "Absolute location on this Mac" are
  corrected.
- `testSignInAndStoredKeyKeychainCopyStayDistinctInEveryLanguage` must keep
  passing: "your sign-in" and "this file's key" stay different sentences.

### The entitlements comment, which is already false

`apps/ios/Relayium/Relayium.entitlements` still explains itself in R3-A's terms:
"no keychain access group (no account yet)". There has been an account since
R3-B. The **dict stays empty** — that is the claim, and it does not change — but
the comment is rewritten to say what is true: the account keeps its bearer and
its stored-link keys in the app's **own default per-app keychain access group**,
which needs no entitlement precisely because it is not shared; R3-C adds sending
and still adds no capability; `PhotosPicker` needs no photo-library entitlement
or usage string. A comment that documents a state the app left two slices ago is
worse than no comment, because the next reader trusts it.

### New copy

Nine keys, all nine languages:

| Key | Why an existing key does not fit |
|---|---|
| `tab.send` | `upload.heading` ("Send files") is a screen title; `common.send` is a button action. A tab item is a third register |
| `send.accountTitle` | there is no "this needs an account" string; the account tab's copy is about *signing in* |
| `send.accountBody` | must say the honest asymmetry: uploads go to your account, receiving never needs one |
| `send.openAccount` | a tab-routing action; `content.openRelayium` opens a browser, which this must not |
| `send.accountUnavailableBody` | "signed in but the account did not load" is a different sentence from "you need an account" |
| `send.choosePhotos` | `common.chooseFilesOrFolders` is reused verbatim for the Files button |
| `send.preparingPhotos` | staging copies bytes and takes time; a bare spinner says nothing to VoiceOver |
| `upload.keepOpen` | the foreground-only truth, which must not be implied by silence |
| `error.photoImport.failed` | a refused batch. `error.selection.unreadable` names a path the user never saw |

No user-facing English literal is added to any Swift source;
`LocalizationSourceGuardTests` already scans `apps/ios/Relayium`. The nine
`CFBundleLocalizations` are unchanged, which is what keeps Arabic RTL.

## Accessibility and layout

- **Dynamic Type:** no fixed font sizes, no fixed frames. The pane is a
  `ScrollView`; the TTL picker wraps rather than truncates; the link is
  `.lineLimit(1)` with middle truncation and is selectable.
- **RTL:** leading/trailing only. Percentages through `L10n.percent`; counts and
  sizes through the existing presentation helpers.
- **VoiceOver:** both progress states carry text labels; Send is hidden from the
  accessibility tree while a request is in flight rather than merely dimmed; the
  selection summary is one combined element; the warning variant of the key
  notice carries its icon as a label.
- The keep-open note and any error line are in reading order **above** the action
  they qualify.

## Testing

Package tests (`swift test`); the app target holds no logic worth testing
without UI.

**`SecurityScopedAccessTests` (new)** — `replace` starts every distinct URL once;
a repeated path starts once; a second `replace` stops exactly the first batch,
once; a refused start is never stopped; `clear` is idempotent; deallocation
releases what was held; an empty `replace` releases everything.

**`PhotoStagingTests` (new)** — the naming table (separators, control characters,
leading dots, **a name that is only an extension**, missing extension, the byte
cap, **multibyte truncation on a character boundary**, **a collision suffix at
the byte limit**, `(2)`/`(3)`); `PhotoInbox.take` copies and leaves the provider
file alone; **a candidate removes its directory on `deinit`**; **`discard()` is
exactly once and safe to repeat**; **`adopt` transfers ownership only after a
successful move**, and **a failed move leaves the candidate owning its cleanup**;
an adopted candidate's later `deinit` does not delete the batch file; discard
removes a batch; adopting a batch removes the previous one; the launch-sibling
sweep removes prior launches and never the current one; `deinit` removes the live
batch; `PHOTO_IMPORT_MAX` is 50 and below `MAX_FILES`; **`PhotoStaging.swift`
declares no mutable static** — there is no global current-batch context.

**`SendPresentationTests` (new)** — `SendAvailability.state(for:)` mapped case by
case for all eight `SessionState`s, `.unavailable` distinct from
`.needsAccount`; `SendAccountContext.context(for:)` yielding a user id and a
retention only from `.ready`; `PhotoPickerChange.decide(itemCount:)` ignoring 0
and importing otherwise; `CloudUploadModel.apply` narrowing and restoring both
the TTL list and the size gate together.

**`SendSelectionModelTests` (new)** — with a `SelectionStore` whose injected
`expand` closure records whether the scope was held, a gateable config fetcher
and a gateable candidate loader:

*Files and scopes* — expansion observes the scope as held; an upload-model
refusal leaves no scope and leaves `reset()` unable to return to the previous
files; a failed expansion sets `selectionError`, releases, and **leaves
`upload.state` untouched**; `chooseFiles` while `upload.isBusy` starts nothing;
`clear()` releases scopes, deletes the batch and empties the model.

*Photo ordering and supersession* — adopted photos reach `CloudUploadModel.pick`
in selection order; a partial failure selects nothing, leaves no batch or
candidate on disk, **and leaves no prior file selection restorable**; **an import
overtaken by `chooseFiles` loses, and the file selection stands** — with the
importing flag down; the same for `clear()`, for a zero-item call and for account
isolation; **a second import started while the first is still loading supersedes
it** and keeps the flag up; a superseded import reports no error; a photo import
releases file scopes and a file pick deletes the staged batch; the inbox is swept
only at construction.

*Account isolation, driven by the session and no view* — **a
`CurrentValueSubject` transition from ready to logged out cancels an in-flight
upload and clears everything, with no `SendView` in existence**, and the
cancellation is observable **synchronously**, immediately after the state is
sent; A → B with no intervening sign-out does the same and then applies B's
retention; A's `.done` link is not visible under B; isolation lowers the
importing flag and cancels the config task.

*Caps and staleness* — retention applies immediately; `maxFileSize` only after a
successful fetch; **a gated A-config response released after sign-out and after B
signed in applies nothing** (asserted on both `maxFileSize` and `ttlChoices`); a
second account event during a slow fetch is processed immediately rather than
queueing; duplicate states produce exactly one fetch; a fetch failure leaves the
size unknown and the flow usable; no fetch is attempted with no ready account.

*Late picker callbacks* — after a ready account signs out, a file-importer result
and a photo-import task that starts late both do nothing: no scope starts, no
candidate loads, and no hidden selection or staged batch reappears.

*Observation and lifetime* — `summary`, `selectionError`, `isImportingPhotos`
and `importError` are published by the model itself, proved on the failed-
expansion path that never touches `CloudUploadModel`; releasing the model cancels
its subscription and its config task.

**`CloudUploadModelTests` (modified)** — the reconciled key-notice assertions,
plus `apply(_:)`.

**`LocalizedCopyTests` (modified)** — the five corrected keys name no platform in
any of the nine languages and keep their substance; the nine new keys are
non-empty, are not the raw key, and leave no unsubstituted placeholder; the iOS
send surface's key list — including the `error.selection.*` keys the model now
renders through `selectionError` — is Mac-free in all nine, listed rather than
derived so that adding to it is a decision.

**`IOSSurfaceGuardTests` (updated deliberately)** — `CloudUploadModel` leaves the
deferred-symbol list because this is the slice that ships it; everything else
stays, and `URLSessionConfiguration.background`, `DataRepresentation`,
`Data.self`, `startAccessingSecurityScopedResource`, `SelectionStore` and
`TaskLocal` join it. The platform-naming list drops to seventeen with the count
asserted. New: `bearerToken` appears in exactly one iOS source, exactly once;
`SendView.swift` contains no `SendAccountContext` and no `applyAccountContext`,
because the account is not the view's to drive; the `Info.plist` declares no
photo-library usage string and no `UIBackgroundModes`; the entitlements dict is
still empty.

The guard continues to scan **code**, not comments — these files explain what
they deliberately do not do, and a raw text scan would fail on exactly the
comments documenting the absences it checks for.

**Build acceptance:**

- `cd apps/RelayiumKit && swift test`;
- `xcodebuild -scheme RelayiumKit -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`;
- `xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`;
- `xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium build` — not
  optional: this slice changes `CloudUploadModel`, `UploadPresentation` and the
  catalogs macOS renders;
- `plutil -lint` on the iOS `Info.plist`, the entitlements, and the nine
  catalogs;
- `apps/mac/scripts/test-release-readiness.sh` — still `approved: false`;
- install and launch on a booted simulator.

The existing `ios-build` CI job already triggers on `apps/**`. No
`project.pbxproj` edit is needed: the target uses a
`PBXFileSystemSynchronizedRootGroup`.

### Manual validation this slice does not claim

The simulator can prove the code runs; it cannot prove the sandbox behaves,
because it is not a signed device build:

- a real send from a signed-in simulator against the production API, and the
  link opening on the web and in the app's own receive tab;
- **the security scope on a real device**, including an iCloud Drive folder
  chosen through Files, where the scope covers a *provider* and enumeration can
  block or fail;
- a large-video photo import (multi-GB) — the case `FileRepresentation` exists
  for, and the one where the inbox-to-batch move being a rename actually matters;
- reopening the Photos picker and choosing the same items again, confirming it
  imports a second time;
- cancelling the Photos picker, confirming the current selection is untouched;
- an upload interrupted by backgrounding, to confirm the failure is the ordinary
  one and the keep-open copy was accurate;
- a real sign-out during a real upload **from the Receive tab**, confirming the
  transfer stops even though the Send tab was never on screen, and that the
  server-side session is abandoned rather than completing;
- `GET /api/config` against production, confirming the returned `maxFileSize`
  matches the deployed setting;
- VoiceOver and the largest Dynamic Type sizes on the send pane;
- Arabic right-to-left layout of the send pane specifically;
- the stored-link key round trip on a signed device build.

## Open risks

- **Descriptor budget on iOS.** `stageCloudFiles` pins one open descriptor per
  file and calls `raiseDescriptorBudget` first. iOS caps what `setrlimit` grants
  far below macOS, so a large folder can hit `error.plaintext.tooManyOpenFiles`
  where the same folder sends fine on a Mac. The copy is corrected to say *this
  device* and to advise smaller batches; raising the ceiling is not something the
  app can do.
- **Staging doubles disk use for photos, briefly.** Step 1 copies out of the
  provider; step 2 is a rename, so there is no second copy — but a device close
  to full can still fail step 1. That surfaces as `error.photoImport.failed`,
  which is accurate but not specific.
- **The rename assumption is an optimisation, not a correctness requirement.**
  Inbox and batch are both under `<tmp>` today; if that ever changed,
  `FileManager.moveItem` still succeeds and merely copies.
- **`tmp` can be purged under pressure while the app runs.** Rare; the failure
  mode is an upload that fails on an unreadable staged file, reported through the
  existing path. Copying into `Documents` instead would trade a rare failure for
  a permanent one: staging copies visible in the user's Files folder.
- **Synchronous account observation depends on isolation inheritance.** The sink
  closure is main-actor-isolated because it is non-`@Sendable` and formed in a
  `@MainActor` method. Adding a `.receive(on:)` or wrapping the body in a `Task`
  would silently make isolation asynchronous and reopen the window this design
  closes. The mitigation is behavioral, not stylistic: a test asserts the
  cancellation has already happened when the state write returns, so a hop fails
  it.
- **A dropped scope is invisible until it is not.** Leaked scopes exhaust a
  process resource; the symptom is a *later* selection failing for no visible
  reason. The counting tests are the mitigation, against a fake — the real API's
  behavior on a device is in the outstanding list.
- **Account isolation abandons an upload deliberately, and silently.** The user
  gets no "your upload was cancelled" notice, because the screen that would show
  it is the one they are leaving. Announcing it needs a cross-tab notice this
  slice does not have; the alternative — an account-owned transfer continuing
  after its account is gone — is worse.
- **The size hint can be stale within a session.** It is fetched once per ready
  context, not polled. The server enforces the real cap regardless, so the cost
  is a hint that is briefly generous.
- **Foreground-only is a real limitation, not a phrasing problem.** R3-F is where
  that changes; until then the copy is the product's honesty about it.

## Later milestones

- **R3-D — account management.** Device list, stored-file management, link
  rebuild from a stored key, and the nine remaining platform-naming strings.
- **R3-E — realtime.** Pairing code, LAN/nearby, SAS verification.
- **R3-F — lifecycle.** Background `URLSession`, resume, notifications, APNs.
- **R3-G — capabilities and release.** Universal Links / Associated Domains, the
  **Share Extension** with its App Group and shared keychain group, icons, IAP,
  App Store submission — and only then any website availability change. These
  are grouped because they are one decision: each is an entitlement, a
  provisioning-profile entry, and a public claim.
