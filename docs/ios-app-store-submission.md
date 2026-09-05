# iOS App Store and TestFlight submission

This is the release operator's source of truth for Relayium's iOS App Store
record. It records verified code and local signing facts separately from App
Store Connect and production mutations that still require an explicit release
step.

Nothing in this document authorizes creating paid products, changing production
configuration, uploading a build, adding testers, submitting for review, or
releasing a version.

**iOS is not public.** There is no public App Store release of the iOS app, no
Relayium download surface offers it, and no public surface may present iOS as a
Relayium platform. The macOS platform of the same App Store record *is*
publicly released, which is exactly why every statement here is scoped to a
platform rather than to "the record".

## App record

Relayium's iOS app is **the second platform of the macOS App Store record**, not
a record of its own. Apple ID `6801142976` carries both macOS and iOS, and Apple
requires every platform in one universal-purchase record to share a single
Bundle ID — which is why the iOS app signs as `com.relayium.mac`.

| Field | Value |
| --- | --- |
| App Store Connect name | relayium |
| Apple ID | `6801142976` |
| Bundle ID (both platforms) | `com.relayium.mac` |
| iOS share extension bundle | `com.relayium.mac.ShareIOS` |
| macOS share extension bundle | `com.relayium.mac.Share` |
| Team | `7PVYUG4YQS` |

The iOS platform is not new. Its TestFlight was read back holding a Validated
`0.1.0 (4)` whose Build Metadata reports main bundle `com.relayium.mac`, Share
Extension application identifier `7PVYUG4YQS.com.relayium.mac.ShareIOS` and App
Group `group.com.relayium.app`. Those three readings are what the iOS source
was migrated to match, rather than the other way round.

The two App Store provisioning profiles the Release configuration names —
`Relayium iOS Universal App Store` and `Relayium iOS Share Extension App Store`
— are named by this repository and **created in the developer account by the
owner**. Nothing here provisions anything, and no profile has been observed to
exist. `scripts/ios-app-store-candidate.sh` fails closed on a missing one: the
archive fails and an operator investigates.

### There are two records, and the wrong one looks right

**This reverses on 2026-09-03.** Until then this document named `6791918822` as
the target and told the operator never to touch `6801142976`. The owner supplied
the actual iOS TestFlight URL, which resolves to `6801142976`, and directed that
the version be updated there. The instruction is now inverted, and the old one
is not preserved as a caveat because a document carrying both would be worse
than one carrying the wrong one.

**Never target `6791918822` with an iOS release.**

| Apple ID | Bundle | What it is |
| --- | --- | --- |
| `6801142976` | `com.relayium.mac` | **The target.** One universal-purchase record, macOS and iOS. The only record this document, the metadata packet and any iOS archive describe. |
| `6791918822` | `com.relayium.app` | A real, separate, **iOS-only** record. Superseded and entirely read-only. |

The second row is the whole problem, and it is more dangerous than it was when
the rows were the other way round: `6791918822` is a genuine iOS record that
*this repository itself named as the target* until 2026-09-03, so it looks
correct in every older commit, plan and copy of this file. Nothing was ever
delivered to it — no build uploaded, no subscription group or product created,
no privacy answer entered — and its editable version was set to `0.3.0` Prepare
for Submission by the same superseded pass, which makes it look prepared.

Never upload to it, never enter this packet into it, never create a product
under `com.relayium.app`, and never let an iOS identifier resolve to it.

This is not left to memory. `scripts/ios-app-store-metadata-validate.mjs` pins
both identifiers and refuses a packet that names `6791918822` as the record,
that names a `com.relayium.app.*` product identifier anywhere, that marks the
superseded record as the iOS delivery target, or that drops it from the
observation below — because an operator who has not been told the second record
exists is the one who will find it. `UniversalPurchaseIdentityTests` holds the
same identity across both Xcode projects, the entitlements, the candidate script
and the packet.

### Why a second product namespace must never be created

An App Store product identifier is permanent: it cannot be deleted or renamed.
The six `com.relayium.mac.{plus,pro,max}.{monthly,yearly}` subscriptions already
exist in group `22307427`, are Approved, and are what the released macOS app
sells through. Creating a `com.relayium.app.*` set — which targeting
`6791918822` would have required — would permanently fork the catalogue, and
every entitlement decision downstream would then depend on which namespace a
transaction arrived from.

Reuse is also what makes the migration cheap on the server: Relayium's
`apple_products` table already maps those six identifiers for bundle
`com.relayium.mac`, so an iOS purchase is resolvable with no catalogue or
verifier change. That is an expectation to **verify by read-back** before an iOS
purchase is accepted, not a conclusion this document may assert on its own.

## Development baseline

| Field | Value |
| --- | --- |
| Marketing version in the project source | `0.3.1` |
| Build in the project source | `5` |

`0.3.1 (5)` is the **prepared release candidate** of the iOS line restarted on
2026-09-01. It is what `apps/ios/Relayium.xcodeproj` builds; it is not an
uploaded build, not a TestFlight candidate and not a release. Nothing has been
archived from it, and preparing it authorizes no upload.

The build does **not** move with the marketing version. `0.3.0 (5)` was the
development baseline and was never archived or uploaded, so build `5` is still
unconsumed on the record and `0.3.1` is the first marketing version that will
actually carry it. `0.3.1` adds the local-link Nearby work — LAN Transfer now
discovers only the `_relayium._tcp` Bonjour service on the local network
instead of the server's public-address room — on top of everything `0.3.0`
already contained.

**The App Store Connect version record now reads `0.3.1`.** The iOS platform's
editable version was renamed on the record, and read back live on **2026-09-05
15:27 (Asia/Dubai)** as `0.3.1`, *Prepare for Submission*, with **no build
selected** and **Manual** release still selected. That reading is what
`docs/app-store-metadata-ios.json` now carries under
`appStoreConnectObservation`, so `record.marketingVersion` and
`observedVersion` agree and `scripts/ios-app-store-metadata-validate.mjs`
accepts the packet. The rename closed no gate: the build selection and the
screenshots are still the two open ones. If the candidate version ever moves
again, rename it on the record and read it back **first** — `observedVersion`
records what was observed, not what is wanted, and the drift check exists to
make that order compulsory.

### What the version history actually is

- `1.2.10 (2)` was a **never-delivered native candidate** from 2026-08-18 that
  deliberately synchronized the then-current macOS and iOS marketing versions.
  It was never uploaded to this record. **It is not the iOS release floor**, and
  a later iOS marketing version does not have to exceed it. App Store Connect
  requires the *build* number to increase within a record; the marketing version
  is not constrained that way.
- `0.1.0` **build 4 is Validated / Ready to Submit** on this record's iOS
  TestFlight, read back on 2026-09-03; an earlier `0.1.0` build was rejected by
  a purpose-string check. Build `5` is therefore the next build above the
  highest number this record is **known** to have consumed. That reading is a
  **floor, not an answer**: expired, removed and `Invalid` builds keep their
  numbers and do not appear in a TestFlight list, so the true highest may be
  above 4 and the operator still owes a live read-back.
  `scripts/ios-app-store-candidate.sh` encodes exactly that asymmetry — it
  refuses a `--readback-highest-build` below `4` as provably wrong, and accepts
  anything at or above it without treating it as verified.
- A local signed archive and non-uploading App Store export of historical
  build `1` passed with the intended distribution identities and profiles. The
  retained historical artifacts are:
  - archive: `/tmp/Relayium-iOS-subscriptions-e4dd73d7.xcarchive`;
  - IPA: `/tmp/Relayium-iOS-subscriptions-e4dd73d7-export/Relayium.ipa`;
  - IPA SHA-256:
    `45be4bbf6ac8f14482276804e42a624af6c9ba185159b621e403996378df8bbc`.

  These are historical acceptance evidence for a build that is several versions
  behind. They are not the `0.3.1 (5)` candidate and not permission to upload.

### App Store Connect read-back, 2026-09-03

The target record — `6801142976` / `com.relayium.mac` — was inspected read-only
on **2026-09-03 (Asia/Dubai)**, field by field, and its version, build
selection and release option were re-read on **2026-09-05 15:27 (Asia/Dubai)**
after the version was renamed to `0.3.1`. This does **not** make this document a
live view: what follows is a dated transcript of two read-only passes, and it
goes stale.

`docs/app-store-metadata-ios.json` carries the same readings machine-readably
under `appStoreConnectObservation`, and
`scripts/ios-app-store-metadata-validate.mjs` refuses a packet that claims any
absent field is present.

Most of this record was configured for the **released macOS app**, and that is
what closed most of the gates at once. It is also the hazard: these fields are
shared across both platforms, so editing one to suit iOS changes it for macOS
customers.

| Field | Read back | Gate |
| --- | --- | --- |
| App Store version (iOS platform) | `0.3.1`, **Prepare for Submission** — re-read 2026-09-05 | met |
| Build selected for the iOS `0.3.1` version | none selected — re-read 2026-09-05 | **blocks submission** |
| Subscription group | `22307427`, **Approved** | met — **reuse it** |
| In-app purchases and subscription products | the six `com.relayium.mac.*`, all **Approved** | met — **reuse them** |
| App Privacy data practices | **published** | met — **preserve it** |
| App Privacy — Privacy Policy URL | `https://relayium.com/privacy/` saved | met — **preserve it** |
| App Privacy — User Privacy Choices URL | blank | optional; not owed |
| Pricing | **Free** across all 175 price territories | met — **preserve it** |
| App availability | 173 territories; China mainland and France excluded | met — **preserve it** |
| Screenshots | required iPhone and iPad sets missing on the iOS version | **blocks submission** |
| Version release option (iOS `0.3.1`) | **Manual** release selected — re-read 2026-09-05 | met — **preserve it** |
| App Store Server Notifications V2, Production and Sandbox URLs | both saved to `https://relayium.com/api/apple/notifications` | met — **preserve it** |

Three of those rows carry a **later, narrower reading**: the version, its build
selection and its release option were re-read on **2026-09-05 15:27
(Asia/Dubai)**, after the record's iOS version was renamed to `0.3.1`. Every
other row is still the 2026-09-03 pass and has not been re-verified since. The
gate count did not move — renaming a version neither opens nor closes one — and
the version row remains **met** in the only sense the gate measures: an editable
iOS version exists on the record.

**Two of those twelve are unmet gates: the build selection and the
screenshots.** For the iOS platform, no archive, no upload, no submission and no
release has happened. *Prepare for Submission* is App Store Connect's state for
a version that has never been submitted; it is not a claim that anything is
prepared, and **nothing here says this app is ready to be submitted**.

The scope of those four negatives matters, because this record's **macOS**
platform *is* publicly released. Unqualified, they would be a claim about the
whole record and wrong about half of it.

Most rows are now "preserve it" rather than "do it", which inverts the failure
mode for them. The risk is no longer forgetting to enter a value; it is editing
or deleting one that is already live and shared with a released app. Do not
remove, blank or repoint the notification URLs. Do not change the app price, the
territory selection, the subscription group, the products or their prices to
suit iOS.

The release option is the row most easily mistaken for an intention this
repository holds. It is not: **manual** was read off the iOS `0.3.1` version.
Leave it there. A version set to release automatically ships itself the moment
review passes, which removes the last point at which a human can decide not to
ship — and iOS is not public.

On the signed `TEST` notification delivery this document deliberately claims
nothing. Such a delivery has been recorded elsewhere for this record's **macOS**
platform, and now that the target *is* that record it would be easy to promote
that into a claim about the iOS side — but it was not re-verified in this
read-back, so it stays unproven. Prove it rather than inferring it from the
merge of the two records.

#### What was not read back, and is still owed

The TestFlight reading gives a **floor of 4**, not the highest consumed build
number: expired, removed and `Invalid` builds keep theirs and do not appear. So
the build-number question is narrowed by this inspection, not closed. Build `5`
has **not** been verified as free against the record remotely, the claim that it
is the next free build number remains a local expectation, and
`scripts/ios-app-store-candidate.sh`'s `--readback-highest-build` remains an
operator attestation — now with a floor beneath it that catches an attestation
carried over from the superseded record's (empty) history.

Before archiving or uploading, re-inspect the record read-only and confirm, at
minimum:

1. the highest build number the record has accepted **on its iOS platform** for
   every marketing version, including builds in `Invalid`, `Processing` or
   expired-TestFlight states, which still consume a number;
2. that the intended `(marketing version, build)` pair is free and increases the
   build number within the record;
3. the current App Store and TestFlight status of the app, on both platforms.

Also unobserved on 2026-09-03:

- the **Accessibility Nutrition Label** on this record. The earlier *Not
  Started* reading was of the superseded record and does not transfer. Nothing
  is claimable regardless, for the reason the Accessibility section below gives,
  so this is an unread field rather than an open gate;
- the live subscription group's reference name, its localized display names, and
  each product's localized display name, description, price and territory
  availability. Their existence and Approved state were read; their **copy** was
  not, and it is deliberately not drafted in the metadata packet — a display
  name written there is an edit somebody can paste into an Approved product;
- whether the Approved products already carry their own review information and
  review screenshots;
- a signed App Store Server Notification `TEST` delivery observed arriving from
  this record's iOS side;
- **Sign in with Apple completed end to end on a real signed iOS device**, and
  **an Apple purchase completed against the six live products from such a
  build**. Both are covered under "What is still owed before any customer sees
  this" below;
- the export-compliance answers carried on the version, and the age-rating
  questionnaire;
- App Review information — the contact fields and the demo account, which are
  owner-entered in App Store Connect and are never recorded in this repository.

