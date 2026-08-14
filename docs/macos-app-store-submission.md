# macOS App Store submission

This is the release operator's source of truth for Relayium's Mac App Store
record. It intentionally separates facts that are already fixed in code or App
Store Connect from declarations that still require the owner, legal review, or
an authenticated Apple session.

Nothing in this document authorizes enabling sales, adding an item for review,
or releasing a version. Relayium uses manual App Store release.

## App record

| Field | Value |
| --- | --- |
| App name | Relayium for Mac |
| Apple ID | `6801142976` |
| Platforms | macOS only |
| Bundle ID | `com.relayium.mac` |
| SKU | `relayium-macos` |
| Version | `1.2.0` |
| Release method | Manual |
| Primary category | Utilities |
| Secondary category | Productivity |
| Subtitle | End-to-end encrypted transfer |
| Support URL | `https://relayium.com/support/` |
| Marketing URL | `https://relayium.com/` |

Version `1.2.0`, build `6` was uploaded and export-compliance cleared
(2026-08-14), so build `6` is consumed and must not be rebuilt or re-uploaded.
Public commit `cab50d9e88378318228b8467be3aaafef83cdda9` carries public version
`1.2.0` at build `7`, the corrected replacement for the same version. Build `7`
was uploaded on 2026-08-14 and is **also consumed**: it must not be rebuilt or
re-uploaded either. Any further archive of version `1.2.0` needs a strictly
higher build number.

Version `1.1.3`, build `5` is **already public** as a direct download: those
exact Developer ID-signed bytes are behind the `macos-v1.1.3` tag and are offered
by the Sparkle feed. Because the project shares its version and build settings
across the direct-download and App Store targets, an App Store archive built at
`1.1.3` build `5` would be different bytes under a public version and a consumed
build number. **Any archive or export already produced at `1.1.3` build `5` must
not be uploaded — delete it.** Builds `5`, `6` and `7` are all consumed, so a
new archive of this version needs a strictly higher build number. Apple
subscriptions are a new user-visible capability, which is why the public version
moves by a minor step rather than a patch.

Every replacement upload after this one must use a strictly higher build number
again; an upload consumes its number even if it is only used in TestFlight or is
later rejected.

Nothing here changes an already-published artifact. `web/native-releases.json`,
`web/public/apps/macos/appcast.xml`, the `macos-v1.1.3` tag and the GitHub
Release stay exactly as they are; they describe bytes that shipped, and they move
only when a new direct-download release is actually published.

## Subscription group and products

The subscription group is **Relayium macOS Plans**, App Store Connect ID
`22307427`. Monthly and yearly products for the same tier belong at the same
subscription level; changing billing period within a tier must not look like a
plan upgrade or downgrade.

| Level | Product | Product ID | USD price | English display name | English description |
| ---: | --- | --- | ---: | --- | --- |
| 1 | Max monthly | `com.relayium.mac.max.monthly` | $9.90 | Relayium Max Monthly | Relayium Max plan, billed monthly. |
| 1 | Max yearly | `com.relayium.mac.max.yearly` | $99.00 | Relayium Max Yearly | Relayium Max plan, billed yearly. |
| 2 | Pro monthly | `com.relayium.mac.pro.monthly` | $4.99 | Relayium Pro Monthly | Relayium Pro plan, billed monthly. |
| 2 | Pro yearly | `com.relayium.mac.pro.yearly` | $49.90 | Relayium Pro Yearly | Relayium Pro plan, billed yearly. |
| 3 | Plus monthly | `com.relayium.mac.plus.monthly` | $1.99 | Relayium Plus Monthly | Relayium Plus plan, billed monthly. |
| 3 | Plus yearly | `com.relayium.mac.plus.yearly` | $19.90 | Relayium Plus Yearly | Relayium Plus plan, billed yearly. |

Use **Relayium** as the English subscription-group display name. The product
IDs above are API contracts: they must exactly match the active rows in the
server's `apple_products` catalog before a TestFlight purchase is attempted.

Storefront availability was set deliberately and verified on 2026-08-14: the
App Store app record and all six subscriptions each select **173 of 175**
territories. France and China mainland are excluded; Hong Kong, Taiwan, and
Macau are retained. Excluding France is what keeps the French encryption
declaration off the critical path — see the export-compliance note below.
Re-adding either excluded territory is an owner decision with its own
regulatory work, not a form-passing convenience.

As of 2026-08-14 the subscription group and all six products read **Prepare for
Submission**, and each offers **Add for Review**. Nothing here authorizes
pressing it.

