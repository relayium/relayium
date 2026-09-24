#!/usr/bin/env node
// Source-only iOS collection claims, moved from IOSPrivacyManifestTests.
// Unfiltered repository-policy owns native AND server input changes.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
// Preserve Swift String.contains: canonical equivalence and whole Characters.
function contains(source, needle) {
  const normalized = source.normalize("NFC");
  const wanted = needle.normalize("NFC");
  const boundaries = new Set(Array.from(segmenter.segment(normalized), part => part.index));
  boundaries.add(normalized.length);
  for (let i = normalized.indexOf(wanted); i >= 0; i = normalized.indexOf(wanted, i + 1)) {
    if (boundaries.has(i) && boundaries.has(i + wanted.length)) return true;
  }
  return false;
}

test("each iOS declared data type has a sending call site and retained storage", () => {
  const account = read(
      "apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift")
  const billing = read(
      "apps/RelayiumKit/Sources/RelayiumKit/Account/AppleBillingClient.swift")
  const storeKit = read(
      "apps/RelayiumKit/Sources/RelayiumStoreKit/StoreKitSubscriptionStore.swift")
  const signIn = read("apps/ios/Relayium/SignInView.swift")
  const schema = read("server/account/sqlite.go")

  // Name — the create-account form's own field, plus the name Apple hands
  // over on a first Sign in with Apple authorization. NOT the device
  // label: `testTheDeviceLabelThisAppSendsIsNotAName` owns that boundary.
  assert.ok(contains(signIn, "text: $draft.displayName"),
                "the iOS account form lost its name field")
  assert.ok(contains(account, "\"displayName\": displayName"),
                "registration no longer sends the typed name")
  assert.ok(contains(signIn, "credential.fullName?.givenName"),
                "Sign in with Apple no longer reads the name Apple provides")
  assert.ok(contains(account, "\"nonce\": nonce, \"name\": name"),
                "the native Apple sign-in no longer sends a name")
  assert.ok(contains(schema, "display_name TEXT"),
                "the server no longer retains the name this manifest declares")

  // Email address — the account identifier itself.
  assert.ok(contains(account, "\"email\": email"),
                "if the app stopped sending an email, this declaration would be wrong")
  assert.ok(contains(schema, "email        TEXT UNIQUE NOT NULL"))

  // Purchase history — the signed transaction goes up verbatim, and the
  // server keeps the product, period and Apple subscription id it proves.
  assert.ok(contains(billing, "submitAppleTransaction"),
                "the app no longer sends a transaction whose history it declares")
  assert.ok(contains(billing, "api/billing/apple/transaction"))
  assert.ok(contains(storeKit, "jwsRepresentation"))
  assert.ok(contains(schema, "CREATE TABLE IF NOT EXISTS subscription_sources"))

  // User ID — the appAccountToken, minted per account, sent off device to
  // Apple with the purchase and kept on the users row.
  assert.ok(contains(storeKit, ".appAccountToken(appAccountToken)"),
                "the app no longer sends the declared per-account identifier to Apple")
  assert.ok(contains(schema, "ADD COLUMN apple_account_token"))

  // Other usage data — the metering counters. Four transports produce them
  // on iOS and each has a table that outlives the transfer.
  assert.ok(contains(read(
      "apps/RelayiumKit/Sources/RelayiumKit/Cloud/ResumableTransport.swift"), "api/uploads"))
  assert.ok(contains(read(
      "apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift"), "api/files/"))
  const files = read("server/account/files.go")
  assert.ok(contains(files, "MeterUpload") && contains(files, "MeterDownload"))
  assert.ok(contains(schema, "CREATE TABLE IF NOT EXISTS usage_monthly"))
  assert.ok(contains(schema, "CREATE TABLE IF NOT EXISTS stored_files"))

  assert.ok(contains(read(
      "apps/RelayiumKit/Sources/RelayiumKit/Account/ICEClient.swift"), "api/ice"))
  // The whole assignment, not a fragment: the credential names the ACCOUNT
  // OWNER, joined to an immutable attribution tag (it used to be the
  // pairing code, which recycles). Dropping the owner from the token must
  // fail here; `attribToken` merely appearing somewhere must not pass.
  assert.ok(contains(read("server/account/turn.go"), "token := owner + \".\" + attribToken"),
                "the TURN credential must still NAME THE OWNER; that is the linkage declared")
  assert.ok(contains(read("server/account/nodes.go"), "RecordUsage"))
  assert.ok(contains(schema, "CREATE TABLE IF NOT EXISTS usage_events"))
  assert.ok(contains(schema, "CREATE TABLE IF NOT EXISTS usage_periods"))

  // And the Device Inbox delivery this release adds, which is the reason
  // Other Usage Data is declared on iOS at all rather than inherited from
  // the macOS audit: receiving a file here is metered to the account.
  assert.ok(contains(read(
      "apps/RelayiumKit/Sources/RelayiumKit/DeviceInbox/InboxClient.swift"), "try taskPath(taskID, \"blob\")"),
                "the Device Inbox no longer fetches a delivery's blob")
  const inboxTask = read("server/account/deviceinbox_task.go")
  assert.ok(contains(inboxTask, "inbox/tasks/{taskId}/blob"),
                "the metered Device Inbox blob route is gone")
  assert.ok(contains(inboxTask, "RecordMeter(ctx, sf.UserID, MeterDownload, n"),
                "a Device Inbox delivery is no longer metered to the account, so Other "
                 + "Usage Data may no longer describe what receiving costs")

  // And the app reads its own totals back, which is where the user sees
  // what is being kept.
  assert.ok(contains(account, "api/me/usage"))

  // Product interaction — showing a cross-network code from this app is
  // what mints the code the aggregate counts.
  assert.ok(contains(read(
      "apps/RelayiumKit/Sources/RelayiumKit/Account/PairClient.swift"), "api/pair"))
  assert.ok(contains(schema, "CREATE TABLE IF NOT EXISTS activation_funnel_monthly"))

});
