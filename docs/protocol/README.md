# Protocol document map

These are source contracts, not release or deployment records. Review date:
2026-10-20. Shared vectors and actual consumers define which peers speak a
capability; a document's `v1` filename is not an app version.

- Realtime: [crypto](relayium-crypto-v1.md), [handshake](relayium-handshake-v1.md),
  [wire](relayium-realtime-wire-v1.md), [flow](relayium-realtime-flow-v1.md),
  [shared link](relayium-link-v1.md), [ephemeral text](relayium-text-v1.md),
  [signaling](relayium-signaling-v1.md), [relay renewal](relay-renew-v1.md).
- Stored transfers: [stored wire](relayium-stored-wire-v1.md),
  [HTTP transport](relayium-cloud-transport-v1.md),
  [append durability](relayium-append-durability-v1.md),
  [Web slice control](relayium-transfer-control-v1.md),
  [pair rooms](relayium-pair-room-v1.md). Later opt-ins are documented in
  [upload pipeline](../upload-pipeline.md) and
  [native packing](../upload-chunk-tuning.md).
- Device Inbox: [v3](relayium-device-inbox-v3.md) is the accepted version;
  [v1](relayium-device-inbox-v1.md) and [v2](relayium-device-inbox-v2.md) retain
  vocabulary/bounds inherited by v3, not active downgrade protocols. See the
  [admission contract](../DEVICE-INBOX-ADMISSION-CONTRACT.md).
- [Relay performance](relayium-relay-performance-v1.md) has its own per-client
  participation contract. Shared `link/1` support does not imply that every
  client has ported this optimization.

The final section of the text contract describes the historical pinned-TLS CLI
adapter (v0.26.0 and earlier); current CLI shared-link interoperability is not
absent merely because that retained adapter is documented.