App Store Connect was checked on 2026-08-13: the Paid Apps Agreement, bank
account, and required U.S. tax forms all report **Active**. Keep those statuses
green through submission; this document deliberately records no personal,
banking, or tax identifiers.

Apple says product metadata changes can take up to one hour to reach the
Sandbox environment. Set the intended storefront availability and finish the
catalog/verifier activation before treating an immediate empty StoreKit result
as an app defect.

## Version metadata

Promotional text:

> Files and text between your devices, end-to-end encrypted. On your own
> network they go direct; across networks the relay carries ciphertext it
> cannot read.

Keywords:

`file transfer,send files,encrypted,end-to-end,e2ee,p2p,share,privacy,secure,lan,wi-fi,link,inbox`

App Privacy is saved as an unpublished draft in App Store Connect. It declares
Name, Email Address, User ID, Device ID, Purchase History, and Other Usage Data;
each is used only for App Functionality, linked to the user's identity, and not
used for tracking. The Privacy Policy URL is `https://relayium.com/privacy/`.
Do not publish the disclosure until the release candidate and final metadata are
ready for submission.

The age-rating questionnaire is saved with Messaging and Chat enabled and all
other content/capability-frequency answers set to none/false. App Store Connect
calculates a global `4+` rating with its normal regional equivalents; the app is
not marked Made for Kids and no higher-rating override is applied.

The full description and What's New text still need owner approval. They must
not imply that the relay can read user content, that every transfer is peer to
peer, or that a web/Stripe subscription is managed by Apple.

## TestFlight state and information draft

**Build `1.2.0 (7)` — processed, compliance-answered, and installed
internally.** Xcode successfully uploaded build `7` to App Store Connect at
2026-08-14 09:57 Asia/Dubai. Processing has since **finished**, its
export-compliance question has been answered, and App Store Connect now reports
build `7` as **Ready to Submit**.

Before that upload, the single retained `1.2.0 (7)` archive passed local
inspection of its version, signature, entitlements, universal architecture,
StoreKit configuration, privacy manifest, and absence of Sparkle. The
exact-source Swift/package tests and the signed macOS CI gate passed for the
same commit.

Export compliance for build `7` was answered on the same facts as build `6`:
the app uses standard, non-exempt encryption, and distribution excludes France,
so no French declaration was required and none was faked.

Build `7` was **manually added** to the internal group **Relayium Internal**.

The following have **not** happened for build `7` and must not be assumed:

- It is in **no external group**. Build `7` is deliberately absent from
  **Relayium External Beta**: App Store Connect currently permits only one
  build of version `1.2.0` in Beta App Review, and build `1.2.0 (6)` is still
  **Waiting for Review** there. Do **not** remove build `6` to make room for
  build `7`.
- No Beta App Review submission has been made for build `7`.
- No public release has occurred.

Verified 2026-08-14: build `1.2.0 (6)` is uploaded, its export compliance is
**cleared**, and it is attached to **both** the internal group **Relayium
Internal** and the external group **Relayium External Beta**.
Compliance cleared truthfully through the questionnaire's non-France answer —
the app does use non-exempt encryption, and France is not a selected territory,
so no French declaration was required and none was faked.

**Relayium Internal**, from a fresh readback on 2026-08-14, reads **one tester**
and **two builds**: build `1.2.0 (6)` and build `1.2.0 (7)` both read
**Testing**. The group still uses **Manual** distribution (**Manual for Xcode
Builds**) — adding build `7` did not switch it to automatic. The tester has
**installed build `7`**. No address, personal name, or invitation value belongs
in this document or anywhere else in the repository.

Internal readiness is not external readiness. A build that internal testers can
install says nothing about whether the external group is approved. Nothing
above reports external approval: none has been granted.

**Relayium External Beta**, verified 2026-08-14, reads **zero testers** and
**one build** — build `1.2.0 (6)`. Its public invitation link is **enabled** and
its capacity reads **0 of 3**. The link value and any tester email addresses are
deliberately absent from this document and must never be written into the
repository.

The link still **cannot accept joiners**. That is correct, not a defect:
**Beta App Review** is **Waiting for Review**, and an external build only
becomes installable once that review passes. It has not passed.

Because Relayium requires sign-in, external distribution makes the Beta App
Review information mandatory. The owner has confirmed that a separate Relayium
review account for Apple's reviewers now exists. Its credentials and the review
contact details are entered and maintained only in App Store Connect for the
Apple review workflow: never commit review credentials, contact details, or
account identifiers to this repository.

