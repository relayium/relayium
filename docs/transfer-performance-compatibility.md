# Transfer performance and removable compatibility boundary

Status: phase 1 implementation, 2026-08-25. This document is the delivery
contract for the transfer-performance review. It does not raise a minimum client
version and does not authorize a macOS release.

## Compatibility rule

Performance work is classified before implementation:

1. A local execution change that preserves bytes, ordering, authentication,
   status semantics and API shape needs no capability. Old and new clients use
   the same wire. The current Web read-ahead and segmented decrypt queue, native
   incremental chain hash and bounded download buffering are in this class.
2. A server hardening change may reject a request that no released client emits,
   but must retain every released request shape. Account-file resume therefore
   continues to accept exactly `Range: bytes=N-`; unsupported explicit-end,
   suffix and multi-range forms fail with `416` before storage, metering or a
   limited-download claim.
3. Any future optimization that changes a frame, endpoint contract, ordering or
   acknowledgement rule is a new exact, versioned capability. It must not be
   inferred from app version or platform. One selector chooses either the new
   implementation or one named legacy adapter; feature code must not scatter
   version checks or fallback branches.

The shared capability contract is generated into
`web/src/lib/realtime-wire-vectors.json` and independently asserted by Web and
Swift. A new wire capability is not complete until those vectors cover new→new,
new→old, old→new, withdrawal/downgrade and unknown-capability behavior. This
phase adds no capability because it adds no wire behavior.

## Phase 1: coexistence

The following remain invariant while both macOS generations are supported:

- released clients can upload, download, resume and decrypt against the updated
  service;
- updated clients can use the currently deployed service and released peers;
- ciphertext, nonce sequence, chained hashes and durable completion rules are
  byte-for-byte unchanged;
- buffering is bounded without dropping authenticated bytes, and abandoning a
  native stream cancels its request;
- operational tuning changes transport buffering and connection reuse only; it
  does not change authorization, quotas, paid TURN policy or encryption;
- compatibility decisions may emit aggregate path/version counters, but never
  file names, plaintext, keys, tokens, pairing identifiers or download URLs.

Release acceptance requires focused and full Go, Web and Swift tests, shared
wire-vector regeneration with zero diff, macOS and iOS compilation, old/new
interoperability exercises, and exact deployed-config verification. A measured
stability window starts only after the new signed macOS version is available to
users; source merge or TestFlight upload is not stability evidence.

## Phase 2: minimum and removal

Phase 2 is a separate owner-approved task and writer lease. It starts only when:

1. the phase-1 macOS release is signed, published and stable for the selected
   observation window;
2. fallback use is zero for that window, or the owner explicitly accepts the
   measured remaining population and rollback consequence;
3. the release exists in the server's verified version/build catalog;
4. the revisioned server policy and signed release metadata can select the same
   minimum build, with fleet impact reviewed and audited;
5. rollback no longer requires a build below that minimum.

The cutover uses the existing `server/account/version_policy.go` policy and the
client's anti-replay/cached/embedded policy in `SupportedVersion.swift`; no
second version authority is introduced. After the minimum is live and observed,
one removal change deletes the named legacy adapter, its selector branch,
legacy-only metrics and old/new vectors. Contract tests then forbid the retired
capability or request shape from reappearing. Shared cryptography, storage formats
and rollback assets are retained unless their own migration has separately met
the same expand/observe/contract rule.

## Review disposition

The `kimi_reviews` reports were treated as hypotheses, not requirements.

- Implemented: bounded native response streaming, allocation-reduced native
  hashing, segmented Web decryption, one-chunk Web read-ahead, explicit invalid
  Range rejection, nginx response streaming/upstream reuse, and consistent
  `fq` queueing for future BBR TURN installs.
- Already present: pooled remote-storage clients, production file-descriptor
  limit, TLS session cache, resumable stored-wire framing, and the generated
  cross-language capability fixture.
- Rejected for this phase: blanket SQLite `synchronous=NORMAL` because the same
  database owns account, audit and billing durability; a heartbeat increase
  because it lengthens offline detection; duplicate nginx TLS configuration;
  and a lower file-descriptor limit than production already has.
- Deferred pending workload evidence and separate authorization: manual live
  sysctl/qdisc mutation, TURN bandwidth-policy changes, broader transfer
  concurrency, and any wire-format/chunk-size revision.