The screenshot reading has a boundary of its own. What was read is that the iOS
version's **required iPhone and iPad device sets are missing**; each set's
per-localization sub-view was *not* opened and read back separately. Nothing
here establishes a per-localization live state. The gate stays blocked either
way, because the device-set reading is already enough to block it; what may not
happen is that a field-scoped reading quietly grows into an all-locales claim
nobody made.

The **macOS platform of this same record** is a different matter, and the
boundary there is **scope, not ignorance**. It is publicly released, and its
version, builds, prices, TestFlight groups and release state are read-only for
this document. What is recorded above about it is only what the iOS side depends
on — the shared bundle id, the shared catalogue, the shared privacy answers,
the shared price and availability. Nothing here authorizes changing any of it.

If a later read-back contradicts any of this, correct the project source, this
document and the metadata packet before building — do not upload against these
numbers and do not record a remote fact this file has not observed.

## Building the candidate: `scripts/ios-app-store-candidate.sh`

The archive, the App Store export, the checksum and the built-candidate
readbacks this document requires are one command.
`scripts/ios-app-store-candidate.sh` performs them in order, refuses before
`xcodebuild archive` when any precondition is unmet, and writes every artifact
and log under one directory it creates.

**It does not upload, and it reserves no build number.** It runs no `altool`,
no `notarytool`, no Transporter and no App Store Connect API call; its export
is `destination = export`, not `upload`. It solicits, stores and transmits no
App Store Connect credential — no API key, no issuer ID, no app-specific
password, no session — and takes no option that would carry one.

It does read the keychain, and saying otherwise would be false: `xcodebuild`
and `codesign` sign the archive and the export with the Apple Distribution
identity and private key already installed in the operator's login keychain,
and macOS may prompt for access to it. That is a local read of an
identity the operator already holds, performed by Apple's own tools on this
machine. It is not a provider credential this script holds, and signing locally
mutates nothing in the developer account: `-allowProvisioningUpdates` is absent,
so no profile or device registration is created or modified either.

The boundary, precisely: nothing about running this script makes a build number
unavailable, causes anything to appear in App Store Connect, or reaches a
tester. Uploading the artifact it produces is a separate step under a separate
authorization, and this document authorizes neither.

It also never deletes: the artifact root must not already exist, so no path an
operator names is written into, emptied or removed by any outcome — including a
failure, which preserves everything it had produced up to that point.

### The App Store Connect read-back is an attested input, not a checkbox

The script cannot see App Store Connect and does not pretend to. The operator
performs the read-only inspection described above and then **attests** to it in
three values the script cross-checks against each other and against the project:

| Option | What it must be |
| --- | --- |
| `--marketing-version` | the marketing version observed for the candidate |
| `--readback-highest-build` | the highest build number the record shows **consumed**, in any state — including `Invalid`, `Processing` and expired TestFlight builds |
| `--build` | the next free build, which must equal `--readback-highest-build` + 1 |
| `--readback-observed-at` | the UTC instant of that inspection, `YYYY-MM-DDTHH:MM:SSZ` |

**These are an operator attestation plus a consistency check — not proof that
the read-back happened.** Nothing local observes App Store Connect, so somebody
who guesses a highest build and adds one satisfies the cross-check exactly as
well as somebody who read the record. Do not read a passing run as evidence that
the record was inspected.

What the shape does buy is worth having, and it is a different thing: the claim
has to be stated as a specific number rather than ticked, it is recorded in the
manifest as the operator's claim, and an off-by-one, a transposition or a number
carried over from the last candidate is caught here instead of at upload. Both
numbers must be canonical decimal — `--build` as `[1-9][0-9]*` and
`--readback-highest-build` as `0` or `[1-9][0-9]*` — so a leading zero is
refused with exit `2` rather than being read as octal. The cross-check itself
compares decimal strings and computes `highest + 1` one digit at a time, never
with shell arithmetic: `$(( ))` is fixed-width and wraps silently, so a
canonical but very long build number would otherwise compare equal to its
remainder modulo 2^64. There is no length limit to keep in step with Apple's.
The timestamp must be in the past and no more than 12 hours old, so a read-back
from a previous working day cannot authorize today's build number.
Only the operator's own discipline puts a real observation behind any of it.

Both numbers must additionally equal what `apps/ios/Relayium.xcodeproj` already
declares for **both** the app and the Share extension. The script never edits
the project and sets `manageAppVersionAndBuildNumber` to `false`, so the export
cannot renumber the build either. If the read-back says the project's build is
already consumed, bump the project in its own reviewed change first — that is a
source edit with a diff, not something a build script does on the way past.

### Usage

```sh
scripts/ios-app-store-candidate.sh \
  --marketing-version 0.3.1 \
  --build 5 \
  --readback-highest-build 4 \
  --readback-observed-at 2026-09-02T11:30:00Z \
  --artifact-root ~/relayium-candidates/ios-0.3.1-5-<short8-sha>
```

The values above match the candidate this document records — project `0.3.1 (5)`,
with build `4` the highest this record is known to have accepted. **They are an
example of the shape, not a licence to skip the read-back**: supply what the
record actually shows on the day.

The artifact root must be absolute, must not already exist, must sit outside
this repository and at least two levels deep, must not be a system or home
directory, and its name must end with `-<short8 sha>` of the commit being
built. Keeping candidates under the private workspace
`test-builds/ios/<version>-<short-sha>/` satisfies all of that.

Beyond the read-back, the script refuses to archive unless:

- the selected Xcode is exactly major 26 and the iphoneos SDK is 26 or newer —
  Apple's current upload floor, checked separately because what Apple validates
  is the SDK the binary was linked against;
- the worktree is clean, `HEAD` is a commit, the branch has an upstream, and
  `HEAD` equals it — a candidate names a commit somebody else can fetch;
- both targets declare team `7PVYUG4YQS`, bundle IDs `com.relayium.mac` and
  `com.relayium.mac.ShareIOS`, `CODE_SIGN_STYLE = Manual` for Release, and the
  exact profiles `Relayium iOS Universal App Store` and
  `Relayium iOS Share Extension App Store`;
- the attested highest consumed build is not below `4`, the floor this record's
  iOS TestFlight was read back at;
- the App Store metadata packet passes its validator, for **this** marketing
  version — see below.

### The metadata packet is a precondition too

The candidate and the words submitted with it are one delivery. Before the
artifact root is created, the script runs

```sh
node scripts/ios-app-store-metadata-validate.mjs \
  --packet docs/app-store-metadata-ios.json \
  --expect-version <the candidate's marketing version>
```

and refuses with exit `2` on any finding. It sits in the ladder between the
repository-state checks and the project settings, so a rejected packet stops
the run before `-showBuildSettings`, before the artifact root exists and long
before `xcodebuild archive` — it leaves nothing behind at all. An accepted
packet's SHA-256 is recorded in all three manifests, under `metadataPacket` in
the machine-readable ones, labelled as validated-before-archive and **not**
entered in App Store Connect.

`--expect-version` is the part that catches the failure a length check cannot:
a What's New drafted for another marketing version passes every limit Apple
enforces and is still a false public statement about the build being archived.

The validator also reads the packet's `appPrivacy` block — the draft App Privacy
answers — against its own pinned graph **and** against
`apps/ios/Relayium/PrivacyInfo.xcprivacy`. The second comparison is the one that
matters: without it, the packet and the validator could be edited together to
agree with each other and not with the binary Apple reads. It likewise refuses
storefront copy that promises a control this build does not ship — the copy said
a stored link takes "your own expiry and download limits", and `SendView`'s
options are exactly an expiry `Picker` and a `burnAfterRead` `Toggle`. A
download-count cap does exist in the product (the CLI's `--max-downloads`, and
the server resolves one), which is precisely why the claim read as plausible;
what matters here is that **no iOS surface offers it**, and the listing is
describing the iOS app.

The gate needs `node` on `PATH` and refuses without it, because an unvalidated
packet is not a candidate. `scripts/test/ios-app-store-candidate-test.sh` proves
both the refusal and its position in the ladder, by mutation and by executing
the script against a fixture whose packet has been broken one field at a time.

`-allowProvisioningUpdates` is deliberately absent and must stay absent: it
authorizes Xcode to create or modify provisioning profiles in the developer
account, which is a provider mutation. A missing or expired profile is meant to
be a failed archive an operator investigates.

Exit status distinguishes the three outcomes: `2` a refused precondition
(nothing was built), `3` a failed archive or export (logs preserved), `4` a
candidate that built but failed verification (everything preserved).

### What it leaves behind

Under the artifact root:

| Path | What it is |
| --- | --- |
| `ExportOptions.plist` | generated for this run — `destination = export`, `method = app-store-connect`, team `7PVYUG4YQS`, manual signing, both bundle-to-profile mappings, `manageAppVersionAndBuildNumber = false` |
| `Relayium.xcarchive` | the signed archive |
| `export/Relayium.ipa` | the exported App Store IPA |
| `verify/` | the unpacked payload, both bundles' entitlements, and the `AVCapture` symbol lists |
| `logs/` | the complete archive and export logs, the `codesign` output, and `-showBuildSettings` for both targets |
| `candidate-manifest.txt` | the human-readable manifest |
| `candidate-manifest.plist`, `candidate-manifest.json` | the same facts machine-readably |

