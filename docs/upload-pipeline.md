# Ordered upload pipeline

Channel/status note (2026-10-20): pipelining shipped in macOS 1.4.10 and Android
0.3.2; iOS 0.5.2 internal TestFlight is a separate recorded channel. The later
[large-share packing preference](upload-chunk-tuning.md) is source-delivered,
with no backend deployment or new app release by that task. Request concurrency
and append limits below remain unchanged.

Fresh Share a link uploads can keep at most two ciphertext PATCH requests in
flight. Android 0.3.2 adds this capability to freshly initialized resumable Share
uploads, using its existing encrypted spool; restored sessions stay serial. The successor starts after the transport reports that its predecessor's
body was sent. This overlaps client ingress with storage confirmation; storage
still appends one contiguous prefix in order. It does not distribute file parts
across nodes or change the stored format.

## Negotiation and compatibility

Share session initialization and status advertise `uploadPipeline: "ordered-v1"`.
A participating PATCH sends `X-Relayium-Upload-Pipeline: ordered-v1` and the usual
Content-Range. Missing or unknown capabilities use the existing serial path.
Older clients need no changes. A mixed backend deployment may refuse a future
offset with its ordinary 409; the new client recovers against the same session.
Device Inbox, pair-room uploads and persisted native recovery plans keep their
existing serial behavior. Web background and capped-speed modes also keep their
existing pacing; changing the speed setting drains the pipeline before recovery.

## Server bounds

Only an authenticated, owned, open share session can wait for a future offset.
A current-offset request bypasses the waiting admission. One future waiter per
session per service observes the authoritative SQLite offset through commit
notifications and bounded polling, including commits made by another instance.
If a predecessor has already become current but has not released its waiting
slot, its successor can wait for that handover within the same queue budget.
Duplicates that are still genuinely future receive the ordinary gap response.

An eligible future body may be read into volatile ciphertext memory before its
offset becomes current. This is transport staging, not a durable acknowledgment.
Each service instance caps retained staging reservations at 64 MiB, including
buffers subsequently being forwarded to storage. A body is bounded by both the
existing 16 MiB append ceiling and the remaining session write cap. Known lengths
reserve length plus one byte; unknown lengths reserve the maximum plus one.
Oversize, truncated or failed reads are never handed to storage. Buffer references
are cleared before releasing their reservations, and close is idempotent.

Read-ahead requires at least an ordinary 8 MiB offset gap. An owned session gets
another read-ahead allowance only after its durable prefix reaches the previous
staged start, including when the previous staging was canceled. Admission metadata
is bounded to 4096 entries and expires after one hour. Resource exhaustion,
duplicate admission or a smaller gap keeps the bounded unread-wait behavior;
clients can recover serially. One waiting body and the current forwarded staged
body can coexist, both charged to the global memory budget.

All queuing shares a maximum 30-second wait allowance, excluding the bounded body
read. The original absolute 600-second request/context deadline is never extended.
A connection read deadline is cleared only after EOF was proved on the original
network body, including early returns after staging. Unread HTTP/1 bodies can
remain until progress or the wait bound exposes cancellation; current-offset
requests remain admissible during that wait.

## Ciphertext ownership and recovery

During ordinary pipelined sending, each client uses one ordered encryptor and
at most two packing buffers plus a cipher frame. Native partial-recovery tail
compaction can temporarily copy up to one chunk, as on its existing serial path;
transport-owned allocations are separate from this packing-buffer bound. A buffer remains owned until its request has terminated and its
whole ciphertext range is confirmed. A later cumulative acknowledgment cannot
release an earlier live network owner. Confirmed offsets remain monotonic and
cannot pass bytes handed to the transport.

A partial answer, refused gap or uncertain transport outcome drains owned
requests before reading the offset. The client retains and replays the original
ciphertext, content key and session; it never restarts encryption or creates a
replacement whole-file upload after negotiating this path. A late cumulative
answer may consume only retained, previously attempted ciphertext. User
cancellation joins requests and does not finalize. Finalization begins only after
all bytes are confirmed and every request owner has terminated.

Staging does not renew session lifetime or create a receipt. Existing append,
durability, accepted-byte settlement, quota checks and finalization remain the
accounting authorities. No database schema, quota, pricing, ledger, storage-node
protocol or blob format changes are required.

## Delivery and verification

Roll out the server capability before web/native clients. Removing the capability
makes subsequent fresh uploads serial; an already negotiated upload can receive
an ordinary gap and recover serially against its existing session. Native client
availability still requires its normal build, signing and distribution process.

Acceptance covers real HTTP/1 and HTTP/2 cancellation, queue handover, bounded
allocation and failed reads, another service's commit, lost/partial/reversed
answers, late callbacks, complete decryption and exactly-once byte metering.
Performance qualification should use a real browser through the streaming proxy,
a shared aggregate ingress limit, ordered confirmation delay and a zero-delay
control. Compare complete upload-to-finalize time. The benefit depends on how much
confirmation time overlaps ingress; concurrency does not multiply uplink capacity.
