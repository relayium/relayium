# Billing and data-recording transparency

Relayium's core claim is that file contents never touch the server. That claim
invites an obvious follow-up: *then what does the server record, and what am I
being charged for?* This document answers that from the code itself, with a
file/function pointer for every claim, so a skeptical reader can verify it
rather than take our word for it.

Scope note up front: some of this only applies to the hosted service at
**relayium.com**. If you self-host (see [`docs/self-hosting.md`](self-hosting.md)),
billing and relay metering are both off unless you turn them on yourself —
that's covered in [Self-hosted vs. relayium.com](#self-hosted-vs-relayiumcom)
below.

All file/line references are relative to `server/` in the
[relayium/relayium](https://github.com/relayium/relayium) repository.

## Contents

- [The short version](#the-short-version)
- [What actually costs money: relay bytes, and only relay bytes](#what-actually-costs-money-relay-bytes-and-only-relay-bytes)
- [What is recorded, table by table](#what-is-recorded-table-by-table)
- [What the server structurally cannot know](#what-the-server-structurally-cannot-know)
- [What the server could know but chooses not to keep](#what-the-server-could-know-but-chooses-not-to-keep)
- [How quotas are enforced](#how-quotas-are-enforced)
- [The free tier, and what needs no account at all](#the-free-tier-and-what-needs-no-account-at-all)
- [Retention: how long anything is kept](#retention-how-long-anything-is-kept)
- [Self-hosted vs. relayium.com](#self-hosted-vs-relayiumcom)

## The short version

- A transfer between two devices on the same LAN never touches relayium.com's
  infrastructure after the initial handshake, and **nothing about it is billed
  or persisted**. The same is true of any CLI transfer, which is direct-only.
- The only thing relayium.com meters is **bytes relayed through a TURN
  server**, for the (fairly common) case where a direct connection can't be
  established. That's the entire billable event. It requires the sender to be
  signed in, because it's the only path that costs us real bandwidth.
- "Stored" transfers (a downloadable link, for when the receiver isn't online
  at the same time) also land on server or self-hosted-node disk — as
  opaque ciphertext, encrypted client-side before it ever reaches an
  HTTP request. Their size counts toward storage and monthly traffic quotas,
  same as relay bytes do.
- File **contents and filenames** are never visible to the server in either
  case — see [What the server structurally cannot know](#what-the-server-structurally-cannot-know)
  for why that's an architectural property, not a policy promise.
- A few things you might not expect are recorded, for concrete operational
  reasons — notably a device-login flow's origin IP, and admin action logs.
  Those are called out explicitly, not glossed over.

## What actually costs money: relay bytes, and only relay bytes

Which path a transfer takes, precisely — this is narrower than "it tries direct
first" and the difference is what decides whether anything is billed:

- **Same LAN, browser:** direct. The server issues no relay for a code-less LAN
  room, so `chooseRtcConfig` (`web/src/lib/ice.ts:208-220`) leaves the policy at
  `all` and host candidates carry the bytes.
- **Cross-network, browser:** **relay, by design — not as a fallback.** As soon
  as a TURN server is present in the ICE list, that same function returns
  `iceTransportPolicy: "relay"` outright. It does not attempt STUN-negotiated
  P2P first: on a cross-network path the direct candidates are going to fail
  anyway, and waiting out their checks costs about 20 seconds before ICE reaches
  the relay it would have used. So **there is no STUN-P2P rung for the browser**,
  and a cross-network browser transfer is a metered transfer.
- **CLI:** direct only. It never uses a relay, so it is never metered.

The root [`README.md`](../README.md#how-it-works) states the same thing
("LAN: direct · browser cross-network: TURN carries ciphertext only"). Only the
relayed path runs bytes through infrastructure relayium.com pays for, and only
that path is metered.

**Getting a relay credential at all requires being signed in and under quota.**
`handleICE` (`account/turn.go:59`) is the endpoint that hands out
ICE/TURN credentials for a pairing-code transfer. It:

1. Resolves the pairing code to its owner account (`account/turn.go:71-73`).
   An invalid or expired code gets STUN-only servers — no TURN credential, so
   no relay is even possible.
2. Refuses to mint a TURN credential if the owner's email isn't verified
   (`account/turn.go:112-120`, the "Sybil dampener" comment) or if the owner's
   monthly traffic allowance is already spent (`account/turn.go:122-135`,
   calling `s.trafficAllowanceSpent` from `account/plan_enforce.go:157`, which
   treats exactly zero remaining as spent). P2P direct still works in both
   cases; only relay is withheld.
3. Embeds the owner's user ID and the pairing code into the TURN username as
   `<expiry>:<userID>.<code>` (`account/turn.go:139`, `turnCredentials` at
   `account/turn.go:276`) — this is the only mechanism that ties relay bytes
   back to an account.

**Ingesting what was actually relayed** is a separate, one-way pipeline:
coturn (the TURN server) reports each allocation's cumulative relayed bytes
over Redis pub/sub; `internal/metering/metering.go` ingests those reports.
`Worker.handle` (`internal/metering/metering.go:81`) parses the coturn
username via `relayusage.TokenFromUsername` and `relayusage.SplitAttrib`
(`internal/relayusage/parse.go:18` and `:21`) to recover the owner's user ID,
and records a `UsageEvent{RelayedBytes, Billable: true}` against that user.
A username with no owner prefix (a legacy/anonymous code) is recorded but
never attributed to any account and never billed — see the
`SplitAttrib` doc comment. If Redis isn't configured
(`-redis-addr` / `RELAYIUM_REDIS_ADDR` unset), this whole pipeline never
starts (`main.go:551`) and relay usage is never ingested at all — transfers
still work, they're simply not metered.

**Self-hosted relay nodes are recorded but never billed.** If you point
Relayium at your own TURN node (BYO), its relay traffic is reported over a
separate HTTPS heartbeat path (same `relayusage` parser, different
transport) and stored with `billable = node.OwnerType == "fleet"`
(`account/nodes.go:1252`) — i.e. `false` for a self-hosted node. The bytes
still get a row (so you, the node owner, can see them in the admin
dashboard), but `UserRelayedSince` — the query the quota/billing math reads —
only sums `billable = 1` rows (see the comment in
`internal/metering/metering.go:100-105`), so BYO relay never counts against
your plan.

**Stored-transfer bytes also count**, separately from relay: uploading to a
"stored download link" writes ciphertext to central or node disk
(`account/files.go:81`, `handleUploadFile`), and both the storage occupied
and the bytes transferred count toward the same monthly traffic /storage
caps a relay transfer would (`account/plan_enforce.go:53-68`,
`currentMonthTraffic` sums `usage_monthly` — stored upload/download — plus
billable `usage_events` — relay). An own-node (BYO) upload skips this
entirely: `persistStoredFile(ctx, f, enforceCaps=false)`
(`account/plan_enforce.go:264`) writes straight to the store with no cap
check, because it lands on the user's own disk, never central's.

## What is recorded, table by table

This is a direct read of the schema in `account/sqlite.go` (the `CREATE
TABLE` block starting at line 38, plus the additive `ALTER TABLE`
migrations that follow it) — not a summary of intent, the actual columns.

| Table | What's in it | Why |
|---|---|---|
| `users` (`sqlite.go:48`) | id, email, display name, creation time, plan tier, Stripe customer/subscription IDs and status, subscription period end, plan-change bookkeeping. **No card data** — Stripe Checkout is a hosted redirect (`account/stripe.go:311`, `EnsureCustomer`/`CreateCheckoutSession`); Relayium's server never sees a card number. |
| `devices` (`sqlite.go:75`) | id, owning user, a **name** (nickname), creation and last-seen time, device kind (browser/CLI). This is the persistent paired-device list (settings page), not the realtime signaling room — see below. |
| `usage_events` (`sqlite.go:90`) | per-TURN-allocation relayed-byte totals: alloc ID, token, user ID, bytes, timestamp, later `node_id` and `billable` (`sqlite.go:387-390`). |
| `usage_periods` (`sqlite.go:1205`) | the same relay data bucketed by calendar month (`YYYYMM`), which is what billing/cap queries actually read (`account/plan_enforce.go:63`, `UserRelayedSince`). |
| `usage_monthly` (`sqlite.go:132`) | per-user, per-month upload/download byte totals for **stored transfers** (not relay). |
| `stored_files` (`sqlite.go:98`) | id, owner, an opaque `blob_key` (pointer to ciphertext on disk), an opaque `enc_manifest` blob (the encrypted filename/size manifest — server can't read it), plaintext **size in bytes**, burn-after-read flag, created/expires timestamps, download count. |
| `upload_events` (`sqlite.go:111`) | rolling 24h ledger of upload sizes per user, for the daily-quota check. |
| `nodes` (`sqlite.go:173`) | self-hosted or fleet relay/storage node registry: owner, region, URLs, per-node relayed/stored byte totals, online status. |
| `cli_device_auth` (`sqlite.go:236`) | the CLI's device-code login flow: **the requesting CLI's origin IP and user-agent**, shown on the browser approval page so a user can spot a phishing attempt (`sqlite.go:246-247`). This is the one place a general client IP is persisted — see [What the server could know but chooses not to keep](#what-the-server-could-know-but-chooses-not-to-keep). |
| `admin_audit` (`sqlite.go:292`) | every admin-console mutation: actor, **the admin's IP**, action, target, and a diff of what changed. Kept for up to 2 years by default — see [Retention](#retention-how-long-anything-is-kept). |
| `plans` (`sqlite.go:270`) | the tier table itself: storage/traffic/retention caps, prices, Stripe price IDs. No user data. |

Two things worth being explicit about, because a privacy-conscious reader
would reasonably ask:

- **Byte counts are the metered quantity, not access logs.** There's no table
  of "user X downloaded file Y at time Z from IP W" for ordinary transfers.
  `download_receipts` (`sqlite.go:485`) exists, but it's a 24-hour dedup table
  keyed by an opaque per-download nonce — its purpose is to stop a replayed
  receipt from double-crediting a node's bandwidth accounting, not to log who
  downloaded what.
- **The `cli_device_auth.client_ip` column is a genuine exception** to "no
  general IP logging" — it exists specifically so the browser approval page
  can show "this login request came from `<IP>`" as an anti-phishing signal,
  and it's scoped to that one login flow, not attached to ordinary transfer
  activity. We call this out rather than omit it, per the brief for this
  document.

## What the server structurally cannot know

Some of this is architectural, not a promise the server keeps by policy:

- **Realtime transfers leave the database entirely**, relayed or not. The signaling hub (`internal/signal/hub.go`) — which groups
  devices into rooms, holds nicknames, and forwards WebRTC offers/ICE
  candidates — has **no dependency on `account` or the SQLite store at
  all** (verified by grep: no `account.`/`sqlite`/`Store` reference in that
  package). Room membership, presence, and the nickname you typed exist only
  in server process memory for the lifetime of the connection; there is no
  code path from that package into a table. When the WebSocket closes, the
  data is gone — not "deleted," never written anywhere durable to begin
  with.
- **The public IP used to group a LAN room is also in-memory only.**
  `internal/signal/roomkey.go` computes it purely to key an in-process map
  and as a rate-limit counter; it is never handed to `account` for
  persistence.
- **File contents and filenames travel exclusively over the encrypted
  DataChannel**, per the crypto design in `docs/protocol/relayium-crypto-v1.md`
  and `docs/protocol/relayium-realtime-wire-v1.md`: a per-transfer X25519
  key exchange happens between the two browsers; the server relays only the
  SDP/ICE signaling envelope, never a decryption key. Structurally, the
  server has no key with which it could read a byte of the file even if it
  logged the DataChannel traffic (which, being P2P, it never sees at the
  transport level anyway).
- **Stored transfers (download links) are "zero-knowledge" the same way, at
  rest.** Per `docs/protocol/relayium-stored-wire-v1.md`: a random
  AES-256-GCM key is generated in the browser, used to encrypt both the file
  manifest (which holds the real filenames) and the file bytes, and that key
  lives only in the URL **fragment** (`#k=...`) — which by construction is
  never sent in an HTTP request, so the server that stores the ciphertext
  never receives the key. `stored_files.enc_manifest` (`sqlite.go:102`) is
  exactly that opaque blob. The server can see the **size** of what's stored
  (it has to, to enforce storage caps) but not the name or contents of a
  single file inside a multi-file batch.

The distinction that matters: for realtime P2P, the server never has the
bytes to begin with (it isn't in the data path after signaling completes).
For stored transfers, the server does receive and hold ciphertext bytes on
disk — but has no key to decrypt them. Both are structural properties of the
protocol, not a data-retention policy that a future version could quietly
change without also changing the wire format.

## What the server could know but chooses not to keep

This section is honesty about the boundary: things the server *sees* in the
course of handling a request, that aren't persisted, but where "not
persisted" is a code decision rather than something the protocol makes
impossible.

- Ordinary upload/download requests are handled without writing the
  requester's IP address into `stored_files`, `usage_events`, or
  `usage_monthly` — those tables (above) simply have no IP column. A request
  IP is used transiently for rate limiting (`account/turn.go:63`, the
  per-IP ICE rate limiter) but that's an in-memory limiter, not a durable log.
- The realtime nickname and LAN room membership (previous section) are a
  case where "the server never even gets a chance to persist it" — there is
  no code path that could, short of adding one to the hub package.
- Contrast this with `admin_audit.ip` and `cli_device_auth.client_ip`, which
  **are** deliberately persisted, for the reasons stated in the table above.
  We'd rather list the exceptions than let "no IP logging" read as a
  blanket claim it isn't.

## How quotas are enforced

Enforcement lives in `account/plan_enforce.go`, gated by a `Plan` struct
(`account/store.go:76`) with five caps per tier: `StorageBytes`,
`TrafficBytes`, `RetentionSecs`, `DailyQuotaBytes`, plus prices. The default
tiers are seeded in `defaultPlans()` (`account/settings.go:222-237`):

| Plan | Storage | Monthly traffic | Retention | Daily upload quota | Price |
|---|---|---|---|---|---|
| Free | 100 MiB | 1 GiB | 1 day | (inherits the global default) | $0 |
| Plus | 1 GiB | 20 GiB | 3 days | 7 GiB | $1.99/mo |
| Pro | 5 GiB | 100 GiB | 7 days | 34 GiB | $4.99/mo |
| Max | 10 GiB | 800 GiB | 14 days | 267 GiB | $9.99/mo |

(An admin can edit these live from `/admin`; the table above is the shipped
default, read straight from the source above — it is not a marketing price
list, and it can change.)

The dimensions actually checked, each fail-closed at write time:

- **Daily upload quota** — a rolling 24-hour window (`account/plan_enforce.go:217`,
  `remainingDailyQuota`), reserved atomically per upload
  (`account/sqlite.go:4209`, `ReserveUpload`) so concurrent uploads can't
  race past it. A near-empty file still debits a 64 KiB floor
  (`minBillableBytes`, `account/files.go:32` — capping object *count*, not
  just size). Exceeding it: `429` "daily quota exceeded".
- **Monthly traffic cap** — relay bytes (billable rows in `usage_periods`)
  plus stored upload/download bytes (`usage_monthly`), summed by
  `currentMonthTraffic` (`account/plan_enforce.go:55`) against
  `monthlyTrafficCap` (`account/plan_enforce.go:78`), which pro-rates a
  mid-month plan change into segments rather than granting a full month's
  cap on every upgrade. Exceeding it: `429` "monthly traffic limit reached"
  on upload (`account/files.go:195`), and TURN credential issuance is
  withheld for relay (`account/turn.go:122-135`).
- **Storage cap** (how much can be live at once, not how much has moved) —
  `overStorage` (`account/plan_enforce.go:201`) against the plan's
  `StorageBytes`, enforced atomically at persist time in
  `CreateStoredFileWithinStorageCaps` so concurrent uploads can't collectively
  bust it (`account/plan_enforce.go:264-277`, `persistStoredFile`).
  Exceeding it: `413` "storage limit reached."
- **Global disk cap** — a deployment-wide ceiling across all users
  (`SettingStorageDiskCap`, `account/plan_enforce.go:229-241`), independent
  of any one plan. Exceeding it: `507` "server storage is full."
- **Retention (TTL) and download-count limits** — every stored file gets an
  expiry and/or a max-download count resolved from the request plus admin
  defaults (`account/settings.go:132-167`, `resolveRetention`/`clampTTL`),
  further capped by the owner's plan retention ceiling if lower
  (`account/plan_enforce.go:310`, `planRetentionCap`). A file is deleted —
  ciphertext and row both — once either limit is hit; see
  [Retention](#retention-how-long-anything-is-kept).

Own-node (self-hosted, BYO) uploads and relay are exempt from every cap above
except the file's own retention/download-count settings — they land on the
user's own infrastructure, which the operator (not relayium.com) pays for.

Users can see exactly what they've used against their own cap at
`GET /api/me/usage` (`account/handlers.go:515`, `handleMeUsage`) — the same
numbers this document describes, not a hidden internal metric.

## The free tier, and what needs no account at all

**Same-LAN realtime transfers need no account, ever.** `handleICE` only
withholds relay credentials for an invalid/unattributable pairing code
(`account/turn.go:71-73`); a same-public-IP transfer never calls that
endpoint at all — the two browsers find each other in the in-memory
signaling hub and negotiate a DataChannel directly.

**A cross-network browser transfer does need payment**, and this document
used to say the opposite. It claimed that STUN alone might connect the two
peers so that no TURN credential was consumed. The browser never tries that:
`chooseRtcConfig` forces `iceTransportPolicy: "relay"` whenever a relay is in
the list, so a cross-network browser session is relayed and metered from the
start. Obtaining a pairing code therefore requires the sender to be signed in
for two reasons rather than one — attribution and abuse control (rate limits,
email verification) **and** the relay bytes it is about to spend
(`account/turn.go:63-135` issues the credentials once the code clears those
gates).

The unmetered cross-network path that does exist is the **CLI**, which is
direct-only and never asks for a relay.

**What actually costs money on the Free tier**: relay bytes beyond 1 GiB/month
combined with stored-transfer traffic, storage beyond 100 MiB live at once,
or wanting files to survive longer than 1 day / need a bigger daily upload
allowance. All three are the same three levers in the plan table above —
there's no separate "download fee" or per-transfer charge; it's flat monthly
tiers via Stripe Checkout/subscription (`account/billing.go:18-22`,
`handleBillingCheckout`).

## Retention: how long anything is kept

`account/gc.go`'s `GC.sweep` (`account/gc.go:127`) runs every 10 minutes
(`main.go:484`) and is the only thing that prunes any of this **on a clock**.
Deletions somebody asks for do not wait for it: a share deleted from the file
list, a pair-room object a receiver completes, a pair room its owner releases and
an account deletion all remove the authoritative row inline, in their own
transaction, which is what frees the storage — the sweep is a backstop for the
physical bytes, never what makes the deletion true. If stored transfers are
disabled entirely (no blob directory configured), **GC never runs at all** —
including the admin-audit prune below — see the residual noted at
`account/gc.go:49-52`.

| Data | Kept for | Where |
|---|---|---|
| Stored file (ciphertext + row) | Until its TTL/max-downloads is hit, whichever first | `ListExpiredStoredFiles` + `DeleteStoredFile`, `account/gc.go:129-141` |
| Rolling daily-quota ledger (`upload_events`) | ~25 hours (a small margin past the 24h window it backs) | `pruneMargin`, `account/gc.go:13`, applied at `account/gc.go:130` |
| Download-receipt dedup rows | 24 hours | `receiptRetention`, `account/gc.go:17`, applied at `account/gc.go:135` |
| Admin audit trail (`admin_audit`) | 2 years by default, admin-overridable (`-audit-retention-days` / `RELAYIUM_AUDIT_RETENTION_DAYS`, `main.go:152`) | `auditRetentionDefault`, `account/gc.go:64`, applied at `account/gc.go:169` |
| Monthly relay/traffic history (`usage_events`, `usage_periods`, `usage_monthly`) | **Not pruned by age at all** while the account is active — this is the billing history the quota math depends on | No prune call for these tables exists in `GC.sweep`; confirmed by reading the full sweep function |
| Abandoned chunked-upload session + its partial ciphertext (`upload_sessions`) | 1 hour idle, then the blob is re-read, the bytes it holds are billed, and both go. **Unreachable-node exception:** the row and partial blob are kept for as long as it takes, because the blob is the only exact byte count; it is re-probed hourly and settled when the node answers. **Account-deletion exception:** an explicit deletion request overrides that evidence hold, removes the user-attributed row immediately, and deletes or queues deletion of the partial blob | `ReapPendingUploads` / `recoverUnresolvedUploads` + `upload_sessions.unresolved_at`, `account/uploads_resumable.go`; `PurgeTransientUserData`, `account/sqlite.go` |
| A pre-upload's session + partial ciphertext when its **pairing room times out** | Not 1 hour — the room's own deadline. Voiding a room reclaims every artifact bound to it in one pass: the finalized objects and the unfinished uploads, blob and row for each, so storage and the account's open-session budget are free immediately. The blob is re-read first and what it really holds is billed. **Same-shaped exception as account deletion, and for the same reason:** if the node cannot be reached the exact size is unknowable, so the known bytes stay billed, the blob is queued for deletion, the row goes anyway, and the unknown residual (at most one append) is written off and logged — a deadline whose promise is deletion outranks holding a customer's ciphertext as billing evidence | `Service.voidPairRoom` / `reclaimRoomUpload` + `Store.ClosePairRoom`, `account/pairroom.go`, `account/sqlite_pairroom.go` |
| A pre-upload's finalized ciphertext once **somebody has joined that pairing room** | **No timer at all, and that is deliberate** (`account/pairroom.go` invariant 5): a joined transfer is never cut off by a clock, so nothing ages this out — not GC, not a plan retention cap, not a fallback expiry. It leaves in exactly three ways, each of them somebody acting. **(1) The receiver completes it:** it proves it holds the file key, and the authoritative row is deleted in the same transaction that queues the blob's durable delete intent, so the storage is released at commit rather than at the next sweep. **(2) The owning account releases the whole room** from its own list — this is the exit that always exists, because a receiver whose browser hands the bytes to a download rather than writing them itself can never complete. Release first refuses a room with any upload session still bound; otherwise the object rows are deleted, delete intents are queued, and quota is free when the transaction commits. **(3) The account is deleted.** Bytes already uploaded stay billed in all three cases — traffic is metered per committed append, and releasing storage is not a traffic refund. Pre-upload is off by default (`-enable-preupload`), so on a default deployment no such object exists | `Store.CompletePairRoomObject`, `account/pairroom_complete.go`; `Service.releasePairRoom` + `Store.CloseOwnedPairRoom` (`GET /api/pair-rooms`, `DELETE /api/pair-rooms/{id}`), `account/pairroom_owner.go`, `account/sqlite_pairroom.go` |
| Account + all of the above, on deletion | A grace period after a self-deletion request (`-account-grace-days` / `RELAYIUM_ACCOUNT_GRACE_DAYS`, default 30 days, `main.go:140`), then hard-purged | `ArchiveAndPurgeUser`, `account/sqlite.go:2177` |

**What "hard-purged" actually does**, read directly from
`ArchiveAndPurgeUser` (`account/sqlite.go:2177-2281`): the user's monthly
stored-transfer totals are folded into `usage_archive` — **period totals
only, with no user ID retained** (`sqlite.go:2201-2208`) — and then every
user-linked row (sessions, devices, identities, `usage_events`,
`usage_periods`, `stored_files`, `upload_sessions`, `pair_rooms`,
`upload_events`, `user_stats`, `usage_monthly`, tokens, owned nodes) is deleted
before the `users` row
itself. The comment at `sqlite.go:2221-2227` is explicit that leaving
`usage_periods` behind would "retain user-attributed relay history
indefinitely after the hard purge" and calls that out as contradicting the
stated model — so it's deleted too, not just anonymized. The purge is
guarded so a reactivation during the grace window aborts it entirely
(`sqlite.go:2266-2279`).

One place the code is honestly conservative rather than aggressive:
`PruneAudit`'s age-based deletion is **not** scoped to machine-written rows
— a short `-audit-retention-days` value would also delete the human admin
trail, which is by design (see the two-year default's rationale comment,
`account/gc.go:23-52`) meant to survive long enough for an incident
discovered months later to still have evidence attached to it.

## Self-hosted vs. relayium.com

Everything above is what the code *can* do; what actually runs depends on
which flags a given deployment sets (`main.go`):

- **Relay metering** is entirely off unless `-redis-addr` /
  `RELAYIUM_REDIS_ADDR` is set (`main.go:99`, wired at `main.go:551`). No
  Redis configured → the metering worker never starts → relay bytes are
  never ingested or attributed to anyone, full stop.
- **TURN relay itself** is off unless `-turn-secret` /
  `RELAYIUM_TURN_SECRET` is set (`main.go:94`) — without it there's simply no
  relay to meter. What still works is LAN browser transfers and the direct-only
  CLI; cross-network browser transfers do not, because the relay they depend on
  is the thing that is switched off.
- **Billing (Stripe)** is entirely off unless `-stripe-secret-key` /
  `RELAYIUM_STRIPE_SECRET_KEY` is set (`main.go:155`); every
  `/api/billing/*` route 404s otherwise (`account/billing.go:19-22`) and
  every account is, functionally, unlimited-by-payment (still subject to
  whatever plan caps an admin has configured locally).
- **The admin console** (`/admin`) that can view/edit any of this is off
  unless `RELAYIUM_ADMIN_PASS` is set — see
  [`docs/self-hosting.md`](self-hosting.md#admin-dashboard-optional-and-not-read-only).

A self-hosted instance with none of those three set stores none of the
billing-specific data described in this document — no Stripe fields
populated, no `usage_events`/`usage_periods` rows, no relay attribution. It
still has ordinary accounts, stored transfers, and the plan/quota mechanism
(useful even without payment, e.g. to bound a shared instance's disk usage)
— those run regardless of Stripe/Redis/TURN configuration.

---

*This document describes `server/` as of the commit that introduced it. If
you find a place where the code has since diverged from a claim here, that's
a bug in this document — please open an issue.*