The manifest records the full commit, branch and upstream, the marketing
version and build, the attested read-back values and their age at build time
(labelled there as the operator's claim rather than an observation), the Xcode
version and build and the iphoneos SDK, the pinned release graph, and SHA-256
for the IPA, the archived app binary and the generated export options. It
contains no credential and no secret.

### What the verification proves

Every check runs against the **archive** and the **exported IPA payload**, not
against source, because signing, thinning and packaging sit between the two:

- app and Share bundle identifiers, marketing version and build;
- exactly one `.appex` anywhere in the payload, and it is the Share extension;
- a distribution signature and team `7PVYUG4YQS` on both bundles, with
  `get-task-allow` **absent or an explicit `false` Boolean, and nothing else**.
  Both shapes are accepted because a real Apple Distribution entitlement set
  writes the key explicitly rather than omitting it — `0.3.1 (5)` does, on both
  bundles — and what matters is that the shipped bundle does not let a debugger
  attach. A value that merely *reads* as false is rejected: the check extracts
  the entitlement as typed XML, so the string `"false"` and the integer `0` are
  findings rather than a disabled debugger, and an unreadable entitlement file
  is a finding rather than an absence;
- the app's three entitlements — Sign in with Apple, `applinks:relayium.com`,
  App Group `group.com.relayium.app` — and the extension's one, **including the
  absences**: the extension carries no Sign in with Apple, no associated
  domains and no keychain access group;
- a valid, non-tracking privacy manifest in both bundles of **both** the archive
  and the exported payload — four files, because the export re-signs and
  repackages what the archive produced — each declaring **exactly** its own
  required-reason graph and nothing else. The app's four are
  `NSPrivacyAccessedAPICategoryUserDefaults` `CA92.1`,
  `NSPrivacyAccessedAPICategoryFileTimestamp` `DDA9.1`,
  `NSPrivacyAccessedAPICategorySystemBootTime` `35F9.1` and
  `NSPrivacyAccessedAPICategoryDiskSpace` `E174.1`; the Share extension declares
  the file-timestamp one alone, because it links only `RelayiumShareKit`. Exact
  in both directions: a category the source does not justify is as false a
  public statement as a missing one, and the extension silently shipping the
  **app's** manifest is present, valid and wrong;
- in the same four files, **exactly** the pinned collected-data graph: the app's
  six types with their linked, tracking and purpose flags, and the extension's
  **empty** list. This is the half that becomes the App Store privacy label, and
  it fails more quietly than the one above — a wrong required-reason graph is an
  upload rejection Apple raises, while a wrong collected-data list uploads
  cleanly and publishes a false promise to everyone reading the listing. The
  comparison is equality, so `NSPrivacyCollectedDataTypeDeviceID` being added
  back is a finding rather than something a "contains" check would wave through.
  See [App Privacy](#app-privacy) for the graph itself;
- `NSCameraUsageDescription` and `NSLocalNetworkUsageDescription` in the built
  app `Info.plist`, and the camera string localized in the app bundle's own
  `en.lproj` and `zh-Hans.lproj`;
- in the Share extension, **no** camera declaration, **no** `.lproj` at its own
  bundle root, **no** `InfoPlist.strings` at any depth, and a `.lproj` set
  **exactly equal** to `RelayiumKit_RelayiumShareKit.bundle/en.lproj` and
  `RelayiumKit_RelayiumShareKit.bundle/zh-Hans.lproj`. The localization half of
  that rule is read in **both** the archive's copy of the extension and the
  export's — two reads of the same pinned set, for the reason the privacy
  manifests are read four times: the export re-signs and repackages the archive,
  so neither copy is evidence about the other, and a `.lproj` the export strips
  was still shipped in the archive. (The camera *declaration* is read in the
  exported payload, alongside the app purpose strings in the bullet above.) This
  is a placement and equality rule rather than an absence: `RelayiumShareKit` is a SwiftPM target
  with `.process("Resources")`, so every build embeds that resource bundle with
  the extension's own translated interface copy. iOS reads a purpose string from
  the extension's *own bundle root* — `Info.plist`, then
  `<language>.lproj/InfoPlist.strings` beside it — and attributes the prompt to
  the host app, so that root is the boundary; equality is what additionally
  catches a third language, a second resource bundle, or those localizations
  moved into a differently named one;
- `AVCapture` undefined symbols in the app's own binary and in the embedded
  `WebRTC.framework` — the readback *Validation outstanding* below owes against
  a signed candidate rather than an unsigned local build.

### What it is not

It is not a launch, not a submission and not proof of the physical gates. It
signs and packages; it does not accept a system privacy alert, exercise a
two-device transfer, or observe App Store Connect.

Its verification half also requires a real signed artifact, which bounds what
`scripts/test/ios-app-store-candidate-test.sh` can cover. That suite
mutation-tests every policy rule and executes the refusal ladder, the generated
export options and — against stubs that compile, link and sign nothing — the
exact `xcodebuild archive` and `xcodebuild -exportArchive` invocations,
including that neither carries `-allowProvisioningUpdates`. It reaches the
export by letting the stub create the empty `.xcarchive` the script asked for,
then fails the export; it never fabricates a signed export and therefore
deliberately stops before the post-export checks.

One post-export check is the exception, and deliberately so: the privacy-manifest
comparison needs no signature, so the suite lifts the script's own graph reader
and its checker out of the file and drives them against manifests it builds —
proving that a missing category, a wrong or extra reason code, an over-declared
category, a duplicated category or reason, an extension carrying the app's
manifest, an unreadable manifest and an absent one each raise a finding, and that
the manifests this repository ships raise none. Everything else past the export —
the signatures, the entitlements, the purpose strings, the symbol readbacks — is
exercised only by the operator run, and recorded here.

## Device Inbox: what this app now does, and what it deliberately does not

`0.3.0` adds the receive half of Device Inbox. The app enrols this device with
the account, receives files and messages sent from the account's own other
devices, and shows a per-device conversation of what has been received and sent.
The five browseable surfaces are LAN Transfer, Cross-network Transfer, Send,
Device Inbox and Account. Opening a stored link is no longer one of them: it is
presented over whichever surface the user was on, reached from a verified
Universal Link or an Account stored-file row, exactly as before.

Three facts are review-relevant and must be answered truthfully rather than
inferred from the feature's name:

- **The receiver is foreground-only.** It runs while Relayium is open and stops
  when the app leaves the foreground. This is enforced in
  `InboxController.foreground(_:)`, not merely described, and the surface states
  it unconditionally (`inbox.iosForegroundOnly`).
- **No new capability was added to ship it.** The app declares no
  `UIBackgroundModes`, uses no background `URLSession`, registers for no remote
  notifications, requests no notification authorization, and schedules and
  delivers no notification. State it that way rather than as a claim about
  binary linkage: `RelayiumAppKit` carries `canImport(UserNotifications)`
  source, so whether the framework is linked into the iOS binary is not settled
  until an `otool -L` readback of a built product says so. The entitlements are
  unchanged by this feature. One purpose string has since been added to the
  app — `NSLocalNetworkUsageDescription` — but it belongs to the peer-to-peer
  transfer lanes rather than to Device Inbox; see *Local Network access* below.

  The **privacy manifest** did change, and the earlier claim here that it had
  not was wrong. Device Inbox refuses a delivery that will not fit before
  writing anything, and `InboxSpace.freeBytes` performs that preflight with
  `statfs` (`InboxFailure.swift`). Apple's required-reason list places `statfs`
  under `NSPrivacyAccessedAPICategoryDiskSpace`, so the app's manifest declares
  reason `E174.1` — checking that there is sufficient disk space to write files.
  E174.1 permits that use provided nothing derived from the reading is sent off
  device, and nothing is: the byte count is compared against the delivery's size
  and the comparison's Bool is all the rest of the app sees. This is a
  required-reason API declaration, not a data-collection one, so it changes no
  App Privacy answer. The Share extension does **not** declare it — `InboxSpace`
  lives in `RelayiumAppKit`, which that target does not link — and neither macOS
  manifest declares it either, because Apple's required-reason rule names
  iOS/iPadOS/tvOS/visionOS/watchOS and not macOS.
- **Received files land in `Documents/Received`** — the same directory a stored
  link's download writes into, published to the Files app by the existing
  `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` keys. There is
  no folder picker and no new file-system reach. Receiving is off by default and
  is an explicit per-account consent inside the app.

None of this changes the App Privacy declaration: the message and file bodies
are end-to-end encrypted, are decrypted only on this device, and are stored
inside the app's own container. Relayium's server sees ciphertext.

## Subscription activation boundary

The app owns one process-scoped StoreKit model, loads products only from the
authenticated Relayium catalog, submits Apple's signed transaction to Relayium,
and finishes it only after the server accepts the entitlement. Account exposes
purchase, restore, Apple subscription management, Privacy Policy and Terms; it
contains no web checkout. The Share extension does not link StoreKit.

iOS and macOS are **one universal-purchase record sharing one bundle ID and one
subscription catalogue**. Relayium records Apple's signed bundle ID as the
subscription source scope (`ExternalScope`), so both platforms now write the
*same* scope string where they previously wrote two different ones. Migrated
rows with no known scope fail closed and self-repair from a verified same-app
event.

Two consequences follow from that, and they are the money-moving half of this
migration:

- **The catalogue and the verifier need no change, and that is a claim to
  verify rather than assume.** `AppleProduct` is keyed by the *pair* (bundle id,
  product id), and the verifier's closed app set is keyed by (bundle id, App
  Apple ID). Both are expected to already hold `com.relayium.mac` /
  `6801142976`, because the released macOS app uses them. Read them back.
- **A cross-platform guard changed meaning without any code changing.**
  `ApplySubscriptionSource` refuses a second live Apple subscription when the
  incoming event has a different original transaction id **or** a different
  scope (`sqlite_entitlement.go`). Before the migration the two platforms
  differed by scope; now they do not, so that half of the guard no longer
  separates them and only the original transaction id does. For a genuine
  universal purchase that is correct — Apple issues one subscription with one
  original transaction id across both platforms — but it is a protection that
  silently stopped applying, not one that was deliberately removed.

Before the migration an iOS build signed as `com.relayium.app` matched no
catalogue row and was refused with `unknown_bundle`; purchases were gated
closed. After it, an iOS build reaches the live, Approved products the released
macOS app sells through. The gate that was doing the protecting is gone by
design, so the entitlement paths owe **adversarial** evidence — a double-charge,
early-grant, wrong-tier or cross-platform-conflict case — rather than a
regression run.

Note also that several server comments still describe macOS and iOS as
"different bundle ids" and "separate App Store records"
(`server/account/apple_transaction.go`, `server/account/entitlement.go`,
`server/account/sqlite_entitlement.go`, `server/account/store.go`). The
mechanism they describe is unaffected — it compares strings — but the prose is
now stale. `server/` is outside this task's scope; this is recorded as a
follow-up, not changed here.

The 2026-09-03 read-back found the record carrying **subscription group
`22307427`, Approved, with all six `com.relayium.mac.{plus,pro,max}.{monthly,yearly}`
products Approved**. So the work below is verification, not creation.

Before uploading a TestFlight build:

1. **Create nothing.** The group and all six products exist and are Approved.
   An App Store product identifier is permanent — it cannot be deleted or
   renamed — so creating a `com.relayium.app.*` set would permanently fork the
   catalogue the released macOS app sells through. The validator refuses such an
   identifier anywhere in the packet, and `UniversalPurchaseIdentityTests`
   refuses it in the repository. Four things about that catalogue are worth
   stating plainly because each is easy to get wrong:
   - **do not edit the live products' reference names, display names,
     descriptions, prices or territory availability to suit iOS.** One record has
     one catalogue; those fields are shared with the released macOS app, and an
     edit here is an edit there. The packet deliberately records no copy for
     them — a display name written there is an edit somebody can paste into an
     Approved product;
   - **Apple's "first subscription group must be submitted with an app version"
     rule does not apply.** That is about a record's *first* group. This group is
     Approved and already selling, so submitting the iOS version does not
     resubmit it;
   - **prices and territory availability are live, not an owner decision
     outstanding.** They were configured for macOS and serve iOS unchanged. The
     validator still refuses any currency amount or decimal price anywhere in the
     packet, so nothing about them is transcribed into this repository;
   - **each product carries its own review information**, and Apple may require a
     review screenshot per product. Whether the Approved products already carry
     them was **not** read back.
   The packet's `subscriptions.state` is
   `existing-approved-catalogue-reused-under-the-universal-record`, with
   `noNewProductsMayBeCreated: true`. Their existence and Approved state are a
   dated read-back, not a live query; re-inspect read-only before relying on it.
2. **Verify, do not add,** the `(bundle ID, product ID) -> (plan, cycle)` rows in
   Relayium's `apple_products` catalog. All six are expected to be present
   already for bundle `com.relayium.mac`, because the released macOS app sells
   through them — that is what makes an iOS purchase resolvable with no server or
   catalogue change. Read them back as live; an expectation this repository holds
   is not evidence.
3. **Verify, do not add,** the production verifier's closed app set. It is
   expected to admit `com.relayium.mac` and Apple ID `6801142976` already, for
   the same reason. **No second verifier identity is to be added** — admitting
   `com.relayium.app` would re-open the identity this migration closed.
4. The App Store Server Notifications V2 Sandbox and Production URLs are already
   configured and were read back on 2026-09-03; **preserve them**. What is still
   owed is a signed `TEST` notification observed reaching Relayium from this
   record's iOS side. Do not remove or repoint either URL to get it.
5. Confirm App Privacy and subscription metadata match the code and public
   policy. The app manifest declares linked Name, Email Address, Purchase
   History, User ID and Other Usage Data for App Functionality, plus an
   **unlinked** Product Interaction entry for Analytics — the identifier-free
   activation aggregate — with tracking false throughout and `DeviceID`
   deliberately absent. The full graph, the reasoning and the DeviceID revisit
   trigger are in [App Privacy](#app-privacy). The record's App Privacy is
   already **published** and its Privacy Policy URL `https://relayium.com/privacy/`
   is saved, so this step is a consistency check against a live public promise,
   not a form to fill. The record's published list is the **union** across both
   platforms — seven types, against the six in the iOS manifest; the extra one is
   `DeviceID` and it is macOS's alone. The two lists disagreeing is correct, and
   the failure mode is making them agree.

**Verify the server before TestFlight, and verify it rather than assuming it.**
Before the migration an iOS build signed as `com.relayium.app` was refused with
`unknown_bundle`, which is a gate that fails safe. After it, the binary reaches
a live catalogue, so a wrong `apple_products` row or verifier entry no longer
produces a refusal — it produces a wrong entitlement or an unaccepted charge.
Steps 2 and 3 above are expected to already pass; read them back and prove it.

### What is still owed before any customer sees this

Nothing in this batch touched production, and nothing needs to. A read-only
production check on **2026-09-03** found the Sign in with Apple audience
allowlist `RELAYIUM_APPLE_CLIENT_IDS` **already admitting `com.relayium.mac`**,
alongside `com.relayium.app` and the web Services ID — so the migrated bundle
id's `aud` is accepted, and no production change is part of this work.

That closes a configuration question and opens nothing. Two kinds of evidence
are still outstanding, and neither is satisfied by a repository test, a
simulator run or a read-back:

- **A real Sign in with Apple on a signed device.** An admitted audience is not
  a completed sign-in. The live flow — a real Apple ID on a signed iOS build,
  through the authorization-code redemption, to a Relayium account — has never
  been run. The App ID's Sign in with Apple capability also has to be present in
  the **iOS provisioning profile** the build is signed with, which is a
  different fact from the capability being enabled on the App ID.
- **Adversarial cross-platform entitlement evidence.** iOS and macOS now write
  the *same* `ExternalScope`, so the scope half of `ApplySubscriptionSource`'s
  conflict guard no longer separates them. Before an iOS build reaches a
  customer, a **double-charge**, **early-grant**, **wrong-tier** and
  **cross-platform-conflict** case must each be exercised against the shared
  scope, and a purchase must be completed end to end against the live products
  from a signed build. A regression suite that passed before the migration
  passed while `unknown_bundle` was refusing every iOS purchase; it is not
  evidence about the path that is now open.

## Local Network access: a resolved functional prerequisite

**Status: declared in source; physical revalidation on iOS/iPadOS 26 is still
outstanding.** This is a functional and review-relevant prerequisite, and the
declaration exists — what remains is observing it work on a device. The camera
item below is now in the same posture rather than the blocking one it held
through `0.3.0 (5)`: both keys are declared and truthful in source, and both owe
physical prompt evidence on a candidate.

### What is declared, and why it is owed

`apps/ios/Relayium/Info.plist` declares `NSLocalNetworkUsageDescription`,
localized in the app bundle's own `en.lproj/InfoPlist.strings` and
`zh-Hans.lproj/InfoPlist.strings`. The English text in `Info.plist` is the
fallback and is identical to the English catalog.

The requirement covers both discovery and transfer:

- **Discovery is local and narrowly declared.** The iOS app browses and
  advertises exactly `_relayium._tcp` in the `local.` Bonjour domain. It does
  not scan SSIDs, enumerate addresses, probe subnets or enable peer-to-peer
  Wi-Fi. `NSBonjourServices` therefore contains exactly that one service, while
  the multicast and wifi-info entitlements remain absent.
- **Signaling and transfer are direct.** Browsing never opens a connection. The
  app may dial only a service endpoint returned by Bonjour, and only for
  addressed signaling to a discovered identity. The existing encrypted WebRTC
  lane then sends the selected file or message. iOS 14 and later gate these
  operations behind Local Network consent:
  <https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy>
- **What the advertisement contains.** A per-session random 128-bit channel
  identity, the device's display name, and the capability list this build
  speaks. No account, no durable installation handle, no key material and no
  user content. The identity is minted per discovery session rather than
  persisted, so the advertisement is not a stable device tracker.
- **What a refusal looks like.** `NWListener`/`NWBrowser` report a refused
  permission as `waiting` rather than as a failure, so the transport bounds its
  arming window and reports an expired window as a failure. The Nearby surface
  then shows its reconnecting state and retries on the existing backoff instead
  of displaying a search that cannot end. Account, plan and stored-link surfaces
  are unaffected.

### Why the omission was a silent failure rather than a smaller permission set

Retained physical runs `0af36138` and `56e78dbf` recorded both faces of the
previous state, in which the key was absent:

- on **iOS/iPadOS 26** the system withheld the permission prompt entirely and
  the local path simply never connected — no alert, no actionable error;
- on **iPadOS 18** the omission was masked and the same build appeared correct.

A build that passes on an older OS is therefore not evidence for this item.

### The copy, and the bound on it

The purpose string describes finding nearby Relayium devices and sending files
and messages directly to the device the user selected. It does not claim that
Relayium scans the network, and it uses no transport vocabulary
(`WebRTC`, `ICE`, `STUN`) in a sentence a person has to act on. If the copy is
revised, keep both bounds: an overclaiming purpose string is its own review
risk, and `IOSLocalNetworkPermissionTests` enforces the wording bounds,
the two-language coverage and the fallback match.

### Physical revalidation gate — outstanding

No automated test may accept a system privacy alert, and none does. The
following must be observed by hand on a **physical iOS/iPadOS 26 device**, on
the exact candidate, before that candidate is treated as functionally complete:

1. On a device that has not already granted this app Local Network access, the
   first eligible Nearby discovery start presents the
   Local Network prompt, and the alert renders the app's own sentence. Denying
   it must leave Nearby in its truthful reconnecting state rather than an
   endless search, and must leave sign-in, Account and stored links working.
   Reach that state by using a device where the permission has not yet been
   decided — **do not** uninstall or reinstall the app, clear its data, reset privacy
   settings, sign out, or change any device setting to force the prompt. If
   every available device has already decided the permission, record that and
   leave this item outstanding rather than mutating device or account state.
2. Allowing it completes a real file transfer and a real text transfer between
   two devices on the same network.
3. Denying it at that prompt degrades honestly rather than hanging: the user is
   told the transfer could not reach the device, and the app remains usable.
   Denial at the prompt is the observation this item requires; revoking the
   permission afterwards in *Settings ▸ Privacy & Security ▸ Local Network* is an
   optional extra check at the owner's discretion, not a prerequisite.
4. The prompt is presented in Simplified Chinese on a device set to that
   language, with the translated sentence.
5. The same build is re-checked on an iPadOS 18 device only as a
   non-regression; a pass there is not evidence for items 1–4.

Record the run tag and outcome here when it is done. Until then this record
claims the declaration is correct **in source only**.

### Review-facing answers

- The app requires Local Network access to discover Relayium devices and
  transfer to the selected device on the same network; it is requested when the
  foreground Nearby service first starts, not merely by launching the app.
- It advertises and browses only `_relayium._tcp`; it does not enumerate or
  probe arbitrary hosts.
- Refusing it does not disable the app's account and cloud surfaces. Sign-in,
  the Account and plan screens, and creating, uploading to and downloading from
  a stored link all run over ordinary HTTPS to Relayium's servers and never
  address the local network, so they are unaffected by a denial.
- **Not claimed here:** what the peer-to-peer surfaces do after a denial. Nearby,
  pairing-code cross-network transfer and Device Inbox all build the same
  realtime lane, so their behaviour depends on whether that lane can settle on a
  relayed candidate. `RealtimeConnectionFactory` does select
  `iceTransportPolicy = .relay` for a cross-network code room once TURN
  credentials are present, and a relayed pair would not need local-network
  access — but that fallback has **not** been observed after an actual denial.
  It is a separate observation owed by item 3 of the physical gate above, not an
  answer this record may give yet.

## Protected-resource declaration: resolved in source, validation outstanding

**Status: the declaration is implemented and truthful in source; it has not yet
been validated on a built candidate, and the physical prompt-scan evidence is
still owed.** This is no longer an open upload blocker of the class it was
through `0.3.0 (5)`, and it is not yet a closed item either.

Apple's protected-resource guidance is explicit that App Review rejects an app
whose *code* references a protected API without the matching purpose string,
and that an API reached through a third-party SDK counts as the app's own:
<https://developer.apple.com/documentation/uikit/requesting-access-to-protected-resources>

### What the blocker was

Through `0.3.0 (5)` the condition was a mismatch, and the mismatch pointed the
wrong way:

- `apps/ios/Relayium/Info.plist` declared **no** `NSCameraUsageDescription`;
- no product Swift source implemented a camera feature — the app used WebRTC
  **data channels only**, with no capture, no call and no QR scanner;
- the built app nevertheless embedded
  `Relayium.app/Frameworks/WebRTC.framework/WebRTC`, whose undefined-symbol
  table references the camera-capture classes `AVCaptureSession`,
  `AVCaptureDeviceInput`, `AVCaptureVideoDataOutput`,
  `AVCaptureDeviceDiscoverySession`, `AVCaptureVideoPreviewLayer` and
  `AVCaptureDeviceRotationCoordinator`, plus capture constants such as
  `AVCaptureDeviceTypeBuiltInWideAngleCamera`.

That is not a hypothetical: **`0.1.0` build 3 was rejected by exactly this check
for a missing `NSCameraUsageDescription`**, and build 4 replaced it.

The record named two honest resolutions and refused a third — adding a purpose
string for a feature that did not exist, which would have been a false statement
to Apple and to the user and would have contradicted the App Privacy answers.
Resolution 1 was **make the reference real**; resolution 2 was ship a
data-channel-only WebRTC binary.

### What was done: resolution 1

The product now has a camera feature, and the declaration follows it rather
than the other way round.

- `apps/ios/Relayium/PairingScannerView.swift` reads the pairing QR code the
  other device already displays — the same
  `https://relayium.com/cross-network#c=NNNNNN` link `transferPairingJoinURL`
  builds — and fills the six-digit Receive field with it.
- It is clean-room `AVFoundation`: an `AVCaptureMetadataOutput` restricted to
  `.qr`, an `AVCaptureDeviceInput` on the wide-angle camera and an
  `AVCaptureVideoPreviewLayer`. **Not `VisionKit`** — `DataScannerViewController`
  requires an A12, and this app's `IPHONEOS_DEPLOYMENT_TARGET` is 16.0. The
  oldest hardware that floor admits is the iPad (5th generation), an A9; the
  iPad (6th generation) and the iPad (7th generation) are A10. `VisionKit`
  would not fail to build on any of them — it would return
  `isSupported == false` at runtime, on the devices least able to type six
  digits quickly. The iPad (7th generation) is the oldest device in this
  project's own physical fleet, which is why the scan check below names it; it
  is **not** the platform floor, and lowering the argument to A10 would
  understate how much hardware `VisionKit` excludes.
- No photo output, no movie output, no sample-buffer delegate, no
  `AVAudioSession`, and no frame written to disk, logged, or sent anywhere.
  That is what lets the purpose string say nothing is recorded or saved.
- The camera is requested **after an explicit tap**. The app's single
  `AVCaptureDevice.requestAccess(for: .video)` sits inside
  `PairingScannerModel.begin()`, reached only from the scanner sheet, which only
  the "Scan a QR code" control on the Receive card presents. Nothing at launch
  and nothing on entering the tab touches the camera.
- **A scan fills a field; it never joins.** The payload goes through
  `PairingScanPolicy`, which is a funnel into the existing `parseAppDeepLink` —
  the same gate the Universal Link handler uses — and accepts only a validated
  `relayium.com` realtime link carrying a complete six-digit code. Download
  links, custom schemes, foreign hosts, userinfo, non-443 ports, malformed URLs,
  code-less links and junk are refused without changing what is already typed.
  A validated mode hint selects the segmented control the user can immediately
  change. There is no path from the scanner to `join`.
- Every refusal — denied, restricted, no camera, failed to start — keeps manual
  six-digit entry and paste usable, and says so in its own sentence. Only
  `denied` offers Settings, because it is the only one a person can change
  there.
- **The camera cannot outlive the sheet that asked for it.** Both asynchronous
  steps — the system permission alert and the capture-graph build — resume at a
  point where the screen may be gone, and neither can be cancelled from outside:
  `AVCaptureDevice.requestAccess` ignores the cancellation of the `.task` that
  started it. So each step carries the *activation* (`ScannerActivation`, a
  monotonic id taken in `begin()`) it started under and compares it against the
  mounted one before it may publish a phase, adopt the delegate, start capture or
  deliver a result. `end()` clears the mounted activation, which makes dismissal
  permanent for everything already in flight; `suspend()` records that the scene
  left the foreground rather than merely acting on it, so an answer that lands
  behind the app switcher cannot start the camera there; and every start is
  funnelled through one gate that re-proves all four preconditions. The metadata
  delegate stamps each decision, under the same lock that takes the one-shot
  latch, with the activation whose camera read the frame, so a code read
  microseconds before dismissal is dropped rather than filling the join field
  afterwards.
- **Proving a start and performing one happen at two different instants, and
  the proof is carried between them.** All four preconditions above are
  main-actor state, and `startRunning` blocks for long enough that it must not
  run on the main thread — so the gate proves them and then *enqueues* the start
  on a serial `sessionQueue`. `end()` and `suspend()` also run on the main actor,
  so both can land entirely inside that gap: the gate passes, the sheet goes
  away, and the block that was already queued starts a camera nothing is showing.
  The serial queue orders their `stopRunning` behind it, so the symptom is a
  camera that turns on off-screen and goes off again a whole `startRunning`
  later, not one that stays on — which is why every ordering assertion about the
  gate was true while the defect was live. `CaptureRunPermit` closes it:
  `startSession` stamps the permit with the exact activation *before* enqueueing,
  the queued block re-reads it under a lock one statement *before*
  `startRunning`, and `stopSession` — the single place any stop is scheduled, so
  dismissal, the app switcher and delivery all reach it — revokes the permit
  synchronously on the main actor *before* it schedules that stop. The
  comparison is against the exact activation rather than "some permit exists", so
  a reopened sheet's permit cannot authorize the previous sheet's queued start.
  The lock is held for one field access and never across `startRunning`, so the
  main thread is never blocked behind the camera.
- **Switching the camera off and being able to say so are also two different
  instants.** `stopRunning` blocks for the same reason `startRunning` does, so
  `stopSession` revokes the permit synchronously and then *enqueues* the stop —
  which means "capture stopped, then the caller was told" was, until this was
  corrected, only "a stop was scheduled, then the caller was told". The accepted
  result dismissed the sheet with the `stopRunning` still sitting in the queue
  behind whatever configure or start was already there, so the camera was
  switched off *during* the dismissal rather than before it. `stopSession` now
  takes a completion that is the last statement *inside* the queued block: it
  runs after the stop has been performed, or after the queue has observed the
  session was already stopped — the same fact about the camera, and one that must
  not swallow the result — and hops to the main actor from there. It is a hop and
  not a `sessionQueue.sync`, because waiting would block the main thread behind
  `stopRunning`. `handle` commits `hasDelivered` *before* that wait, so no second
  decision can begin a second delivery and no start can be scheduled underneath
  it, and the completion re-proves its activation before calling the caller —
  the hop costs a main-actor turn, and a Cancel or a swipe inside it would
  otherwise fill the join field from a sheet the user had already dismissed. The
  residual is the same bounded one named below: a `startRunning` already underway
  keeps the camera on until it returns, and FIFO puts this stop directly behind
  it, so the completion runs after the stop rather than after the start.
- **The one case this cannot cover**, stated rather than implied: if
  `startRunning` has already *begun* executing when the main actor revokes, the
  permit was read truthfully and AVFoundation offers no way to abort a start in
  progress. That window is bounded rather than open-ended, and the revoke order
  is what bounds it: a recheck that returned true proves the revoke had not
  landed, which proves the stop following it had not been enqueued, so FIFO puts
  that stop directly behind the start and the camera is off again as soon as
  `startRunning` returns. Closing even that would mean holding the lock across
  the blocking call and taking it on the main actor, trading a bounded window for
  a hang. The residual is inherent to a blocking, non-cancellable start;
  everything before the call is covered.

`NSCameraUsageDescription` is declared in `apps/ios/Relayium/Info.plist` as the
English fallback and localized in that bundle's `en.lproj/InfoPlist.strings` and
`zh-Hans.lproj/InfoPlist.strings`. It is declared in the **main app only**; the
Share extension declares none of it and carries no `InfoPlist.strings` and no
`.lproj` at its own bundle root, because it copies what the user shared into the
App Group and opens no camera — and iOS attributes an extension's prompt to the
host app. The extension does ship `en.lproj`/`zh-Hans.lproj` of
`Localizable.strings` inside its embedded
`RelayiumKit_RelayiumShareKit.bundle`; that is its own interface copy, in a
nested resource bundle iOS never reads a purpose string out of.

### What now enforces it

`IOSLocalNetworkPermissionTests.testNoCameraPurposeStringHasAppearedWhileThatBlockerIsStillOpen`
was written to be deleted by the batch that resolved this, and this is that
batch. It is replaced by:

- `IOSLocalNetworkPermissionTests.testTheCameraDeclarationIsTheAppsAloneAndTheExtensionStillDeclaresNothing`
  and `…testEachCatalogDeclaresExactlyTheDeclaredPurposeKeys`, which pin the
  declared key set and the app/extension boundary;
- `IOSPairingScannerTests`, which drives the link gate adversarially against
  every payload class a printed code can carry, and pins the single
  tap-gated request, the QR-metadata-only capture graph, the teardown on every
  exit, the copy bounds in both languages, and the absence of any path from a
  scan to a session.
- Two of those, `…testEveryStepThatResumesAfterAnAwaitProvesItStillOwnsTheMountedSheet`
  and `…testDismissalIsPermanentAndNothingStartsOrDeliversOutsideItsActivation`,
  are the lifecycle half. They are ORDERING assertions over the extracted body of
  each function rather than presence ones, because a guard that has drifted below
  the thing it gates reads exactly like a guard that works. Each was checked by
  mutation: deleting the post-`requestAccess` proof, moving it below what it
  gates, restoring the old `guard phase == .running` in `suspend()`, and removing
  the proof in `handle` each fail the suite with the sentence describing that
  defect.
- The enqueue-time/execution-time separation has three guards of its own, because
  ordering assertions alone cannot see the difference between a permit stamped
  with an activation and a boolean that says somebody may start:
  `…testTheQueuedStartIsStampedBeforeItIsEnqueuedAndReprovedBeforeItRuns` states
  the invariants as a predicate over the scanner's source;
  `…testRemovingTheExecutionTimeRecheckOrRevokingAfterTheStopIsScheduledFails`
  feeds that predicate four mutations of the real file — the recheck deleted, the
  recheck hoisted above `sessionQueue.async` where the gate already ran, the
  revoke moved inside the enqueued block, and the permit reduced to `granted !=
  nil` — and requires it to complain about each; and
  `…testTheRunPermitRefusesAStartInvalidatedBetweenItsEnqueueAndItsExecution`
  lifts `CaptureRunPermit` out of the iOS target (which this package cannot
  import), compiles it alone with `swiftc`, and drives the race itself against a
  suspended serial queue standing in for `sessionQueue`. Two of those mutations
  were additionally applied to `PairingScannerView.swift` itself and the suite
  failed with the sentence naming the defect.
- The stop side has the same pair, because the same class of claim was made about
  it: `…testTheAcceptedResultIsDeliveredOnlyAfterTheQueueHasStoppedTheSession`
  states, as a predicate over the source, that the hand-off is committed before
  the wait, that `onResult` is reached only from inside `stopSession`'s
  completion, that the completion is the queued block's last act (pinned by its
  indentation, since textual order cannot say what is nested inside the block),
  that the completion re-proves its activation, and that neither an
  already-stopped session nor a `sessionQueue.sync` is allowed to reappear.
  `…testDeliveringBeforeTheQueuedStopHasRunFails` feeds that predicate six
  mutations of the real file — the pre-fix `stopSession()` then `onResult(result)`
  two-liner, the announcement hoisted above the stop, the announcement lifted out
  of the queued block, the completion's activation re-proof deleted, the
  `guard session.isRunning else { return }` early return restored so an
  already-stopped session drops the result, and the queue hop traded for a
  blocking `sync` — and requires it to complain about each.

### Validation outstanding

Two things this record does **not** yet claim, and neither may be improvised at
upload time.

1. **Built-candidate symbol and declaration validation.** The unsigned local
   Release generic-device build of this batch (Xcode 26.6, `iphoneos26.5`,
   `CODE_SIGNING_ALLOWED=NO`, `BUILD SUCCEEDED`) was inspected for both its
   *declarations* and its *symbols*. Declarations: the built
   `Relayium.app/Info.plist` carries both purpose strings verbatim
   (`NSCameraUsageDescription`, `NSLocalNetworkUsageDescription`), the built
   `en.lproj` and `zh-Hans.lproj` `InfoPlist.strings` catalogs both reach the
   bundle carrying the exact localized camera sentence, and the built
   `RelayiumShare.appex` carries no `NSCameraUsageDescription`.

   **Corrected 2026-09-05.** This paragraph previously also claimed the built
   `RelayiumShare.appex` carried "no `*.lproj` directory at all". That was
   wrong, and the signed `0.3.1 (5)` archive and export are where it was caught:
   both copies of the appex carry
   `RelayiumKit_RelayiumShareKit.bundle/en.lproj` and
   `.../zh-Hans.lproj`, each holding `Localizable.strings`. The original
   observation was true of the appex *root* and was written as if it covered
   every depth. What the appex has never carried, and what the check now reads
   for directly, is an `InfoPlist.strings` at any depth or a `.lproj` at its own
   bundle root — read in the archive's copy of the extension and again in the
   export's, so the claim about *both* signed copies is one the script actually
   makes rather than one the operator carries over from a single read.

   Symbols: the readback **was** re-run for this batch, against
   `Build/Products/Release-iphoneos/Relayium.app`, with these results:

   ```sh
   xcrun nm -u "<Relayium.app>/Relayium" | grep -E 'AVCapture'                      # 8 symbols
   _AVCaptureDeviceTypeBuiltInWideAngleCamera
   _AVCaptureSessionPreset1280x720
   _OBJC_CLASS_$_AVCaptureDevice
   _OBJC_CLASS_$_AVCaptureDeviceInput
   _OBJC_CLASS_$_AVCaptureMetadataOutput
   _OBJC_CLASS_$_AVCaptureOutput
   _OBJC_CLASS_$_AVCaptureSession
   _OBJC_CLASS_$_AVCaptureVideoPreviewLayer

   xcrun nm -u "<Relayium.app>/Frameworks/WebRTC.framework/WebRTC" | grep -E 'AVCapture'   # 15 symbols
   ```

   That is the line this batch was meant to change: the app's **own** binary now
   references capture APIs directly — not only the embedded WebRTC framework —
   which is precisely why the declaration is owed rather than invented. The
   eight symbols are exactly the surface `PairingScannerView` uses: a session, a
   wide-angle device and its input, a metadata output, a preview layer and the
   720p preset.

   **This is an unsigned local build, not a signed release candidate.** The
   readback above therefore closes the source-and-local-build question only.
   Re-run both commands against the signed release candidate before upload and
   record that output here as well; a signing, thinning or bitcode-stripping
   step is exactly the kind of thing that can move a symbol table, so do not
   carry this result forward as if it were the candidate's.

   `scripts/ios-app-store-candidate.sh` re-runs both readbacks itself, against
   the exported IPA payload, and writes the symbol lists to
   `verify/avcapture-app.txt` and `verify/avcapture-webrtc.txt` with the counts
   in the manifest. Copy that run's output into this item when the candidate is
   built; until then this remains outstanding, because no candidate has been
   built.

2. **Physical prompt-and-scan evidence.** No automated test may accept a system
   privacy alert, and none does. On a physical device, on the exact candidate,
   observe and record:

   1. On a device that has not already decided camera access for this app,
      tapping "Scan a QR code" on the Receive card presents the camera prompt,
      and the alert renders the app's own sentence. Reach that state by using a
      device where the permission has not yet been decided — **do not**
      uninstall or reinstall the app, clear its data, reset privacy settings, or
      change any device setting to force the prompt. If every available device
      has already decided it, record that and leave this item outstanding rather
      than mutating device or account state.
   2. Allowing it, then pointing the camera at another device's pairing QR code,
      fills the six-digit field, applies the mode when the link carries one, and
      does **not** start a transfer. Pressing Join then completes a real
      transfer.
   3. Denying it at that prompt leaves the scanner sheet explaining the denial
      and the six-digit field typeable and joinable, with no hang and no
      dead control.
   4. The prompt is presented in Simplified Chinese on a device set to that
      language, with the translated sentence.
   5. On the iPad (7th generation) — the oldest device in this project's fleet,
      an A10 — the scanner opens and reads a code. That is the case `VisionKit`
      would have failed at runtime. It is the oldest hardware **available** to
      test on, not the oldest the iOS 16.0 floor supports: that is the iPad
      (5th generation), an A9, which this fleet does not have. Record this item
      against the A10 and leave the A9 as untested rather than implied.

   Record the run tag and outcome here when done. Until then this record claims
   the declaration is correct **in source and in an unsigned local build only**.

**Scope: this section is about the camera only.** The same framework also
references `AVAudioSession` symbols, but audio-session linkage alone does not
establish that `NSMicrophoneUsageDescription` is required — an app may
configure a session category without ever requesting record permission. That
observation is **not conclusive** and is deliberately excluded from the claim
above; the microphone key stays absent. If one is ever asserted to be owed,
establish it from Apple's own validation or review output, not from symbol
linkage, and re-author the feature first exactly as this section did.

**First-upload readback trigger.** The first candidate upload is the first
place this record can observe Apple's own verdict. Read that upload's
validation output and any App Review message *for this issue specifically*,
before triaging anything else, and record the exact wording here. A silent pass
is also a result worth recording — but it does not retire the requirement,
because this record has already failed the check once.

## App Store metadata and App Review information

This section is the maintained **draft source** for the external fields, and it
reports no current App Store Connect state. The 2026-09-03 read-back covered the
record's *gates* — version, builds, subscription catalogue, privacy,
accessibility, pricing, availability, screenshots and the notification endpoints
— and deliberately **not** these storefront strings: no name, subtitle,
promotional text, description, keyword list, What's New or URL was read back
from the record, so nothing in this section says what the record holds.
Reconcile every value against a live read-only inspection at submission time.

Apple's authoritative list of required and editable properties:
<https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties>

### Localization scope

Maintain exactly **English (primary) and Simplified Chinese**. That is the
shipped `CFBundleLocalizations` set and the workspace's supported-language
policy. Adding a storefront locale the app does not speak advertises support
that does not exist.

### The copy itself lives in `docs/app-store-metadata-ios.json`

This section used to be a table telling a future operator what to draft. It is
now a pointer, because the draft exists: **`docs/app-store-metadata-ios.json`**
is the copy-ready, machine-validated source for every external field, in both
locales, and it is what gets pasted into App Store Connect.

| What it carries | Fields |
| --- | --- |
| Storefront, per locale | name, subtitle, promotional text, description, keywords, What's New, support URL, marketing URL, privacy policy URL |
| App Review | the reviewer notes verbatim, plus the **names** of the owner-entered fields — never their values |
| TestFlight | beta app description and What to Test, per locale |
| Subscriptions | the group, the six product identifiers and their per-locale display names and descriptions, and the review requirements each one carries |
| Screenshots | the two required sets, their exact accepted sizes, the capture rules and the shot list, with the current captured count |
| Accessibility | the per-device-family Nutrition Label state and its checklist |
| Availability | the initially excluded territories and the ANSSI position |

Run `node scripts/ios-app-store-metadata-validate.mjs` to check it; the
candidate script runs the same command before it archives.

**The values that are pinned, and what they are pinned to.** The record's name
is `relayium`, and the packet enters exactly that, in both locales. An earlier
draft of this packet proposed the exact-case `Relayium` instead; that was
removed, because the App Store name is an owner-controlled field whose change
has its own review implications, and a metadata paste is not the place to
rename an app as a side effect. If the owner ever wants the capitalization
changed, that is their edit in App Store Connect and a separate decision — the
validator pins the lowercase spelling in both directions until then. The primary
category stays consistent with the bundle's `public.app-category.utilities`. The
version is **this record's** iOS version — `0.3.1`, which is what the record
was read back holding on 2026-09-05; a macOS version never sets it.

**The URLs, and the one that 404s.** The site builds `/support/` (English) and
`/zh/support/`, both of which exist in `web/public/`. Privacy is
`https://relayium.com/privacy/` — the exact URL Account opens
(`AppEnvironment.privacyWebURL`) — and Terms are `https://relayium.com/terms/`.

> **`https://relayium.com/apps/` is a 404 and must never be used as the
> marketing URL.** `web/public/apps/` contains only the `macos/` subtree; there
> is no English `index.html` under it, so the English page does not resolve.
> (`/zh/apps/` happens to exist, which makes the mistake worse: it looks fine in
> one locale and 404s in the other.) The marketing URL is
> `https://relayium.com/` — **the same value in both locales**, per the lease.
> The support URL stays localized, because Apple renders it per storefront and
> both `/support/` and `/zh/support/` exist. The validator refuses any `/apps/`
> URL anywhere in the packet, in any field, not only the marketing one.

**Cross-network Transfer is account-gated in exactly one direction, and the
blanket sentence is wrong.** `PairingCodeModel.mint(token:)` takes a bearer and
the server will not mint anonymously, because the account that mints a code owns
whatever is relayed through it. Joining a code somebody else is showing takes no
token at all. So:

- **LAN Transfer** needs no account, in either direction;
- **joining** a six-digit or scanned cross-network code works **signed out**;
- **showing** a cross-network code requires a **signed-in** account.

An earlier draft of the storefront copy said "LAN Transfer and Cross-network
Transfer do not [need an account]", which is true of one direction and false of
the other — and false in the direction a reader acts on, since somebody who
installs on that promise then cannot show a code. The English and Chinese
descriptions, the reviewer notes, the TestFlight beta description and What to
Test all state the two directions separately now, and the validator enforces it
from both sides: the blanket claim is refused, and so is deleting the accurate
sentence that would otherwise satisfy the ban by saying nothing.

**Honesty constraints on the copy.** Do not describe background receiving, push
notifications or automatic sync — the receiver is foreground-only and the app
registers for no notifications. Do not describe Relayium as a backup service.
Do not put prices in the description; the storefront renders the real StoreKit
prices, and a hard-coded one goes stale or wrong per storefront. The validator
enforces all four as vocabulary bans over the storefront copy, and separately
requires the reviewer-facing text to *state* the same limits rather than avoid
them.

**Apple's limits, as currently verified and enforced.** Name and subtitle 30
characters; promotional text 170; description and What's New 4000; keywords
**100 UTF-8 bytes** for the comma-separated string, with every individual
keyword longer than two characters; in-app purchase display name 2–30
characters and its description 45. The byte limit is the one that bites: a
Simplified Chinese keyword list is legal by every character count and rejected
by App Store Connect at roughly 34 characters, so it is counted in bytes.

### Age rating

Required before submission; answer the questionnaire truthfully rather than
defaulting every question to "none":
<https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/>

Relayium transports arbitrary user-supplied content between a user's own
devices and through user-shared links. Whether that constitutes user-generated
content for Apple's purposes is a real answer the owner must give, together
with the moderation reality — Relayium's server sees ciphertext and cannot
inspect content — not a convenient one.

### App Privacy

A privacy policy URL and complete data-practice answers are required:
<https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/>

**This section is the iOS half of an answer that is already published.** The
2026-09-03 read-back found the record's App Privacy **published**, with
`https://relayium.com/privacy/` saved as the Privacy Policy URL and the User
Privacy Choices URL blank. So this is no longer a form waiting to be filled.

Its job now is the opposite one: to keep a change to the iOS privacy manifest
visible as what it would be — a change to a **public promise about a released
app**, which requires re-answering the record's questionnaire rather than
editing a file here.

App Privacy is answered once per record, and this record carries two platforms,
so what a shopper reads is the **union** of what macOS declares and what iOS
declares: seven types, against the six in the iOS manifest below. The seventh is
`DeviceID` and it is macOS's alone. The two lists disagreeing is correct. The
failure mode is making them agree — adding `DeviceID` to the iOS manifest would
declare something iOS does not collect, and removing it from the record would
under-declare what the app as a whole collects.

If the questionnaire ever is re-answered, the App Store Connect wording and
category tree are its own; work from the graph below rather than from memory,
and reconcile the two rather than assuming they map one-to-one.

The answers must match the binary. The app's manifest
(`apps/ios/Relayium/PrivacyInfo.xcprivacy`) declares **tracking false, no
tracking domains, and exactly these six collected data types**:

| Type | Linked | Tracking | Purpose | What it actually is |
| --- | --- | --- | --- | --- |
| `Name` | yes | no | App Functionality | The create-account form's own name field (`AccountClient.register` → `display_name`), plus the name Apple supplies on a **first** Sign in with Apple authorization (`api/auth/apple/native`). |
| `EmailAddress` | yes | no | App Functionality | The address typed to register or sign in. Linked by definition — it *is* the account identifier. |
| `PurchaseHistory` | yes | no | App Functionality | StoreKit's signed transaction, retained as the account's subscription source, plan, status and renewal period. |
| `UserID` | yes | no | App Functionality | The per-account `appAccountToken` sent to Apple with a purchase. |
| `OtherUsageData` | yes | no | App Functionality | Metering — byte counts and timestamps only. Uploads, stored downloads, relayed bytes, and **the Device Inbox delivery this release adds**, which `deviceinbox_task.go` meters into `usage_monthly`. |
| `ProductInteraction` | **no** | no | **Analytics** | The identifier-free monthly activation aggregate. The one unlinked entry and the one Analytics purpose. |

The Share extension's manifest declares an **empty** collected-data list. That
is a claim in its own right rather than the absence of one: the appex holds only
the App Group entitlement, reaches no network, and transmits nothing.

Two things are worth stating plainly because they are the ones most likely to be
"corrected" into a false answer:

- **`Name` is not the device label.** On macOS the app sends
  `Host.current().localizedName`, the computer name, which macOS usually seeds
  from the owner's full name — so the macOS record counts it under `Name`. iOS
  resolves the same function to a hardware family: `AppEnvironment.deviceName()`
  answers `iPhone`, `iPad` or `iPod touch` and nothing else. A device family is
  not a name, and declaring it as one would describe a personal detail this build
  never sends.
- **`DeviceID` is absent, and the macOS record declares it.** Both macOS
  producers are unreachable here. There is no browser sign-in on iOS, so
  `install_id` is never posted. And although **this app does call
  `purchase-dispatch`** — so "iOS never reaches it" would be false — the
  `appInstanceId` field comes from a purchase *continuation*: only the
  `.durableContinuationRequired` policy creates one, `AppStoreDistribution`
  selects that policy on macOS, and `IOSAppleSubscriptions.makeModel` names no
  policy at all and so takes the default `.legacyOneShot`. With no continuation,
  `AccountClient.dispatchApplePurchase` omits the field entirely rather than
  sending it empty.

> **DeviceID revisit trigger.** If iOS adopts purchase continuation — or gains
> any browser sign-in path, or any other producer of a durable installation or
> instance identifier — then `NSPrivacyCollectedDataTypeDeviceID` becomes
> **required** in `apps/ios/Relayium/PrivacyInfo.xcprivacy`, in
> `docs/app-store-metadata-ios.json`, in `scripts/ios-app-store-candidate.sh`'s
> pinned graph, and in the App Store Connect answers. The absence is enforced
> from source by `IOSPrivacyManifestTests.testTheAppDeclaresNoDeviceIDBecauseNoIOSSourceSendsOne`,
> which fails the moment an iOS source file reaches either producer — so the
> trigger fires as a failing test rather than as something to remember.

Message and file bodies are end-to-end encrypted and decrypted only on the
device; the server sees ciphertext, which is why no file content or file
metadata type is declared. That absence is the product's central promise stated
where Apple publishes it, not an omission.

The same graph is stated in four places, deliberately and independently, so that
no single edit can move the public answer:

1. `apps/ios/Relayium/PrivacyInfo.xcprivacy` — what the app **ships**.
2. `IOSPrivacyManifestTests` — derives it from the iOS **send sites** and the
   **server storage** that retains each value, and pins `DeviceID`'s absence.
3. `scripts/ios-app-store-candidate.sh` — checks the **built** bundles, in the
   archive *and* the exported payload, for both the app and the extension.
4. `docs/app-store-metadata-ios.json` `appPrivacy` — the **draft answers** to
   type into App Store Connect. `scripts/ios-app-store-metadata-validate.mjs`
   checks that packet against its own pinned graph *and* against the shipped
   manifest, so a packet and a validator edited to agree with each other but not
   with the binary is a finding.

   That cross-check was strengthened on 2026-09-03. It used to read the manifest
   with a regular expression that collected the **ordered list of type names**,
   which is the one part of a collected-data entry that cannot change quietly:
   a flipped `NSPrivacyCollectedDataTypeLinked`, a purpose moved between
   Analytics and App Functionality, a second purpose, a repeated key, a fifth
   key, or `NSPrivacyTracking` turned on all produced the same list and left the
   gate green. The validator now **parses** both manifests — with a strict
   in-file reader of the plist XML subset Apple's manifests use, so there is no
   `plutil` dependency and the gate runs on any platform — and compares type,
   linked flag, tracking flag and ordered purposes entry by entry, plus the
   label-level tracking answer and its domains. Anything it cannot read exactly
   is a finding, never an empty reading.
   `scripts/test/ios-app-store-metadata-validate-test.mjs` proves each of those
   mutations red by building a throwaway repository under a temporary directory
   — a copy of the validator and of both manifests — so no case edits the
   product's own manifest, and a control case asserts the unmutated copy still
   passes.

If an App Privacy answer and the manifest ever disagree, one of them is wrong —
fix the disagreement, do not pick the easier form.

#### The privacy-policy and terms sources are prepared; neither deployed URL is verified

The policy at <https://relayium.com/privacy/> is the URL this record submits, and
App Review opens it while reviewing an **iOS** build. Guideline 5.1.1 requires the
linked policy to identify what the app collects, how, and every use it is put to.

Until 2026-09-03 the maintained English and Simplified-Chinese copy scoped in-app
purchase and all device-level data to "our macOS app". That wording had been a
deliberate 2026-08-30 correction — naming an iOS purchase channel nobody could
use was judged aspirational in a document that names data processors — but it is
**incomplete for the binary under review**, which is a submission-readiness
blocker rather than a stylistic preference. The maintained pair was therefore
rewritten on 2026-09-03 to describe both platforms, and the delivered source now
states, per platform and traced to the same call sites this record cites
elsewhere:

- **Purchase.** Apple in-app purchase is described as macOS *and* iOS app
  behaviour, alongside Stripe on the web. The `appAccountToken` round trip is
  named in both directions.
- **Device label.** macOS sends the **personal computer name** from Sharing
  settings; iOS sends only the **generic hardware family** (`iPhone`/`iPad`/
  `iPod touch`). The two are stated as different facts, not merged.
- **Installation identifier.** The 32 random keychain bytes and the
  browser-login continuation they exist for are stated as **macOS-only**, and iOS
  is stated to send **no installation identifier and no identifier read from the
  device** today — matching `DeviceID`'s deliberate absence from
  `apps/ios/Relayium/PrivacyInfo.xcprivacy`.
- **Camera.** iOS camera access is **local-only**, for reading a pairing QR code,
  and neither the image nor the code it carries is stored by the app or sent to
  us as camera data. macOS asks for no camera access; neither app has photo
  library access.
- **Push.** Neither app registers a push token or receives push notifications;
  macOS notifications are local and deliberately content-minimized.
- **Stored links.** Client-side AES-256-GCM encryption is claimed for the native
  apps as well as the browser and CLI, so the zero-knowledge promise is not
  understated on the platform under review.
- **Unchanged.** The account/metering truth, the identifier-free monthly
  aggregate wording, and the zero-knowledge content claims carry over verbatim.

Nothing in the rewrite states or implies the iOS app is published, downloadable
or on sale; it describes how each build behaves.
`web/scripts/pages/privacy-purchase-channels.test.mjs` was rewritten from its
blanket "no iOS" bans into exact per-platform positive and negative guards,
including a publication-claim ban, and the seven frozen locales remain pinned as
archived translations that must not be edited.

##### Terms of Service, corrected the same day and for the same reason

`https://relayium.com/terms/` is not a field in this record, but it is a public
legal document that describes the app under review, and its "Stored content"
clause said **"your browser encrypts files before upload"**. That was written
when a browser was the only client that could create a stored link. The CLI, the
macOS app and the iOS app now all create them, each encrypting locally with
AES-256-GCM before upload — so a term governing every stored transfer named one
client, and a reader on any other client was told the promise covered software
they were not running.

The maintained `en`/`zh` clause was rewritten on 2026-09-03 to state **where**
the encryption happens rather than **which program** performs it — "the files are
encrypted on your own device before they are uploaded" / "文件在上传前就已在你自己
的设备本机加密". It deliberately names no client, so it neither repeats the defect
pointed at a different platform nor implies an app is available anywhere it is
not. The seven frozen translations keep their original wording and their
2026-08-13 date under the 2026-08-14 language freeze;
`web/scripts/pages/content/legal/legal-text-positioning.test.mjs` pins both
halves, and `web/scripts/pages/build-pages.test.mjs` pins the per-locale sitemap
dates now that `terms/` has diverged the same way `privacy/` did.

##### What is still unresolved, and it is still a submission blocker

Only the *source* and the *generated* `en`/`zh` pages were prepared, for the
privacy policy and for the terms alike. Deployment is outside this task's
authorization, so:

- `https://relayium.com/privacy/` has **not** been redeployed and has **not** been
  read back, and until it is, the live URL a reviewer opens still serves the
  macOS-scoped text.
- `https://relayium.com/terms/` has **not** been redeployed and has **not** been
  read back either, so the live terms still tell every non-browser client that a
  browser encrypts their stored files.
- Do not submit while either is true. The verification is to deploy the web build
  and then fetch all four of `https://relayium.com/privacy/`,
  `https://relayium.com/zh/privacy/`, `https://relayium.com/terms/` and
  `https://relayium.com/zh/terms/`, confirming each shows `Last updated:
  2026-09-03`, that the privacy pages carry the per-platform section above, and
  that the terms pages carry the device-local stored-encryption clause.
- The frozen locales' public pages must come back byte-identical, for `terms/` as
  well as `privacy/`; the regenerated output was checked for that locally, but a
  deployment can still diverge.

### App Review information

Field reference:
<https://developer.apple.com/documentation/appstoreconnectapi/app-store-review-details>

Contact details and the demo login are **owner-only values that live nowhere in
this repository**. They are not placeholders to be filled in later and not
redacted strings: they are entered directly into App Store Connect, and the
packet records only the *names* of those fields, under
`appReview.ownerEnteredFields`. The validator refuses an entry that acquires a
value, and refuses an email address, a telephone number or a credential word
anywhere in the packet — so the failure mode where a demo password is pasted in
"temporarily" and survives in Git history is a rejected file rather than a leak.

| Field | Where it lives |
| --- | --- |
| Contact first name, last name, phone, email | App Store Connect only |
| Demo account username, password | App Store Connect only — a review-only account, created for review, never a personal one |
| Beta feedback email | App Store Connect only |
| Sign-in required | **Yes.** Account, subscriptions and Device Inbox are all account-gated. Recorded in the packet as `appReview.signInRequired`. |
| Notes | `appReview.notes` in the packet, verbatim and copy-ready |

The notes are drafted in the packet. They state, in plain language, and the
validator requires each of these to still be there:

- **A demo account is required**, and which surfaces it unlocks.
- **Device Inbox needs two devices signed in to the same account.** With one
  device a reviewer can enrol it and see the empty state, but cannot observe a
  delivery. Say this explicitly, or the surface reads as broken. A review-only
  attachment showing the two-device flow is **owed and not yet produced**
  (`appReview.attachment.state = "not-produced"`), so the notes say it must be
  supplied rather than that it is provided. The validator holds the two to each
  other in both directions: notes claiming an attachment that does not exist
  fail, and an attachment marked produced while the notes still say it is owed
  fails too. Update both in the same edit, and only once the attachment exists.
- **Receiving is foreground-only.** Relayium must be open on the receiving
  device; nothing arrives while it is backgrounded, and **no notification is
  delivered at any point**. This is shipped behavior, not a defect.
- **Receiving is off by default** and is an explicit per-account opt-in inside
  the app.
- Where received files land: *Files ▸ On My iPhone ▸ Relayium ▸ Received*.
- Subscriptions are sold through StoreKit and validated by Relayium's server; a
  Sandbox account is not charged.

### TestFlight test information

Distributing to external testers requires a beta app description and a beta
feedback email before the build can go out:
<https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information>

Both texts are drafted in `docs/app-store-metadata-ios.json`, per locale, under
`testFlight`.

- **Beta app description:** what this build is, plus the same foreground-only,
  no-notification and account-gated statements as above. A tester who does not
  know the receiver is foreground-only will file it as a bug, so the validator
  requires the English text to say "foreground" and "no notification" and the
  Chinese text to say 前台 and 通知.
- **What to Test:** the exact surfaces this build changes — Device Inbox across
  two devices, the foreground boundary observed rather than assumed, the
  five-destination shell on iPhone and on compact- and full-width iPad, the
  six-digit code and the QR scan, and the subscription screens. "Test the app"
  is not an acceptable handoff — the same rule the workspace applies to owner
  candidates.
- **Beta feedback email:** an owner-entered App Store Connect value. Not
  recorded here and not in the packet.

## Screenshots

Specifications and upload rules:

- <https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/>
- <https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots>

This record targets iPhone **and** iPad, so both sets are required. The
2026-09-03 read-back found the iOS version's **required iPhone and iPad
screenshot sets missing** — a reading of the required device sets, not a
separate per-localization read-back — matching the `not-captured` state the
metadata packet records. This is one of the two gates still blocking the iOS
version.

| Set | Accepted portrait sizes, pixels |
| --- | --- |
| iPhone 6.9" — the highest-resolution iPhone size | `1320 × 2868`, `1290 × 2796`, or `1260 × 2736` |
| iPad 13" | `2064 × 2752` or `2048 × 2732` |

Hard rules:

- **One to ten** screenshots per set, per localization.
- **No alpha channel.** Flatten before upload; an alpha channel is rejected.
- The pixel size must be exactly one of the accepted values above.

**Current state: no screenshot has been captured.** The packet records that as
`screenshots.state = "not-captured"` with `capturedCount: 0`;
`scripts/ios-app-store-metadata-validate.mjs` refuses a non-zero count while the
state says none exist, and `scripts/ios-app-store-screenshots-validate.mjs`
refuses to report any staged bundle as ready while it says that — see *The
staged bundle, and the check that accepts it* below. Two things block a capture,
and neither is a matter of finding time for it:

1. no `Release` build under the migrated `com.relayium.mac` identity has yet
   rendered the Account screen against the live products. The six subscription
   products do exist in App Store Connect and are Approved, so the offer list is
   reachable in principle — but only from a build signed as that identity, on a
   device or simulator where StoreKit resolves them. Until that has been seen,
   the Account shot has no honest source: the `UITestSubscriptions` fixture
   prices are forbidden, and so is a retouched screen;
2. no neutral demonstration data has been staged, and a public asset may carry
   none of the values listed below.

### Correction: a signed IPA on the physical fleet was never the requirement

This document previously said to **"capture only from a signed
release-candidate build — the same exact build that will be uploaded"**. That
was wrong, and it was wrong in a way that would have held the storefront hostage
to a signing session and a device fleet for no gain. Signing changes nothing a
camera can see. What a screenshot must be honest about is the **app's real
appearance and its real data**, and the configuration that decides both is
`Release` — not the signature, and not the hardware.

What is actually required:

- **A `Release` configuration build.** The UI-test fixtures in
  `apps/ios/Relayium/UITestSubscriptions.swift` are compiled `#if DEBUG` and
  invent display prices such as a fabricated monthly figure, so a Debug capture
  can put a price Apple never sold into a public storefront asset. **Never
  screenshot a `--relayium-ui-testing` launch**, and never retouch a real screen
  into one.
- **Real StoreKit products at real prices**, loaded from the authenticated
  Relayium catalog. That means the subscription products in the *Subscription
  activation boundary* section must exist first; a subscription screen showing
  an empty or fixture offer list is not shippable metadata.
- **Exactly one of the accepted pixel sizes above**, portrait, with no alpha.

What is **permitted** and used to be forbidden: an honest `Release`-configuration
**simulator** capture at one of those exact sizes.

Be precise about where that permission comes from. It is **this project's own
decision**, reached from what Apple's screenshot specifications actually
constrain — pixel dimensions, orientation, count and the absence of an alpha
channel — none of which mention how the image was produced. Apple does not
publish a rule saying "simulator captures are acceptable", and this document
does not quote one. The inference is that a simulator running the real Release
build against the real catalogue produces the same pixels the same build
produces on hardware, and that the accepted sizes are device sizes the simulator
offers directly. If Apple ever states otherwise, that statement wins and this
paragraph is what gets corrected.

Whether the owner captures on a simulator or on a device is therefore a **method
choice, not a compliance question**. The packet states this as
`screenshots.capture`, and the validator pins the parts that are not a choice:
`requiredConfiguration = "Release"`, `signedIpaRequired = false`,
`debugBuildsForbidden`, `uiTestFixturesForbidden`, `fabricatedPricesForbidden`
and `retouchingForbidden` all as stated. Turning any of them back on — including
restoring the signed-IPA requirement — fails the validator.

- **Stage neutral content rather than redacting afterwards.** Nothing sensitive
  or ephemeral may reach a public asset: the account email address, device
  names, pairing codes, share links or their `#k=` fragments, IP addresses,
  server hostnames, real file names, or any notification content.

Suggested shot list — each must show what the app really does, in both sets and
both localizations:

1. **Device Inbox** — a per-device conversation with both directions visible.
2. **Device Inbox, foreground-only** — the surface stating that limit, so the
   storefront tells the truth before install rather than after.
3. **Send** — choosing content for one of the account's own devices.
4. **LAN Transfer** — a local transfer in progress.
5. **Cross-network Transfer** — the encrypted cross-network path.
6. **Account** — sign-in state and the real subscription offers.

Keep the two asset channels separate:

- **Storefront screenshots** are public marketing assets, per localization, and
  everything above applies to them.
- **App Review attachments** are private to the review, optional, and never
  appear on the storefront. They are the right place to demonstrate a
  two-device Device Inbox delivery a single-device reviewer cannot reproduce.
  They do not satisfy the storefront requirement.

### The staged bundle, and the check that accepts it

Everything above is prose, and prose does not stop an upload. When the assets
exist they are staged as a **bundle** and checked by
`scripts/ios-app-store-screenshots-validate.mjs` before anything is dragged into
App Store Connect:

```
node scripts/ios-app-store-screenshots-validate.mjs --expect-blocked   # today
node scripts/ios-app-store-screenshots-validate.mjs --bundle <dir>     # once staged
```

The bundle is a directory holding a `manifest.json` and exactly two levels of
directories — `<set>/<localization>/<name>.png` — and nothing else:

```
manifest.json
iphone-6.9/en-US/01-device-inbox.png
iphone-6.9/zh-Hans/01-device-inbox.png
ipad-13/en-US/01-device-inbox.png
ipad-13/zh-Hans/01-device-inbox.png
```

Each `manifest.json` file entry carries the file's `sha256`, `bytes`,
`encoding`, `pixelSize`, the `shot` it stages quoted exactly from the packet's
`screenshots.shotList`, a `capture` block, and a `humanReview` block. The
validator derives the sets, the accepted pixel sizes, the localizations, the
one-to-ten per-cell counts, the capture rules and the shot list **from
`docs/app-store-metadata-ios.json`** rather than restating them, so the packet
stays the single place those facts live. It then reads the actual image bytes
and refuses:

- an alpha channel — PNG colour type 4 or 6, or a `tRNS` chunk — a failed chunk
  CRC, bytes after `IEND` or after `EOI`, a truncated stream, or a landscape
  frame;
- a file that is a header rather than an image. A PNG must carry consecutive
  `IDAT` chunks whose concatenated zlib stream inflates to exactly the scanlines
  its own `IHDR` describes, at a colour-type/bit-depth pair PNG defines, with a
  `PLTE` of at most 256 entries if it carries one at all and a `PLTE` it can
  index if it is a palette image; a JPEG must carry a real entropy-coded scan
  behind its frame header, stepped past stuffed `0xff00` pairs and restart
  markers to its `EOI`. `SOI`+`SOF`+`EOI`, or `IHDR`+`IEND`, is a
  plausible-looking file that renders nowhere, and it is refused. Adam7
  interlacing is refused too — this validator measures the non-interlaced
  scanline layout, and will not report a file as checked on a layout it did not
  check;
- a JPEG whose tables or component references do not resolve. `DQT` and `DHT`
  segments are parsed to the byte and must be consumed exactly, so an empty,
  truncated or malformed segment defines **no table** rather than counting as a
  marker that went past; a frame may not repeat a component id; and by scan time
  every quantization selector, and every DC/AC Huffman selector the scan can
  actually reach, must name a table something really defined, against a
  component the frame really declared, with no component selected twice.
  Progressive frames are handled on their own terms: a scan codes one spectral
  band, so it is required to resolve only the table that band uses. **This is a
  structural claim.** It proves the scan's references resolve — not that the
  entropy bytes behind them decode;
- a pixel size that is not exactly one of the accepted values for that set, and
  a manifest `pixelSize`, `sha256`, `bytes`, `encoding` or extension that
  disagrees with the file itself;
- a JPEG that is not 8-bit baseline or progressive greyscale/YCbCr;
- a missing, extra, empty or over-full set-localization cell, a shot staged
  twice in one cell, and a set whose ordered shot sequence differs between the
  two localizations;
- two byte-identical files anywhere in the bundle — across localizations that is
  a translation that was never actually performed;
- an unsafe path or file name, a symlink, and any file on disk the manifest does
  not list;
- a Debug configuration, a `--relayium-ui-testing` launch argument, an admitted
  UI-test fixture, fabricated price or retouch;
- the **Account** shot, while the packet records that the subscription products
  do not exist on the record. That check unblocks itself when the packet records
  real products;
- **any report that the current packet is ready.** While
  `screenshots.state` is `not-captured`, a structurally perfect bundle still
  exits non-zero. Staging files next to a packet that says none exist is not a
  way to turn the gate green.

**What it does not do is look at the picture.** It inflates a PNG's scanlines
and steps through a JPEG's entropy-coded bytes, but only to MEASURE them against
the header; nothing interprets, renders or reads what those pixels show. The
JPEG entropy data in particular is **stepped, never Huffman-decoded** — there is
no Huffman decoder, no dequantization and no IDCT in this validator, so a file
whose structure and references are all sound can still hold entropy data that
decodes to nothing. Structural integrity is the claim; decodability is not. There
is no OCR, no text extraction, no image model and no automatic privacy
inspection in it, and none is planned — a passing OCR run would be more
dangerous than an absent one, because it would read as "checked" while missing
rotated, truncated or low-contrast text. So the two rules that matter most on a
public asset are handled the only way they honestly can be: for **each file**, a
named human records in `humanReview` that they looked at that frame and
confirmed it carries no sensitive value from the list above
(`neutralContentConfirmed`) and shows the app's real appearance and data,
unretouched (`truthfulUnretouchedConfirmed`).
`humanReview.method` must be exactly `human-visual`; `ocr`, `automated`,
`script`, `model` and similar values are named and refused. A passing run means
the bundle is structurally uploadable and somebody has put their name to the
rest — **not** that the screenshots are clean.

`docs/app-store-metadata-ios.json` needs no new field for any of this and gains
none: every rule is derived from the `screenshots` section it already carries.

Until the assets exist, `--expect-blocked` is the runnable form. It **asserts**
the blocked state rather than skipping it: it exits zero only while the packet
records `not-captured`, a zero captured count, at least one recorded blocker,
and a `screenshots` observed field that still reads as an unmet blocking gate.
With no arguments at all the validator exits non-zero, because "nothing staged"
is a failing state rather than a passing one.
`scripts/test/ios-app-store-screenshots-validate-test.mjs` proves each rule by
mutation over synthetic fixtures built in a temporary directory: real deflated
PNG scanlines and real Huffman-coded baseline JPEGs, each mutated in exactly one
way, and each mutation checked to actually turn its case red. Two structurally
progressive fixtures are the labelled exception — a `SOF2` frame over sequential
entropy bytes — because the progressive table rule is about which references a
scan must resolve, not about decoding it. They are flat block patterns depicting
nothing, and no storefront asset exists in this repository.

## Accessibility Nutrition Label

Apple's Accessibility Nutrition Label is a **per-device-family claim** about
accessibility features a user can rely on to complete the app's common tasks. It
is not a description of what the framework provides for free, and it is not a
statement of intent: claiming a feature the app does not actually support is a
false public statement of exactly the kind this record exists to prevent.

**Current state: `unassessed`, and nothing is claimable.** Every feature on
both iPhone and iPad is recorded in
`docs/app-store-metadata-ios.json` as `claimed: false`,
`assessment: "not-assessed"`, and the validator refuses any packet that claims
one while the label state is `unassessed`. The Accessibility Nutrition Label on
the **target** record was **not** read back on 2026-09-03; the earlier *Not
Started* reading was of the superseded record and does not transfer. That makes
it an unread field rather than an observed one. Nothing is claimable either way,
for the local reason below, and the label is voluntary — so this is not a
submission blocker, and it is also not something to answer from a guess to make
the page look finished.

### The known blocker

**No measured contrast shortfall remains.** Both recorded blockers are closed,
and what still blocks the label is the assessment rather than a defect.

**The dark `.bordered` button label at approximately 2:1** was fixed against a
semantic `ActionLabel` role and re-measured on real screenshots at **4.91:1 to
7.36:1**.

**Light supporting text at 3.29–3.44:1** — iOS's own `secondaryLabel`, which
carried roughly a hundred and twenty sentences across the app and the Share
extension — was replaced with a semantic `SupportingLabel` role. The values and
the surfaces they were computed against:

| appearance | value | systemBackground | card `#F2F2F7` | deepest quaternary composite |
| --- | --- | --- | --- | --- |
| Light | `#66666C` | 5.70:1 | 5.11:1 | **4.61:1** |
| Light + Increase Contrast | `#4A4A50` | 8.80:1 | 7.89:1 | 7.11:1 |
| Dark | `#98989F` | 7.33:1 | 5.94:1 | **5.16:1** |
| Dark + Increase Contrast | `#C6C6CE` | 12.37:1 | 10.02:1 | 8.71:1 |

The same audit exposed a second, smaller failure that a green primary-flow gate
would have concealed: the composer's over-limit byte counter and the transcript's
*not sent* label were `Color.orange`, **2.20:1** on white — the least readable
text in the product. Both now use a semantic `WarningLabel` role at **4.98:1 to
6.16:1** in Light and **7.16:1 to 10.22:1** in Dark, with the
`exclamationmark.triangle.fill` symbols beside them taking the same role so one
warning is not drawn in two oranges. The redundant symbol is preserved; it was
never a substitute for a legible sentence.

Both roles declare **explicit Increase Contrast variants**, which is the part a
named asset silently loses — `Color.secondary` tracked that setting for free, and
a catalog that declared only Light and Dark would have made the accessibility
setting a no-op on every sentence in the app. The compiled `Assets.car` in both
the app and the Share extension was inspected and carries all four appearances
(`UIAppearanceDark`, `UIAppearanceHighContrastAny`, `UIAppearanceHighContrastDark`)
for both roles.

The arithmetic is recomputed from the asset catalog on every run by
`apps/RelayiumKit/Tests/RelayiumKitTests/IOSSupportingTextGuardTests.swift`
rather than quoted, and `apps/ios/RelayiumUITests/AppShellUITests.swift` now
passes the system contrast audit in **both** Light and Dark with **no
unclassified finding** and no open-blocker exception list.

**Sufficient Contrast is still not claimable on either device family**, and the
packet still carries a blocker on the feature row itself so deleting it fails the
validator. The reason has changed rather than disappeared: Apple evaluates this
label **per device family across every common task**, that exercise has not been
performed on real iPhone or iPad hardware, and an automated audit on one
simulator layout is not a substitute for it. This record does not pretend
otherwise.

### Why nothing else is claimable either

There is no longer a *measured* blocker anywhere in this section, and that makes
every feature unclaimable for the same single reason: the common tasks have not
been run with the feature switched on, per device family. A feature that has not
been exercised is `not-assessed`, not "probably fine" — and a resolved contrast
measurement is evidence about a colour, not about a task somebody completed.

The checklist each feature has to pass, on each of iPhone and iPad, is
`accessibilityNutritionLabel.checklistPerDeviceFamily` in the packet:

1. sign in and reach the Account screen;
2. switch Device Inbox receiving on for the account;
3. send a file to one of the account's own devices;
4. open a received item and reach it in the Files app;
5. start and complete a LAN Transfer;
6. join a Cross-network Transfer by typing the six-digit code, signed out;
7. signed in, show a cross-network pairing code and read the six digits back;
8. open the QR scanner and reach a refusal state without becoming stuck;
9. reach Manage Subscription, Privacy Policy and Terms from Account.

Record the result per feature, per device family, when the runs happen.
Reconcile the feature list against App Store Connect's own questionnaire at
submission time rather than trusting this repository's copy of it: the packet's
list is a draft of Apple's, not Apple's.

## France availability and the ANSSI encryption declaration

**Correction, 2026-09-03.** This document previously said in two places that
"France availability is owner-confirmed", and drew the ANSSI declaration as a
gate on the first upload. Both statements were wrong, and they were wrong in
the expensive direction: they described an unstarted regulatory workflow as an
unconditional blocker on a release that does not include France at all.

What the owner actually decided:

- **France is excluded from initial availability**, together with **China
  mainland**. Neither is in the territory set the first release ships to.
- The ANSSI declaration is therefore a **precondition for ADDING France later**,
  not a condition on the initial release. It blocks a territory change; it does
  not block this submission.
- Nothing here is a judgement that the declaration is optional. Relayium
  implements industry-standard encryption outside Apple's operating system, so
  France cannot be added until the declaration workflow has been completed
  truthfully. It simply is not owed yet.

`docs/app-store-metadata-ios.json` carries the same two facts machine-readably
(`availability.initialExcludedTerritories`, and
`availability.anssiDeclaration.blocksInitialRelease = false` with
`blocksAddingFrance = true`), and
`scripts/ios-app-store-metadata-validate.mjs` refuses a packet that quietly
returns France to the initial release or turns ANSSI back into a launch blocker.
Territory selection itself is an owner action in App Store Connect; no value in
this repository performs it. The 2026-09-03 read-back found the app **available
in 173 of 175 territories, with China mainland and France excluded** — so the
exclusions above are now a live setting to preserve rather than a decision to
enter. It is a record-level setting shared with the released macOS app: adding
France would add it for macOS too, and still requires a truthful ANSSI
declaration first.

The part of the declaration that reaches this repository is the outcome. If the approved
declaration comes with an Apple compliance code, that code belongs in
`apps/ios/Relayium/Info.plist` — and in `apps/ios/RelayiumShare/Info.plist` if
it applies to the extension — alongside `ITSAppUsesNonExemptEncryption`, as
`ITSEncryptionExportComplianceCode`.

Those plists are guarded on purpose.
`IOSDistributionSigningTests.testNeitherBundleDeclaresExportCompliance`
(`apps/RelayiumKit/Tests/RelayiumKitTests/IOSDistributionSigningTests.swift`)
asserts that **neither** bundle declares `ITSAppUsesNonExemptEncryption`, so
that a legal statement is made once per upload by a human in App Store Connect
instead of silently by a build setting. Adding the key will fail that test —
by design, not by accident.

Handoff, only once the owner holds an approved declaration **and has decided
to add France**:

1. It is a **separately leased batch**. Plist, entitlement and Xcode project
   paths are not writable under the current Device Inbox lease.
2. That batch changes both sides in one delivery: the plist keys **and** the
   guard. Its replacement must assert the exact approved values, not merely
   drop the assertion.
3. Record the approval reference and the resulting keys here.
4. Do not answer the export-compliance question "No" to clear the form, and do
   not assume the macOS record's declaration transfers to this separate iOS
   record — confirm that in App Store Connect first.

## TestFlight acceptance

No candidate has been built yet. `0.3.1 (5)` is the prepared candidate version
in source, and promoting it to an actual candidate requires the outstanding App
Store Connect read-back above — the build-number question the 2026-09-03
inspection did not answer — plus a new exact-source archive and checksum — which
is what `scripts/ios-app-store-candidate.sh` produces, and which running that
script does **not** by itself authorize uploading. The record's iOS version
already reads `0.3.1`, so a build can be selected on it once one exists. Upload
only the exact candidate whose hosted Go, Swift, iOS Release build and UI gates
are green. Every hosted iOS job
selects exactly Xcode major 26 with an iphoneos SDK of at least 26 before it
compiles anything, fails closed when no such toolchain is installed, and prints
the selected versions into its own log. That keeps the runner image's default
Xcode 16.4 and any unvalidated newer preview out of the builds this checklist
depends on. It covers the toolchain only: it signs, archives and uploads
nothing, so the outstanding App Store Connect read-back above, an exact-source
archive and TestFlight build availability remain separate gates a green iOS lane
does not satisfy.

**France is not part of initial availability**, so no ANSSI declaration is owed
by this candidate. See *France availability and the ANSSI encryption
declaration* above: the declaration becomes a precondition when the owner
decides to add France, and adding France without it is what is forbidden — not
shipping without France. The export-compliance question in App Store Connect
must still be answered truthfully for this upload, and must not be answered
"No" merely to clear the form.

Internal TestFlight acceptance must cover:

- **upgrade from `0.1.0` to `0.3.1`, on a device that already has `0.1.0`
  installed**, as well as a clean install. This is a candidate acceptance gate
  and not an optional extra: build 4 of `0.1.0` was uploaded to this record, so
  a real installed base for it can exist, and everything `0.3.1` adds sits on
  top of state `0.1.0` wrote. Observe, on the upgraded install rather than on a
  fresh one:
  - the app launches, and the existing signed-in session survives — an upgrade
    that silently signs the user out is a defect, not a migration;
  - anything `0.1.0` left in `Documents/Received` is still present and still
    reachable in the Files app;
  - Device Inbox enrolment starts from its off-by-default state on a device
    that predates the feature, rather than switching itself on;
  - the five-destination shell replaces the old one without a stale tab, and a
    stored link still opens over whichever surface the user was on.
  A clean install is the easier case and passing it says nothing about the
  upgrade; run both and record them separately;
  The upgrade under test is `com.relayium.mac` over `com.relayium.mac` — the
  TestFlight lineage build 4 belongs to — which is why the signed-in session is
  expected to survive: the bundle id is unchanged, so the app's implicit default
  keychain access group is unchanged. A locally installed development build of
  the retired `com.relayium.app` is a **different app** and not this test: it is
  not replaced by the TestFlight install, its keychain items live in a different
  access group, and nothing in `0.3.1` migrates or reads them. Signing in again
  after installing over that build is correct behaviour, not the defect above;
- sign in and display of all six localized StoreKit offers;
- one Sandbox purchase and immediate Relayium plan refresh;
- restore after sign-out/sign-in or reinstall;
- renewal, expiry/refund and notification convergence;
- Manage Subscription, Privacy Policy and Terms destinations;
- the same-account cross-app guard, proving a live macOS Apple subscription
  cannot start an iOS purchase and vice versa;
- Share extension handoff, Universal Links and the primary text/file workflows
  on a real device;
- **Local Network access, on a physical iOS/iPadOS 26 device**: the five checks
  under *Local Network access* above, run on a device that has not already
  granted this app Local Network access — without uninstalling, clearing app
  data, resetting privacy settings or signing out to force the prompt. An
  iPadOS 18 pass does not satisfy this item — that OS masked the omission the
  declaration fixes;
- **Device Inbox, on two real devices signed in to one account**: turning
  receiving on, receiving a file and a message from the other device, the
  per-device conversation showing both directions, and sending a file and a
  message back from that conversation. Verify the received bytes appear under
  *Relayium ▸ Received* in the Files app, and compare a digest against the
  sender's. `scripts/ios-device-inbox-acceptance.sh` covers **one direction of
  this item and no more**: one run is one delivery, sender to receiver, and the
  digest it compares is read out of the receiving device's app container with
  `devicectl device copy from` rather than seen in the Files app. The reverse
  direction is a second run started deliberately with the roles exchanged, and
  the Files app appearance is an operator observation the harness cannot make;
- **the foreground-only boundary, observed rather than assumed**: send to a
  device whose Relayium is closed, confirm nothing arrives, then open the app and
  confirm it does. Confirm no notification is delivered at any point;
- **local history deletion is not a recall**: delete a conversation entry while a
  delivery to that device is still running, and confirm the delivery completes on
  the receiver while the row stays gone on the sender after relaunch;
- **the adaptive shell**: five tabs on iPhone and on a compact-width iPad
  (Slide Over and a narrow Split View), the sidebar and detail column at full
  width, and the same five destinations in both — plus a stored link opening over
  the surface the user was on and returning to it when dismissed.

Two of the items above have physical harnesses, and each covers part of its
item rather than all of it. Run the harness where one exists rather than
improvising an equivalent by hand, and record the rest as operator observation
against the same run tag:

| Harness | Covers | Does **not** cover | Evidence root |
| --- | --- | --- | --- |
| `scripts/ios-device-pair-acceptance.sh` | the Nearby and pairing-code file and text transfers, in both directions (each flow is re-run with the roles exchanged), the two independently derived short-authentication strings compared equal, and the received bytes hashed against a constant this script holds — once live and once after the receipt is dismissed | the pairing code's expiry, join link or QR handoff; a second batch on one link; a file sent from inside a live Nearby workspace; a legacy `0.1.0` peer | `.relayium-device-pair/<run-tag>/` |
| `scripts/ios-device-inbox-acceptance.sh` | ONE Device Inbox delivery, sender to receiver: a run-unique message and a deterministic file asserted on both surfaces, and the receiving device's container bytes hashed against a digest this script holds | the reverse direction; background or closed-app receipt; Files app visibility; delivery to an offline device that returns; a Web, macOS or CLI sender | `.relayium-device-inbox/<run-tag>/` |

The three items with **no** harness at all stay operator evidence, and no run
of either script above may be cited for them:

- the **foreground-only boundary**. The inbox harness deliberately keeps the
  receiving app on screen for the whole run, so it establishes nothing about a
  closed app either way;
- **local history deletion is not a recall**. Nothing in either script deletes
  a conversation entry mid-delivery;
- **the adaptive shell** on real hardware. Its regular-width half is executed
  on a hosted iPad simulator by `ios.yml`'s `ios-ipad-shell` job, which is
  simulator evidence for the layout and not device evidence for the item.

Both harnesses keep their run directory whatever the outcome, because a pass is
evidence too. Each run therefore leaves build and per-device logs, `.xcresult` bundles
and a DerivedData tree, and the roots reach multiple gigabytes. They are
intentional local physical evidence, are ignored at the repository root by
`.gitignore`, and must not be committed or cleaned as though they were build
scratch. Cite the exact run tag when reporting a physical result.

Sandbox purchases do not charge real money. Do not add the build to App Review
or public release until the owner has accepted these results. Public release
must remain a separate explicit decision.
