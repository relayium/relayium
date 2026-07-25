# Relayium realtime flow-control v1 (authoritative)

Application-level flow control over the DataChannel (which exposes no receive-side
backpressure to the app). Bounds receiver memory and paces the sender to real
disk speed.

## Sender
- Track `sent` (frame bytes handed to the channel) and `acked` (latest ACK value).
- Do NOT send a frame while `sent - acked > FLOW_WINDOW` (8 MiB) — wait for an ACK
  that advances `acked`.
- Also respect the DataChannel's SCTP backpressure: wait while bufferedAmount is
  above the low threshold.

## Receiver
- After writing `written` cumulative durable bytes, send `ackFrame(written)` (KIND_ACK,
  Float64 BE) whenever `written - lastAckSent >= FLOW_ACK_INTERVAL` (512 KiB).
- ACKs are cumulative and monotonic; the sender ignores a stale (smaller) ACK.

## Constants
- FLOW_WINDOW = 8 MiB. FLOW_ACK_INTERVAL = 512 KiB. (transfer.ts.)

## Version safety
- There is no version field. A peer running an older wire sends a legacy frame
  kind (2/3), which the receiver rejects ("older version"), failing closed rather
  than falling back to a plaintext path.
