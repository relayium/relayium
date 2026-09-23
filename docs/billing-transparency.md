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
- [What actually costs money: relayed bytes and hosted storage](#what-actually-costs-money-relayed-bytes-and-hosted-storage)
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
  or persisted**. The same is true of the CLI's **direct** modes — `push`,
  `pull`, `sync`, `serve` and daemon-direct, `send`/`receive` and `text`. They
  move bytes between the two ends and never ask relayium.com to relay them or
  to hold them.
- What relayium.com meters is **hosted bytes**, and they arrive by two
  different routes: encrypted data it *stores* for you, and bytes it *relays*
  for you through a TURN server. Both land in one figure —
  `currentMonthTraffic` (`account/plan_enforce.go:72`) adds hosted upload and
  download (`usage_monthly`) to billable relay (`usage_events`) — so "monthly
  traffic" is not a relay meter with storage bolted on; it is the sum.
- **Four separate limits, not one.** Monthly traffic (above) is how much moved.
  **Storage** is a different question — how much ciphertext you are keeping
  live *right now*, checked by `remainingStorage`
  (`account/plan_enforce.go:311`) against `CurrentStorage`, so deleting a file
  frees storage and refunds no traffic. **Retention** is how long a stored file
  may live, and the **daily upload quota** is a rolling 24-hour window. This
  document describes each separately because the code does; see
  [How quotas are enforced](#how-quotas-are-enforced).
- The **hosted** paths are a browser "stored download link" (a downloadable
  link, for when the receiver isn't online at the same time), the CLI's
  `relayium up` / `relayium down`, and Device Inbox. All of them land on server
  or self-hosted-node disk as opaque ciphertext, encrypted client-side before
  it ever reaches an HTTP request. `relayium up` is the reason "the CLI is
  direct-only" is not a true sentence: it is a CLI command that deliberately
  is not direct.
- File **contents and filenames** are never visible to the server in either
  case — see [What the server structurally cannot know](#what-the-server-structurally-cannot-know)
  for why that's an architectural property, not a policy promise.
- A few things you might not expect are recorded, for concrete operational
  reasons — notably a device-login flow's origin IP, and admin action logs.
  Those are called out explicitly, not glossed over.

## What actually costs money: relayed bytes and hosted storage

Which path a transfer takes, precisely — this is narrower than "it tries direct
first" and the difference is what decides whether anything is billed:

- **Same LAN, browser:** direct. The server issues no relay for a code-less LAN
  room, so `chooseRtcConfig` (`web/src/lib/ice.ts:509-522`) leaves the policy at
  `all` and host candidates carry the bytes.
- **Cross-network, browser:** **relay, by design — not as a fallback.** As soon
  as a TURN server is present in the ICE list, that same function returns
  `iceTransportPolicy: "relay"` outright. It does not attempt STUN-negotiated
  P2P first: on a cross-network path the direct candidates are going to fail
  anyway, and waiting out their checks costs about 20 seconds before ICE reaches
  the relay it would have used. So **there is no STUN-P2P rung for the browser**,
  and a cross-network browser transfer is a metered transfer.
- **CLI:** not relayed **as the CLI is built today** — there is no ICE or TURN
  code path in `server/cmd/relayium/` at all. Stated as a fact about the current
  binary rather than as a promise, because it is one: these modes were built
  direct-only, and whether that stays true is a product decision, not an
  invariant. What IS invariant, and what this document is really about, is that
  no path lets relayium.com read a file — a relayed browser transfer is metered
  precisely because the relay forwards ciphertext it cannot decrypt. Its **direct** modes (`push`, `pull`, `sync`,
  `serve` and daemon-direct, `send`/`receive`, `text`) therefore carry nothing
  relayium.com can meter. Its **hosted** modes are the exception, and they are
  not relayed either: `relayium up` and `relayium down` write and read the same
  encrypted server-side storage a browser stored link uses, so they count
  toward monthly traffic — and `up`, being an upload, also against the storage
  cap and the daily upload quota.

The root [`README.md`](../README.md#how-it-works) states the same thing
("LAN: direct · browser cross-network: TURN carries ciphertext only"). Relayed
bytes and hosted storage are the two things that run through infrastructure
relayium.com pays for, and between them they are what is metered. The direct
paths — LAN browser, and the CLI's direct modes — run through neither.

**Getting a relay credential at all requires being signed in and under quota.**
`handleICE` (`account/turn.go:59`) is the endpoint that hands out
ICE/TURN credentials for a pairing-code transfer. It:

1. Resolves the pairing code to its owner account and that transfer's billing
   identity in one lookup (`AttribFor`, `account/turn.go:98`). An invalid or
   expired code gets STUN-only servers — no TURN credential, so no relay is
   even possible.
2. Refuses to mint a TURN credential if the owner's email isn't verified
   (`account/turn.go:132-140`, the "Sybil dampener" comment) or if the owner's
   monthly traffic allowance is already spent (`account/turn.go:142-155`,
   calling `s.trafficAllowanceSpent` from `account/plan_enforce.go:185`, which
   treats exactly zero remaining as spent). P2P direct still works in both
   cases; only relay is withheld.
3. Embeds the owner's user ID and that transfer's **attribution tag** into the
   TURN username as `<expiry>:<userID>.<tag>` (`account/turn.go:167`,
   `turnCredentials` at `account/turn.go:236`) — this is the only mechanism
   that ties relay bytes back to an account.

   The tag, not the pairing code itself. A tag is 128 random bits drawn once per
   minted code and never reused (`drawRelayAttribTag` at
   `internal/signal/attrib.go:211`). It has to be something that never recycles,
   because a credential outlives its code by most of an hour — `TURNCredTTL` is
   an hour, `signal.CodeTTLSeconds` five minutes — and the digits go back into
   circulation as soon as the code expires. While the token was the code, a
   report arriving after those digits had been minted for somebody else was read
   as a forgery and dropped, so bytes that were really relayed were billed to
   nobody at all.

   The tag stays **lookupable** until the last credential issued under it
   expires plus a fifteen-minute reporting grace (`relayAttribGraceSeconds`,
   `internal/signal/attrib.go:101`), independently of the code and of the
   signalling room. That window is sized from how our own relay nodes behave;
   it is **not** a billing deadline and not a claim about other providers. A
   report arriving after it — a node that was offline, a server that has
   restarted, or a coturn allocation that outlived its credential — is still
   recorded and still billed to the account its username names. What lapses is
   only the server's ability to contradict a mismatched claim, which returns
   that report to the same accept-as-reported path an expired code has always
   taken. Nothing is lost.

**Ingesting what coturn relayed** is a separate, one-way pipeline that is
**currently disabled** (details at the end of this paragraph). As designed,
coturn (the TURN server) would report each allocation's cumulative relayed
bytes over Redis pub/sub and `internal/metering/metering.go` would ingest them.
`Worker.handle` (`internal/metering/metering.go:81`) parses the coturn
username via `relayusage.TokenFromUsername` and `relayusage.SplitAttrib`
(`internal/relayusage/parse.go:18` and `:21`) to recover the owner's user ID,
and records a `UsageEvent{RelayedBytes, Billable: true}` against that user.
A username with no owner prefix (a legacy/anonymous code) is recorded but
never attributed to any account and never billed — see the
`SplitAttrib` doc comment. **This pipeline is currently disabled and never
starts**, whether or not `-redis-addr` / `RELAYIUM_REDIS_ADDR` is set:
`guardCoturnRedisMetering` (`main.go:1255`) only logs a warning. The ingest
keyed usage by coturn's session id, which restarts from zero on every coturn
restart, so a reused id would have billed one account for another's relay
bytes. Until a re-keyed ingest replaces it, relay traffic through coturn is not
ingested or metered at all — transfers still work, they're simply not metered.

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

**Hosted bytes count too, and against different dimensions.** Uploading to a
"stored download link" writes ciphertext to central or node disk
(`account/files.go:181`, `handleUploadFile`), and that one upload is checked
against three separate limits in that handler: the storage cap
(`s.overStorage`, `account/files.go:332`), the monthly traffic cap
(`s.overTraffic`, `account/files.go:336`) and the rolling daily quota, whose
debit is written by the stored file's own insert transaction
(`CreateStoredFileWithinStorageCaps`, `account/sqlite.go:5355`). Only the traffic one is shared with
relay: `currentMonthTraffic` (`account/plan_enforce.go:54-69`) sums
`usage_monthly` — hosted upload/download — plus billable `usage_events` —
relay. Storage is occupancy, not throughput, and is not something a relay
transfer can consume at all.

The same handler is what `relayium up` uploads through, so the CLI's hosted
mode is bounded identically. Delivery to a **Device Inbox** is metered on the
same traffic dimension when the target device collects its task
(`s.overTraffic`, `account/deviceinbox_task.go:103`).

An own-node (BYO) upload skips the caps entirely:
`persistStoredFile(ctx, f, enforceCaps=false)`
(`account/plan_enforce.go:265`) writes straight to the store with no cap
check, because it lands on the user's own disk, never central's.

## What is recorded, table by table

This is a direct read of the schema in `account/sqlite.go` (the schema block
starting at line 49, plus the additive `ALTER TABLE`
migrations that follow it) — not a summary of intent, the actual columns.

| Table | What's in it | Why |
|---|---|---|
| `users` (`sqlite.go:50`) | id, email, display name, creation time, plan tier, Stripe customer/subscription IDs and status, subscription period end, plan-change bookkeeping. **No card data** — Stripe Checkout is a hosted redirect (`account/stripe.go:311`, `EnsureCustomer`/`CreateCheckoutSession`); Relayium's server never sees a card number. |
| `devices` (`sqlite.go:92`) | id, owning user, a **name** (nickname), creation and last-seen time, device kind (browser/CLI). This is the persistent paired-device list (settings page), not the realtime signaling room — see below. |
| `usage_events` (`sqlite.go:105`) | per-TURN-allocation relayed-byte totals: alloc ID, token, user ID, bytes, timestamp, later `node_id` and `billable` (`sqlite.go:448`). |
| `usage_periods` (`sqlite.go:1766`) | the same relay data bucketed by calendar month (`YYYYMM`), which is what billing/cap queries actually read (`account/plan_enforce.go:64`, `UserRelayedSince`). |
| `usage_monthly` (`sqlite.go:163`) | per-user, per-month upload/download byte totals for **stored transfers** (not relay). |
| `stored_files` (`sqlite.go:113`) | id, owner, an opaque `blob_key` (pointer to ciphertext on disk), an opaque `enc_manifest` blob (the encrypted filename/size manifest — server can't read it), plaintext **size in bytes**, burn-after-read flag, created/expires timestamps, download count. |
| `upload_events` (`sqlite.go:126`) | rolling 24h ledger of upload sizes per user, for the daily-quota check. |
| `upload_operations` (`sqlite.go:1535`) | single-shot upload `Idempotency-Key` records: owner, the client's key, the id of the file it created, a SHA-256 of the request's retention parameters and declared length, and when it was made. No file content, name or key material. |
| `nodes` (`sqlite.go:220`) | self-hosted or fleet relay/storage node registry: owner, region, URLs, per-node relayed/stored byte totals, online status. |
| `cli_device_auth` (`sqlite.go:283`) | the CLI's device-code login flow: **the requesting CLI's origin IP and user-agent**, shown on the browser approval page so a user can spot a phishing attempt (`sqlite.go:293-294`). This is the one place a general client IP is persisted — see [What the server could know but chooses not to keep](#what-the-server-could-know-but-chooses-not-to-keep). |
| `admin_audit` (`sqlite.go:339`) | every admin-console mutation: actor, **the admin's IP**, action, target, and a diff of what changed. Kept for up to 2 years by default — see [Retention](#retention-how-long-anything-is-kept). |
| `plans` (`sqlite.go:317`) | the tier table itself: storage/traffic/retention caps, prices, Stripe price IDs. No user data. |

Two things worth being explicit about, because a privacy-conscious reader
would reasonably ask:

- **Byte counts are the metered quantity, not access logs.** There's no table
  of "user X downloaded file Y at time Z from IP W" for ordinary transfers.
  `download_receipts` (`sqlite.go:546`) exists, but it is a 24-hour dedup table
  keyed by an opaque per-download nonce, and it no longer receives new rows at
  all: the node-direct download accounting it belonged to has been withdrawn,
  so downloads are metered from the bytes the server itself served (see
  `docs/direct-download-deploy.md`). It never logged who downloaded what.
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
  never receives the key. `stored_files.enc_manifest` (`sqlite.go:117`) is
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

- **Daily upload quota** — a rolling 24-hour window (`account/plan_enforce.go:344`,
  `remainingDailyQuota`). The debit is checked and written in the **same
  database transaction that inserts the stored file**
  (`CreateStoredFileWithinStorageCaps`, `account/sqlite.go:5355`), so
  concurrent uploads can't race past it, and a file that is not stored — a
  refusal by a later cap, a closed pairing room, a database error, a server
  crash mid-upload — never leaves a debit behind; there is no separate
  reservation that a failed refund could strand. A stored file's debit is not
  returned when you delete the file: it leaves the window after 24 hours. A
  near-empty file still debits a 64 KiB floor
  (`minBillableBytes`, `account/files.go:35` — capping object *count*, not
  just size). Uploads that land on your own storage node are never debited.
  Exceeding it: `429` "daily quota exceeded". Inside the transaction that
  stores the file it is checked before the storage caps, so there it is the
  answer when both are exceeded. Two earlier refusals can answer first: a
  single-shot upload's pre-check uses the declared size without the 64 KiB
  floor, so a small file can pass it and then meet a full storage cap
  (`413`/`507`); and if the plan cannot be read, the upload fails closed
  with `500` before the quota is consulted. Neither leaves a debit.
- **Retrying a single-shot upload safely (`Idempotency-Key`)** — optional,
  for `POST /api/files` only. A client may send an `Idempotency-Key` header
  (16–128 characters of `A–Z a–z 0–9 . _ : -`; the key belongs to your
  account, so another account's identical key is unrelated). The key is
  recorded in the **same transaction** that stores the file and writes its
  daily-quota debit, so it exists only if both do. A retry with a key already
  recorded is answered from that record **before the request body is read**
  (`answerUploadOperation`, `account/files.go:580`): the original `200` with
  `Idempotent-Replay: true` — no second file, no second debit, no traffic. A
  client using `Expect: 100-continue` never sends the body; one that sends it
  anyway is not billed for it, because the server does not read it. This holds
  even when the first attempt used up the daily quota: the retry gets its file
  back, not `429`. If that file has since been deleted, expired or used up its
  download limit, the retry gets `410` and the file is **never created
  again**; if the key was first used with different retention parameters
  (`ttl`, `burnAfterRead`, `maxDownloads`, `purpose`) or a different declared
  length, `422`. Two requests with one key in flight at once each move their
  body and each is billed for the traffic it actually moved, but only one
  creates a file and a debit; the other's copy is discarded and it gets the
  same answer. A keyed upload that is refused or fails leaves the key unused,
  so it can simply be retried. Without the header nothing changes: every
  request is a new upload. Resumable uploads (`/api/uploads`) do not use this
  header.
- **Monthly traffic cap** — relay bytes (billable rows in `usage_periods`)
  plus stored upload/download bytes (`usage_monthly`), summed by
  `currentMonthTraffic` (`account/plan_enforce.go:69`) against
  `monthlyTrafficCap` (`account/plan_enforce.go:95`), which pro-rates a
  mid-month plan change into segments rather than granting a full month's
  cap on every upgrade. Exceeding it: `429` "monthly traffic limit reached"
  on upload (`account/files.go:336`), and TURN credential issuance is
  withheld for relay (`account/turn.go:142-155`).

  **The relay quota gate runs at ISSUANCE, and that is the whole of it.** It
  decides whether another TURN credential is handed out. It does not reach an
  allocation that already exists, cannot revoke one, and does not stop bytes as
  they move. Renewal (`account/renew.go`) re-runs exactly this check on every
  round; it did not introduce that boundary and does not change it.

  Two limits follow, and both are true of the hosted service today:

  - **An existing relay allocation is not revoked when its credential
    expires.** A credential's lifetime governs what may be newly allocated.
    Retiring an allocation that is already running is the relay server's
    business, and on the third-party TURN server this deployment uses it is not
    something a credential expiry compels.
  - **Relay usage is metered after the fact**, not as it moves: from a node's
    own periodic report, or — on the third-party path — when an allocation
    ends. So a long transfer's usage is recognised per credential round rather
    than at the instant it happens.

  What this document must therefore not be read as claiming: an instantaneous
  cap; that a credential lifetime bounds an allocation's lifetime; that a
  migration retires the old allocation within any fixed time; or that an old
  allocation costs nothing.

  The precise behaviour of each relay implementation, and the measurements
  behind these statements, are held in the project's internal engineering
  records rather than here. They are operational detail, and this document's
  job is to state the limits accurately — which it does above — not to describe
  how to sit inside them.
- **Storage cap** (how much can be live at once, not how much has moved) —
  `overStorage` (`account/plan_enforce.go:328`) against the plan's
  `StorageBytes`, enforced atomically at persist time in
  `CreateStoredFileWithinStorageCaps` so concurrent uploads can't collectively
  bust it (`account/plan_enforce.go:396`, `persistStoredFile`).
  Exceeding it: `413` "storage limit reached."
- **Global disk cap** — a deployment-wide ceiling across all users
  (`SettingStorageDiskCap`, `account/plan_enforce.go:357`), independent
  of any one plan. Exceeding it: `507` "server storage is full."
- **Retention (TTL) and download-count limits** — every stored file gets an
  expiry and/or a max-download count resolved from the request plus admin
  defaults (`account/settings.go:132-167`, `resolveRetention`/`clampTTL`),
  further capped by the owner's plan retention ceiling if lower
  (`account/plan_enforce.go:311`, `planRetentionCap`). A file is deleted —
  ciphertext and row both — once either limit is hit; see
  [Retention](#retention-how-long-anything-is-kept).

Own-node (self-hosted, BYO) uploads and relay are exempt from every cap above
except the file's own retention/download-count settings — they land on the
user's own infrastructure, which the operator (not relayium.com) pays for.

Users can see exactly what they've used against their own cap at
`GET /api/me/usage` (`account/handlers.go:515`, `handleMeUsage`) — the same
numbers this document describes, not a hidden internal metric.

## The free tier, and what needs no account at all

**Same-LAN realtime transfers need no account, ever, and no allowance.** `handleICE` only
withholds relay credentials for an invalid/unattributable pairing code
(`account/turn.go:71-73`); a same-public-IP transfer never calls that
endpoint at all — the two browsers find each other in the in-memory
signaling hub and negotiate a DataChannel directly.

**A cross-network browser transfer is always relayed, and therefore always
metered** — this document used to claim that STUN alone might connect the two
peers so that no TURN credential was consumed. The browser never tries that:
`chooseRtcConfig` forces `iceTransportPolicy: "relay"` whenever a relay is in
the list, so a cross-network browser session is relayed and metered from the
start. Obtaining a pairing code therefore requires the sender to be signed in
for two reasons rather than one — attribution and abuse control (rate limits,
email verification) **and** the relay bytes it is about to spend
(`account/turn.go:63-135` issues the credentials once the code clears those
gates).

**Metered is not the same as paid.** What the gate actually checks is a
verified email and *remaining allowance*, not a subscription:
`s.trafficAllowanceSpent` (`account/plan_enforce.go:165`) withholds the TURN
credential only once the month's traffic is exhausted. Free is a plan with an
allowance like any other, so a signed-in Free account relays cross-network
transfers until that allowance runs out and pays nothing. Paying is what you
do when you want a bigger one.

The cross-network paths that consume no relay allowance at all are the CLI's
**direct** modes — `send`/`receive`, `text`, `push`/`pull`/`sync` over your own
SSH, and daemon-direct — which never ask for a relay. `relayium up` and
`relayium down` are cross-network too, but they are hosted rather than direct,
so they draw on the same limits a browser stored link does.

**What actually reaches a limit on the Free tier**, in the plan table's own
four dimensions: monthly traffic (hosted upload + hosted download + billable
relay, together) beyond the Free cap; storage held live at once beyond the Free
cap; wanting a stored file to outlive the Free retention window; or needing a
bigger rolling daily upload allowance. Those four are the only levers — there
is no separate "download fee" and no per-transfer charge; it is flat monthly
tiers via Stripe Checkout/subscription (`account/billing.go:18-22`,
`handleBillingCheckout`). The current numbers for each are the plan table
above, which an admin can edit live.

## Retention: how long anything is kept

`account/gc.go`'s `GC.sweep` (`account/gc.go:127`) runs every 10 minutes
(`main.go:1000`) and is the only thing that prunes any of this **on a clock**.
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
| Upload `Idempotency-Key` records (`upload_operations`) | While their file exists, then at least 24 hours after a sweep first finds the file gone (so a late retry still hears `410`); deleted with the account at a deletion request | `uploadOperationGoneRetention` (`account/sqlite.go:5818`), in the same prune as `upload_events` |
| Download-receipt dedup rows | 24 hours | `receiptRetention`, `account/gc.go:17`, applied at `account/gc.go:135` |
| Admin audit trail (`admin_audit`) | 2 years by default, admin-overridable (`-audit-retention-days` / `RELAYIUM_AUDIT_RETENTION_DAYS`, `main.go:350`) | `auditRetentionDefault`, `account/gc.go:64`, applied at `account/gc.go:169` |
| Monthly relay/traffic history (`usage_events`, `usage_periods`, `usage_monthly`) | **Not pruned by age at all** while the account is active — this is the billing history the quota math depends on | No prune call for these tables exists in `GC.sweep`; confirmed by reading the full sweep function |
| Abandoned chunked-upload session + its partial ciphertext (`upload_sessions`) | 1 hour idle, then the blob is re-read and the bytes it holds are billed. Only once that bill is recorded does one transaction remove the row and hand the partial blob to the durable pending-delete queue; the blob itself is deleted by the next GC sweep (every 10 minutes), which keeps retrying until the node accepts the delete — the reaper never deletes a blob itself. **Unreachable-node exception:** the row and partial blob are kept for as long as it takes, because the blob is the only exact byte count; it is re-probed hourly and settled when the node answers. **An upload that never became a stored object is billed for what its blob physically holds before the blob is deleted, capped at its authorized size, whether it was abandoned, refused at finalize, or its finalize crashed. This applies to uploads started after this change. Uploads already in progress when it was deployed keep the rules they started under: when such an upload is abandoned, refused at finalize, or its finalize crashed, only its acknowledged bytes are billed; if it belongs to a pairing room that ends, the room's existing rule still applies, and what its blob holds is billed, capped at its authorized size. Bytes a late append left past a completed object's size are never billed.** **Account-deletion exception:** an explicit deletion request overrides that evidence hold, removes the user-attributed row immediately, and deletes or queues deletion of the partial blob, and any residual not yet measured is forgiven | `ReapPendingUploads` / `claimUploadCleanup` / `recoverUnresolvedUploads` + `upload_sessions.unresolved_at`, `account/uploads_resumable.go`; `GC.drainPending`, `account/gc.go`; `PurgeTransientUserData`, `account/sqlite.go` |
| A pre-upload's session + partial ciphertext when its **pairing room times out** | Not 1 hour — the room's own deadline. Voiding a room ends every artifact bound to it in one transaction: the finalized objects' rows and the unfinished uploads' sessions are deleted, the bytes each session had recorded are billed, and every blob gets a durable delete intent. For a billable upload that intent also carries the obligation to bill anything its blob holds beyond the recorded bytes (capped at the upload's authorized size) before the blob may be deleted. At that commit the ciphertext is unreachable and storage and the account's open-session budget are free. The bytes themselves are then deleted best-effort in the same pass, each partial blob only after it has been re-read and any extra bytes billed durably — to the meter, or to an owed-bill record GC settles later, never twice; anything not deleted there stays queued and GC retries it every sweep. An append that was already streaming when the room ended and lands afterwards is billed and deleted under the same rule, whether or not the append itself succeeded. **Two cases keep unreachable, unlisted ciphertext on the node past the deadline:** if the node cannot be reached, its blob can be neither sized nor deleted, so it stays queued and GC asks again each sweep, billing the extra bytes when the node answers and then deleting; and if the database refuses every billing write, the blob is kept as the only evidence of the bill until GC can record it, then deleted. No timer writes the extra bytes off; only an operator permanently deleting that node discards its queued deletions and any bill still riding on them | `Service.voidPairRoom` / `settleReclaimedUpload` + `Store.ClosePairRoom`, `account/pairroom.go`, `account/sqlite_pairroom.go`; `settleAppendIntoAVoidedRoom`, `account/uploads_resumable.go`; `GC.drainPending`, `account/gc.go` |
| A pre-upload's finalized ciphertext once **somebody has joined that pairing room** | **No timer at all, and that is deliberate** (`account/pairroom.go` invariant 5): a joined transfer is never cut off by a clock, so nothing ages this out — not GC, not a plan retention cap, not a fallback expiry. It leaves in exactly three ways, each of them somebody acting. **(1) The receiver completes it:** it proves it holds the file key, and the authoritative row is deleted in the same transaction that queues the blob's durable delete intent, so the storage is released at commit rather than at the next sweep. **(2) The owning account releases the whole room** from its own list — this is the exit that always exists, because a receiver whose browser hands the bytes to a download rather than writing them itself can never complete. Release first refuses a room with any upload session still bound; otherwise the object rows are deleted, delete intents are queued, and quota is free when the transaction commits. **(3) The account is deleted.** Bytes already uploaded stay billed in all three cases — traffic is metered per committed append, and releasing storage is not a traffic refund. Pre-upload is off by default (`-enable-preupload`), so on a default deployment no such object exists | `Store.CompletePairRoomObject`, `account/pairroom_complete.go`; `Service.releasePairRoom` + `Store.CloseOwnedPairRoom` (`GET /api/pair-rooms`, `DELETE /api/pair-rooms/{id}`), `account/pairroom_owner.go`, `account/sqlite_pairroom.go` |
| Account + all of the above, on deletion | A grace period after a self-deletion request (`-account-grace-days` / `RELAYIUM_ACCOUNT_GRACE_DAYS`, default 30 days, `main.go:338`), then hard-purged | `ArchiveAndPurgeUser`, `account/sqlite.go:3058` |

**What "hard-purged" actually does**, read directly from
`ArchiveAndPurgeUser` (`account/sqlite.go:3007-3212`): the user's monthly
stored-transfer totals are folded into `usage_archive` — **period totals
only, with no user ID retained** (`sqlite.go:3032-3036`) — and then every
user-linked row (sessions, devices, identities, Device Inbox tasks,
`usage_events`, `usage_periods`, `stored_files`, `upload_sessions`,
`pair_rooms`, `upload_events`, `user_stats`, `usage_monthly`, per-provider
subscription sources, attributable Apple notification records, tokens, CLI
device-authorisation requests, owned nodes) is deleted before the `users` row
itself. The comment at `sqlite.go:3051-3056` is explicit that leaving
`usage_periods` behind would "retain user-attributed relay history
indefinitely after the hard purge" and calls that out as contradicting the
stated model — so it's deleted too, not just anonymized. The purge is
guarded so a reactivation during the grace window aborts it entirely
(`sqlite.go:3198-3209`).

One place the code is honestly conservative rather than aggressive:
`PruneAudit`'s age-based deletion is **not** scoped to machine-written rows
— a short `-audit-retention-days` value would also delete the human admin
trail, which is by design (see the two-year default's rationale comment,
`account/gc.go:23-52`) meant to survive long enough for an incident
discovered months later to still have evidence attached to it.

## Self-hosted vs. relayium.com

Everything above is what the code *can* do; what actually runs depends on
which flags a given deployment sets (`main.go`):

- **coturn relay metering** is off in every deployment. `-redis-addr` /
  `RELAYIUM_REDIS_ADDR` (`main.go:285`) no longer starts anything:
  `guardCoturnRedisMetering` (`main.go:1255`) only logs a warning, so the
  metering worker never starts and coturn-relayed bytes are never ingested or
  attributed to anyone, full stop.
- **TURN relay itself** is off unless `-turn-secret` /
  `RELAYIUM_TURN_SECRET` is set (`main.go:281`) — without it there's simply no
  relay to meter. What still works is LAN browser transfers and the direct-only
  CLI; cross-network browser transfers do not, because the relay they depend on
  is the thing that is switched off.
- **Billing (Stripe)** is entirely off unless `-stripe-secret-key` /
  `RELAYIUM_STRIPE_SECRET_KEY` is set (`main.go:355`); every
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
