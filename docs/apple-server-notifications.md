# App Store Server Notifications V2 (operator guide)

How Apple tells this server that a subscription changed, what the server does
with that, and what must be true before the endpoint is switched on.

This document covers the **server side**. It does not cover creating the
subscription products (see [App Store product catalog](apple-product-catalog.md))
and it does not cover the native purchase UI.

## What the endpoint is

`POST /api/apple/notifications`

Apple POSTs a single signed JWS to a URL configured in App Store Connect. The
route is unauthenticated in the ordinary sense — Apple has no Relayium session
and no CSRF token — and is authenticated instead by the signature on the
payload itself, verified against the trust roots this deployment configured.
This is the same arrangement the Stripe webhook uses.

**It is inert by default.** With no verifier configuration
(`-apple-store-config-file` / `RELAYIUM_APPLE_STORE_CONFIG_FILE`), the server
builds no verifier and the endpoint answers `503`. That is the shipping default
and the state every existing deployment is in. Nothing in the database changes
that; the configuration file is the only switch.

## What decides an entitlement — and what does not

A notification contains two signed documents: the outer envelope Apple sends,
and a nested `signedTransactionInfo` inside it. **Both are verified
independently.** The outer signature proves Apple sent the envelope; it proves
nothing about a string sitting in one of its fields, so the nested JWS is put
through the same chain and signature checks on its own evidence.

Everything an entitlement depends on comes from the **nested transaction**, and
it flows through exactly the same code path as an authenticated purchase
(`appleSourceEvent` → `ApplySubscriptionSource`). In particular, these are
**never** read to decide access:

| Field | Why not |
| --- | --- |
| `notificationType`, `subtype` | Apple's label for what happened. A `DID_RENEW` carrying an expired transaction must not renew anything. Recorded for operators; never consulted. |
| `signedDate` | Selects the instant the certificate chain is validated at, nothing else. The replay/ordering clock comes from the transaction's own `purchaseDate`. |
| `data.signedRenewalInfo` | Apple's *intention* to renew. Not a paid-through date. Not read at all. |
| `data.status` | A summary of the transaction, and the transaction is present. |

The envelope decides only **which app and which delivery**. Identity normally
comes from `data`, and for Apple's other official notification shapes comes
from `summary`, `externalPurchaseToken`, or `appData`, following the same
fallback order as Apple's server library. The selected bundle and environment
must name a configured app; when `data` also carries a nested transaction, that
transaction must agree with them. Relayium ships two apps, so the cross-layer
comparison is what stops a macOS purchase being presented inside an iOS
notification.

## Two environments at once

TestFlight and App Review purchases are always **Sandbox**; customers are always
**Production**. One deployment can therefore be required to accept both, which
the verifier configuration states explicitly:

```json
{ "environments": ["Production", "Sandbox"] }
```

The singular `"environment": "Sandbox"` key still means exactly what it always
did — a one-element set — and every existing file keeps working unchanged. The
two keys are alternatives: a file that sets **both** is refused at startup
rather than resolved. The set may hold only `Production` and `Sandbox`, spelled
exactly, at most one of each, and it may not be empty. There is no wildcard and
no fallback that retries a refused payload against the other environment; the
boot log states the accepted set (`Production+Sandbox`).

Accepting `Production` requires every configured app to name its real numeric
App Store id, whether or not Sandbox is accepted beside it.

**Environments do not share subscriptions.** Apple numbers transactions per
store, so the same `originalTransactionId` names two unrelated subscriptions —
one of them free. A Sandbox subscription is therefore recorded under a
namespaced identity:

| Environment | `subscription_sources.external_id` |
| --- | --- |
| Production | `2000000000000001` (Apple's id, unchanged) |
| Sandbox | `sandbox:2000000000000001` |

Production ids are unchanged byte for byte, so nothing already recorded moves.
The separator cannot occur inside an Apple id — a transaction carrying one is
refused — which is what makes the two namespaces disjoint rather than merely
different-looking. Ownership lookups, entitlement writes and deferred-delivery
drains all use the qualified identity, so a Sandbox purchase can neither adopt,
drain nor revoke the Production subscription that shares its digits.

One account still holds one Apple subscription row, so there is one further
rule: a **Sandbox** event never displaces a binding already held by a
**Production** subscription (the reverse is allowed — a real purchase supersedes
a test one). A tester who is also a paying customer keeps what they paid for;
their sandbox purchase is accepted, recorded and simply does not change their
plan.

In Production an envelope must carry the configured `appAppleId` and match it.
In Sandbox the field is not an identity constraint: Relayium follows Apple's
official server verifier and checks the globally unique `bundleId` instead,
whether `appAppleId` is absent or present.

## The ledger, and what each outcome means

Every verified delivery gets a durable row in `apple_notifications`, keyed by
`notificationUUID`. That row is both the idempotency record and — where
relevant — the replayable projection of the event. Nothing verified is ever
silently dropped.

| State | HTTP | Meaning | Operator action |
| --- | --- | --- | --- |
| `applied` | 200 | The entitlement was recorded. | None. |
| `ignored` | 200 | Verified, but carried no transaction at all (for example a summary-shaped `RENEWAL_EXTENSION`). Nothing to derive. | None. |
| `unsupported` | 200 | Verified transaction of a kind this model does not represent — consumable, non-renewing, or `FAMILY_SHARED`. Deliberately not guessed at. | None normally. A rising count means Apple is sending product kinds Relayium does not sell. |
| `pending` | 200 | Verified and actionable, but not applied yet: no owner could be resolved, or the product has no catalog mapping. The projection is stored. | See **Draining deferred deliveries** below. |
| `conflict` | 500 | Apple's record and this server's disagree about which account owns the subscription. Nothing was granted. | Investigate; this should not happen. |
| `received` | 500 | The delivery was claimed and then interrupted — a crash or a storage failure. | None; Apple's retry redoes it. |

`received`, `pending` and `conflict` are **not terminal**: a redelivery re-runs
the decision rather than being told the work is finished.

Completed, ignored and unsupported entries are kept for two years for support
and billing investigation, then pruned. Unfinished `received`, `pending` and
`conflict` entries are never age-pruned. Hard account deletion immediately
removes entries attributable to that account, independent of this retention.

### Why some answers are deliberately failures

Apple stops retrying after a 2xx. A 2xx is therefore only ever returned when
the outcome is durable — the row reached a terminal state, or the event was
written down for replay. A verified, actionable notification that changed
nothing and was not recorded is never acknowledged, because Apple will not send
it again.

## Draining deferred deliveries

A `pending` row has two causes, and they recover differently.

**Unknown owner.** Apple frequently delivers a notification before the
purchasing client finishes its own round trip to
`POST /api/billing/apple/transaction`. The row drains automatically the moment
that call binds the subscription to an account — no operator action, no sweep.

**Unmapped product.** The purchase names a product with no live catalog row.
Add the mapping (see the catalog guide); the next delivery of that
notification, or the next notification for that subscription, applies it.

To inspect the ledger directly:

```sql
SELECT state, COUNT(*) FROM apple_notifications GROUP BY state;
SELECT notification_uuid, notification_type, original_transaction_id, environment,
       product_id
  FROM apple_notifications WHERE state IN ('pending','conflict');
```

A drain is scoped to one subscription in one store, so a `pending` row is only
replayed by activity in its own `environment`.

**Rows with an empty `environment`.** The column was added to an existing table.
A `pending` row written before it carries `''`, and which store it came from is
unknowable — guessing `Production` could let an old Sandbox event reach a paid
binding, and guessing `Sandbox` would strand a real one. Such a row is therefore
never replayed; each skip logs
`apple notifications: skipped deferred <uuid> (unknown environment)`. It needs a
human decision: look the `notificationUUID` up in App Store Connect and either
apply the change by hand or move the row to a terminal state. Only deployments
that were already running the notification endpoint can have any; a deployment
that has never configured a verifier has none.

A `notificationUUID` from that table can be looked up in App Store Connect's
notification history. Every delivery also logs one line carrying that UUID and
the notification type — and deliberately carrying no JWS, no certificate, no
attribution token and no transaction id.

## Revocation does not depend on the catalog

A refund, an upgrade replacement or an elapsed period drops the source to the
free tier without reading the product mapping. This is intentional: requiring a
live mapping in order to *end* access would mean that retiring a catalog row
silently disabled revocation for every subscription still using it. Only
*starting* access needs a mapping.

## Activation prerequisites

Do these in order.

1. **Verifier configured.** The endpoint is inert without it. See the catalog
   guide's activation order; the same configuration serves both the purchase
   intake and this endpoint.
2. **Product catalog populated.** Otherwise live purchases land in `pending`
   rather than granting.
3. **Resolve the certificate-marker question below.** This is a hard gate.
4. **Decide the environment set.** A deployment that will receive TestFlight or
   App Review purchases needs `"environments": ["Production", "Sandbox"]`;
   anything else stays on the single environment it already names.
5. **Set the URL in App Store Connect** (Sandbox first), and send Apple's test
   notification.
6. **Verify the first real delivery** reaches `applied`, not a 4xx.

### Apple certificate marker compatibility

Relayium's JWS verification requires two Apple-private certificate marker
extensions at fixed positions — `1.2.840.113635.100.6.11.1` (receipt signing)
on the leaf and `1.2.840.113635.100.6.2.1` (WWDR) on the intermediate. This is
a narrowing check on top of a chain that already terminates at an explicitly
configured Apple root, and it is what distinguishes a receipt-signing leaf from
any other certificate the same intermediate issued.

Apple's official Node server library independently confirms this rule in
`SignedDataVerifier.verifyCertificateChainWithoutCaching`: it requires
`1.2.840.113635.100.6.11.1` on the leaf and
`1.2.840.113635.100.6.2.1` on the intermediate after verifying the chain.
Relayium therefore retains the same narrowing checks.

The synthetic fixtures also carry both markers. During Sandbox activation, the
first real delivery should still be inspected as an end-to-end compatibility
check:

- decode the `x5c[0]` certificate from a real Apple JWS (sandbox is enough) and
  confirm the extension is present:

  ```sh
  # $LEAF is the first x5c entry, base64 DER
  printf '%s' "$LEAF" | base64 -d | openssl x509 -inform der -noout -text \
    | grep -A1 '1.2.840.113635.100.6.11.1'
  ```

This is no longer an open source-compatibility gate; the real Sandbox delivery
check remains part of activation evidence rather than a reason to weaken the
certificate profile in advance.

## Rollback

Remove the notification URL in App Store Connect, or remove the verifier
configuration and restart. The endpoint returns to `503`, the ledger stops
growing, and existing rows are inert — nothing reads them except the drain,
which needs an owner and a live mapping to do anything. No migration is
required in either direction: an older binary rolled back onto this database
simply never reads the table, and the `environment` column it does not know
about is defaulted, so its own writes still land.

Narrowing the environment set is also a plain configuration change and a
restart. Deliveries from a store that is no longer configured are refused with
`400`; the subscriptions recorded under that store's namespace are left exactly
as they are.
