# App Store product catalog (operator guide)

Which App Store product grants which Relayium plan, and in what order the
pieces may be switched on.

This document covers the **operator-managed catalog** in `/admin`. It does not
cover creating products in App Store Connect, and it does not cover the native
purchase UI.

## Two truth sources, deliberately separate

Apple purchases depend on two things that live in different places and must
never be merged:

| | Where it lives | What it answers |
| --- | --- | --- |
| **Verifier configuration** | A file on the server, named by `-apple-store-config-file` / `RELAYIUM_APPLE_STORE_CONFIG_FILE`, read once at startup | *Can this deployment verify an Apple signature at all?* — trust roots, environment, bundle identities |
| **Product catalog** | The `apple_products` table, edited in `/admin` | *Which product means which tier?* — bundle id + product id → plan + billing cycle |

The separation is load-bearing. Configuration is operator material that is
reviewed, deployed and rolled back with the server; the catalog is a routine
data edit. Keeping them apart means a catalog edit cannot widen what the server
trusts, and a configuration change cannot silently repoint a product at another
tier.

**A catalog row cannot enable verification.** With no configuration file, the
server builds no verifier, and `POST /api/billing/apple/transaction` answers
`503 verifier_unavailable` regardless of what the catalog contains. This is the
shipping default and the state every existing deployment is in. There is no
combination of catalog rows that changes it.

The reverse is also true: a configured verifier with an empty catalog verifies
the signature and then refuses the purchase, because no mapping resolves. Both
halves are required, and each fails closed on its own.

## Supported activation order

Do these in order. Every step is independently reversible, and no step grants a
purchase until the last one is complete.

1. **The tier exists and is on sale.** Create or confirm the plan in `/admin`
   under 套餐 / Plans, with `active` checked. A catalog row may only be created
   live if its tier exists and is on sale — the write is refused otherwise, on
   the way in and again on the way out.
2. **The product exists in App Store Connect.** Create the subscription product
   under the app whose bundle id you will map, if it is not there already.
3. **Add the catalog row in `/admin`.** App Store 商品目录 / App Store product
   catalog → fill in bundle id, product id, tier, cycle, leave 启用 / Enabled
   checked, save. The write is a high-risk action: it renders a confirmation
   page showing the exact before/after values, requires your second factor, and
   is recorded in the audit log as `apple.product`. Nothing is written until you
   confirm.

   A mapping is keyed by the **pair** (bundle id, product id), so **every
   bundle/product combination a shipped app actually purchases needs its own
   row** — and its own App Store Connect record where one applies. Relayium
   ships two apps under different bundle ids, so selling one tier from both of
   them is two rows, one per bundle id. Check what the app is really submitting
   rather than inferring it: the pair in the row has to be the pair in the
   signed transaction, exactly.

   Each identifier is limited to **200 bytes**, which is the same limit the
   purchase verifier applies to a signed transaction. A longer key is refused
   rather than stored, because no purchase could ever match it.