Beta description:

> Relayium transfers files and text between your devices. Same-network
> transfers connect directly when available; cross-network transfers use an
> end-to-end encrypted relay. This beta adds Mac App Store subscriptions and
> Apple-managed purchase restoration.

What to test:

> Sign in with the supplied Relayium test account. Open Account, confirm that
> Plus, Pro, and Max monthly/yearly offers show Apple's localized prices, then
> purchase one Sandbox subscription. Confirm the account plan refreshes after
> purchase. Use Restore Purchases and confirm the entitlement returns. Verify
> that Manage Subscription opens Apple's subscription management and that the
> Privacy Policy and Terms links open from the purchase surface. Also send a
> short text and a small file between two signed-in devices.

The feedback email, review contact, and review sign-in are maintained directly
in App Store Connect. Never commit review credentials to this repository.

### Observed in the installed TestFlight build `1.2.0 (7)`

Checked directly in the installed build on 2026-08-14, on the account
subscription surface:

- All **six** mapped products render. Apple supplies only the **localized price
  and currency formatting** for each one. Relayium supplies everything else on
  the row: the plan name and tier order, the billing-cycle wording, and the
  authoritative storage and monthly-traffic entitlement copy — all taken from
  the Relayium catalog.
- The current plan is identified exactly — **Plus monthly** — and that
  product's duplicate **Subscribe** action is omitted.
- The other **five** products keep their **Subscribe** action.
- **Restore purchases** and **Manage in the App Store** are both shown.

This is a readback of the offer surface, not a new purchase. The **Plus
monthly** entitlement it identifies was established earlier: a real Sandbox
purchase of Plus monthly was completed in build `1.2.0 (6)`, its signed
StoreKit 2 transaction was verified by the Relayium server, and the resulting
entitlement was **applied** to the account. Build `7` read that
already-existing entitlement back and identified Plus monthly as current; it
did **not** create a second transaction.

That boundary matters in both directions. The StoreKit purchase-and-verify path
has been observed working once, in Sandbox, for one product. **App Store Server
Notifications V2 delivery is still a separate, unverified gate** — no V2
delivery has been observed reaching `applied`, so the lifecycle events Apple
sends after a purchase (renewal, cancellation, refund, billing retry) remain
unproven.

## App Review notes draft

> The subscription UI is in Account. Relayium first fetches its provider-neutral
> product catalog from the Relayium server, which supplies the plan names, the
> benefits, the monthly or yearly cycle wording, and the order the tiers are
> shown in. It then asks StoreKit about exactly those product identifiers;
> StoreKit supplies the localized price and currency formatting for them. A
> product the server does not list is never offered, and a product StoreKit does
> not answer for is not shown.
> A successful signed StoreKit 2 transaction is sent to the
> Relayium server for Apple verification before the account entitlement changes.
> Restore Purchases is always available. Manage Subscription appears when the
> account has an Apple-managed entitlement. The Mac App Store build contains no
> Sparkle update framework or external purchase link.
>
> Test steps: sign in with the supplied review account; open Account; choose a
> Sandbox offer; complete the purchase; wait for the account plan to refresh;
> then test Restore Purchases. A second signed-in Relayium device can be used to
> verify text or file transfer.

Before submission, append the exact demo-account instructions and any special
network setup. A real Sandbox transaction has been observed end to end — Plus
monthly, purchased in build `1.2.0 (6)`, verified, and applied. An Apple Server
Notifications V2 delivery has **not**: do not claim the subscription lifecycle
is functional until one is observed reaching `applied`.

## Screenshots

Two different controls are easy to confuse; only the first is a submission
blocker.

**Storefront screenshots — still required.** Formal Mac App Store submission
needs 1–10 screenshots at an accepted 16:10 size: 1280×800, 1440×900, 2560×1600,
or 2880×1800. These are not yet supplied.

**Per-product Review Information screenshot — not a blocker today.** Each
subscription's Review Information section has its own screenshot control. As
checked on 2026-08-14, all six are empty and none shows a required marker, and
the products still offer Add for Review. Do not upload the Debug UI-test fixture
to satisfy an unmarked field. If Apple later flags a specific product, capture a
real one for that product rather than backfilling all six.

Capture a signed non-UI-test build with real App Store products. The debug UI
test fixture contains synthetic prices and must not be submitted. Remove email
addresses, device names, IP addresses, pairing codes, and other personal or
short-lived data before accepting an image.

Suggested set:

1. Account subscription offers with real localized StoreKit prices.
2. Account after a Sandbox entitlement has refreshed.
3. Same-network send surface with neutral test-device names.
4. Cross-network send surface without live pairing or download secrets.
5. Received files or text using non-sensitive sample content.

## External decisions and activation gates

The following items are intentionally unresolved and must not be guessed:

- Export compliance is **resolved for builds `1.2.0 (6)` and `1.2.0 (7)`**
  (2026-08-14) and must stay truthful for every later build. The app embeds
  non-Apple cryptographic implementations for end-to-end encryption; never set
  `ITSAppUsesNonExemptEncryption` to `NO` merely to suppress the questionnaire.
  Both builds cleared on the same facts — standard, non-exempt encryption, and
  France is not a selected territory, so the French declaration question is
  answered No on the facts. A later build inherits the encryption facts but not
  the answer: the questionnaire still has to be answered truthfully for it.
- The French encryption declaration only returns if France is re-added. That
  path runs through ANSSI: the provider or first importer submits the completed
  electronic form, a signed scanned copy, and supporting product and technical
  documentation, then the official document is uploaded to App Store Connect for
  Apple's approval and Apple's compliance code goes into the app Info.plist.
  Treat re-adding France as opening this work, not as a checkbox. Do not upload
  a self-authored substitute.
- Publish the completed App Privacy draft only when the release candidate and
  submission metadata are ready. The age rating is already saved as `4+`.
- Complete content-rights, copyright, review-contact, and demo-account fields
  in App Store Connect.
- Confirm the Paid Apps Agreement, bank account, and tax forms still report
  **Active**. They were verified Active on 2026-08-13; a lapse in any of the
  three withdraws paid products from sale without touching the app record.
- Confirm the tiers themselves are **active** in `/admin` under 套餐 / Plans.
  A catalog row may only be created live against a tier that exists and is on
  sale.
- Confirm every one of the six products exists in App Store Connect under
  bundle `com.relayium.mac`, with the product IDs above matching byte for byte.
  A catalog mapping is keyed by the (bundle id, product id) pair.
- Add and activate all six products through the authenticated `/admin` catalog,
  then install the production Apple verifier configuration for bundle
  `com.relayium.mac` and Apple ID `6801142976` with Production and Sandbox
  verification enabled (`"environments": ["Production", "Sandbox"]`, which
  requires the real numeric Apple ID on the app entry).
- **Watch the plan-off-sale trap.** Deactivating a tier does not sweep the
  catalog rows pointing at it: the row still looks enabled, `/admin` reports
  **Plan is off sale**, the app stops being offered that product, and a purchase
  that does arrive is refused. Before TestFlight and before review, confirm
  every one of the six rows reads **Live** rather than assuming an enabled row
  is a sellable one.
- Storefront availability is already set (173/175, France and China mainland
  excluded) and needs no further decision unless the owner changes it. Products
  are only offered where they are available, and Apple can take up to an hour to
  propagate metadata to Sandbox — so test Sandbox from an account whose
  storefront is actually selected before reading an empty StoreKit result as an
  app defect.
- Configure Apple Server Notifications V2 in App Store Connect for **both**
  environments — the Production URL and the Sandbox URL — each set to
  `https://relayium.com/api/apple/notifications`. One endpoint serves both; the
  server distinguishes them from the signed envelope, and the verifier
  configuration must name both environments for TestFlight and App Review
  purchases (always Sandbox) to be accepted alongside customer purchases (always
  Production). Send Apple's test notification on the Sandbox URL first, then
  prove a real Sandbox delivery reaches `applied`.
- Build `1.2.0 (6)` is uploaded, compliance-cleared, and attached to both
  TestFlight groups. Build `1.2.0 (7)` has finished processing, is
  compliance-answered, reads **Ready to Submit**, and is **Testing** in the
  internal group alongside build `6`; it has no external group assignment and
  no Beta App Review submission, because only one build of version `1.2.0` may
  be in Beta App Review at a time and build `6` holds that slot. External
  TestFlight is still gated on **Beta App Review**, which is **Waiting for
  Review**; until it passes, the public link cannot accept joiners. The real
  Sandbox purchase gate is **met**: Plus monthly was purchased in build
  `1.2.0 (6)`, verified, and applied, and build `7` only read that existing
  entitlement back. The purchase-path gate still open before Add for Review is
  used on the version and subscriptions is an observed **App Store Server
  Notifications V2** delivery reaching `applied`. Keep manual release selected.
