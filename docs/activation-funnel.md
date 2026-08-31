# Privacy-preserving activation action totals

Relayium records three server-authoritative actions in the cross-network pairing path:

1. a pairing code was minted successfully;
2. the first socket was admitted to that live code's signaling-room generation; and
3. that room first transitioned to two admitted peers.

These totals answer a narrow product question: where does the pairing path stop working? They are
first-party, identifier-free, best-effort monthly lower-bound action counts. They are **not** unique
users, cohorts, or exact conversion rates. A displayed ratio divides same-month action totals and is
not cohort conversion.

## What is persisted

SQLite contains one additive `activation_funnel_monthly` table with exactly three columns:

| Column | Allowed value |
| --- | --- |
| `period` | UTC month in `YYYYMM` form |
| `stage` | `code_minted`, `room_opened`, or `room_paired` |
| `count` | nonnegative signed 64-bit integer, saturating at its maximum |

The `(period, stage)` pair is the primary key. The table is `STRICT` and `WITHOUT ROWID`; `CHECK`
constraints close both the month and stage vocabularies. Startup validates the existing table's
columns, constraints, strictness, and rowid absence, so a pre-existing lookalike schema fails closed.
Older databases acquire the table idempotently. Rolling back to an older server leaves the additive
table inert.

There are no event rows and no columns for an account, user, IP address, pairing code, internal room
generation, device, session, token, user agent, referrer, platform, locale, exact timestamp, content,
or arbitrary event name. The feature adds no telemetry endpoint, client SDK, cookie, browser storage,
or third-party service.

## Counting semantics

The signal registry owns two ephemeral flags on each live mint: `opened` and `paired`. It does not
import the account package or know about database stages. Reconnects and duplicate observations do
not increment a milestone again while that mint remains live. If the first accepted observation
already sees two peers, it returns both milestones so an earlier observation lost in process is
backfilled. Unknown, expired, malformed, stale-generation, rejected, and full-room joins do not count;
nor does a failed mint.

Each mint receives a fresh random internal room generation even if the same external six-digit code
is reissued after expiry. Old sockets therefore cannot meet new sockets, occupy the new room's two-peer
capacity, trigger its lifecycle, or contribute to its totals. The generation exists only in memory and
is never persisted or logged.

The admitted peer count is captured atomically with admission under the signaling hub lock. The
observer runs after that lock is released. The main process then enqueues fixed-stage writes to a
bounded in-memory channel without waiting for SQLite. This preserves the product action if storage is
slow or unavailable and keeps the join goroutine off the database path.

That fail-open design deliberately permits drops on queue saturation, process exit, or database
failure. The persisted result is consequently a **lower bound**, not a durable exactly-once total.
The in-memory flags prevent ordinary reconnect duplication but do not create a durable event ledger.
Failures log only a fixed stage or generic operation; logs never include a code, account, user, IP,
room generation, token, or other request value.

## Reading the totals

The administrator overview can select a UTC month and displays the three raw action totals. A ratio
is shown only when its denominator is nonzero. It is merely division of two monthly action totals:
milestones can fall in different UTC months, writes can be dropped, and no person or code is tracked
across stages. The UI therefore labels the figures as lower-bound actions and does not call a ratio a
conversion rate.

If the store cannot read the aggregate capability, the administrator page reports the data as
unavailable rather than silently substituting zero.

## Public disclosure

The maintained English and Chinese privacy-policy pages disclose these three Product Interaction
aggregates and their limited semantics. The macOS privacy manifest declares Product Interaction for
Analytics as unlinked and not used for tracking. The seven frozen website translations remain frozen;
they must be retranslated before a language is restored rather than silently edited now.