4. **Configure the verifier and restart.** Only now install the configuration
   file and restart the server. The boot log states which App Store
   environment(s) and how many app identities are active. A broken or
   half-filled configuration refuses to start rather than falling back to the
   unconfigured state.

   A deployment that must accept TestFlight and App Review purchases alongside
   real ones names both environments — `"environments": ["Production",
   "Sandbox"]` — instead of the singular `"environment"` key; setting both keys
   is refused. Accepting `Production` requires every app entry to carry its real
   numeric `appAppleId`. A catalog row is shared by both stores: a mapping is
   keyed by bundle id and product id, and the same product sold in Sandbox and
   in Production resolves to the same tier. What is NOT shared is the
   subscription itself — see [Two environments at
   once](apple-server-notifications.md#two-environments-at-once).

Steps 1–3 are safe to do at any time on a running production server: the
endpoint keeps answering `503` throughout, so a partially built catalog is
never reachable. Step 4 is the only one that changes what the server accepts.

To roll back, remove the configuration file's setting and restart. The catalog
rows are left alone — they grant nothing while no verifier exists.

## Row states

The status column reports what a purchase for that product would do **right
now**, with this precedence:

- **Live** — the mapping is enabled and its tier is on sale. A purchase
  resolves.
- **Retired** — the mapping's own switch is off. It grants nothing. This wins
  over any tier problem, because an off mapping cannot be broken by its tier.
  It is also the correct resting state for a product you have withdrawn.
- **No such plan** — the mapping is enabled but names a tier that does not
  exist. Unreachable through the console (a foreign key stands under it) and
  shown anyway, because the place to discover a broken row is the place that
  can fix it.
- **Plan is off sale** — the mapping is enabled and its tier exists but has
  been deactivated. **This is the row that looks fine and is not:** the tier is
  re-checked when a purchase arrives, so purchases for this product are
  refused, and nobody edited the mapping to cause it. Deactivating a tier does
  not sweep the mappings that point at it.

## What the native apps see

The Mac App Store build does not carry product identifiers. It asks
`GET /api/billing/apple/catalog?bundleId=<its own bundle id>` — authenticated,
like the purchase intake — and sells only what that answers with. Three
properties matter to an operator:

- **It is this same table**, read through the same store method and filtered by
  the same status rule as the column above. Only **Live** rows are returned;
  retired rows, rows whose tier is off sale and rows with no tier are absent,
  because each one is a product whose purchase would be refused after the
  customer had been charged.
- **It is fail-closed with the rest.** With no verifier configured it answers
  the same `503 verifier_unavailable`, so an unconfigured deployment advertises
  nothing however many rows exist. A configured deployment with no rows for that
  bundle answers `200` with an empty list, and the app says there is nothing to
  buy.
- **The bundle identity comes from the verifier configuration, not the
  request.** A `bundleId` that is not in the configured app list is refused with
  `unknown_bundle`; the response echoes the configured value. So adding a row
  for a bundle the server is not configured for changes nothing a client can
  see.

Practical consequence for step 3 above: **the app picks up a new row on its next
catalog read** — no client release is needed to start selling a product, and
retiring a row stops it being offered. What a row cannot do is make an
unconfigured deployment sell anything.

## If the catalog cannot be read

The section shows a read error instead of a table, and **offers no editing at
all** — no row forms and no add form. That is deliberate: a save is an upsert,
and only the catalog can say whether a key already has a row. With the read
broken, adding a "new" mapping could silently repoint an existing one while the
page shows nothing that says so. Fix the read (check the server log), then edit.

The rest of the admin dashboard remains available throughout. This state says
nothing about whether purchases still resolve: that depends on the underlying
database failure, and must not be inferred from what this section shows.

## Retiring a mapping

Uncheck 启用 / Enabled and save. Retirement deliberately does **not** require
the tier to be on sale — the mapping most in need of retiring is the one whose
tier was just withdrawn, and requiring an active tier would leave a live App
Store product wired to a dead tier with no way to switch it off from the
console.

Order for withdrawing a product:

1. Stop selling it in App Store Connect.
2. Retire the catalog row here.
3. Only then, if you are also retiring the tier, deactivate the plan.

Doing (3) before (2) is recoverable — the row shows **Plan is off sale**, and
retiring it still works — but between those two moments purchases for that
product are refused rather than mapped, which is a support ticket rather than a
silent wrong grant.

## What editing a row does not do

- It does not change any existing subscriber's plan. The catalog is consulted
  when a transaction arrives, not retroactively.
- It does not change what the server trusts. See the two truth sources above.
- It does not delete anything. There is no delete: a mapping is retired, and
  the row stays as the record that the product was once wired to that tier.

## Related

[App Store Server Notifications V2](apple-server-notifications.md) — how Apple
reports renewals, refunds and expiries to this server, and why a retired
mapping still lets a refund revoke access.
