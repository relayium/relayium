# Native relay pool — nearest-relay selection on macOS — design

The fleet runs six coturn instances across France, China, the US and Canada.
`/api/ice` already offers all of them. The macOS client uses one.

## What exists today

`GET /api/ice?code=<live code>` returns two things:

```json
{
  "iceServers": [ {"urls": ["stun:relayium.com:3478"]},
                  {"urls": ["turn:relayium.com:3478", "turn:relayium.com:3478?transport=tcp"], ...} ],
  "relays": [ {"id": "2f0f1193…", "iceServers": [{"urls": ["turn:38.49.38.47:3478"], ...}]},
              … six more … ]
}
```

`iceServers` is the legacy single relay, in Frankfurt. `relays` is the pool,
each entry carrying its own ephemeral credential so a client can measure it.

**`ICEClient` decodes `relays` away on purpose** — the omission is documented at
the foot of `Account/ICEClient.swift`, and R1-G3 listed the pool as explicitly
out of scope. So a Mac in Shanghai relays through Frankfurt while a node sits in
Beijing, and cannot even tell.

The web client has used the pool since it was built. This round brings the Mac
to parity, against the same algorithm, so the two converge on the same relay
when they are each other's peer.

## The web's algorithm, which this copies

`web/src/lib/ice.ts` and `web/src/App.svelte`:

1. **Measure.** For each pool entry, open an `RTCPeerConnection` with only that
   entry's `iceServers` and `iceTransportPolicy: "relay"`, then time from
   `setLocalDescription` to the first `typ relay` candidate. That is the TURN
   Allocate round trip. 4 s timeout; a relay that does not answer is dropped.
   The absolute number carries fixed overhead, but it is the same overhead for
   every relay, so comparison is valid.

2. **Exchange.** Send `{"relayRtt": {"<id>": <ms>, …}}` to the peer over the
   signalling `signal` envelope. Broadcast on measure-completion and on
   peer-join; **never** in reply to a received map, which is what keeps it from
   ping-ponging.

3. **Choose.** `pickRelay(mine, theirs)` takes the relays *both* peers measured
   and minimises the **worse** of the two RTTs, then the sum, then the id
   lexicographically.

The third step is the load-bearing one, and the property that matters is not
"it picks a good relay" but that it is **symmetric**: fed `(mine, theirs)` on
one side and `(theirs, mine)` on the other it returns the same id. That is what
lets both peers arrive at the same relay with no negotiation round — they
exchange data, not proposals.

## Decisions

### Relay-only transport, matching the web

The web forces `iceTransportPolicy: "relay"` on the cross-network path, because
ICE otherwise spends ~20 s failing direct candidate checks before falling back
to the relay it was always going to use.

**Decision: the Mac does the same.** This is a real trade — it means never using
a peer-to-peer path even where one exists, and every byte crosses our
infrastructure. It is taken on evidence: the one cross-network attempt made on
2026-07-28 did not establish a direct path (relay allocations made, zero bytes
carried). Until the hole-punching success rate is actually known, a connection
that is fast and predictable beats one that might be free.

It also makes the pool worth having: choosing the nearest relay only matters if
a relay is being used.

Revisit when there is data. A design that raced direct against relay, or tried
direct first and fell back on a deadline, is strictly better if direct succeeds
often — and strictly more complexity if it does not.

### Measure early, then wait briefly

The web is a long-lived page in a room: measurement runs in the background from
join, and a transfer starts much later, so the choice is always ready. The Mac's
Direct flow has no such window —

- the **sender** mints a code and waits for a peer, which is a genuine window
  and costs nothing to use;
- the **receiver** types a code and usually finds the peer already there, so it
  has almost none.

**Decision: both sides start measuring the moment signalling connects, and the
connection waits up to `relayChoiceDeadline` for convergence before it is
built.** The measurements run in parallel, so the deadline governs, not the
sum.

`relayChoiceDeadline` is **800 ms, and that number has no evidence behind it** —
nobody has measured this fleet's RTTs from a real client. It is a named constant
for exactly that reason. The first real cross-network transfer produces the
number that should replace it.

### The pool is an optimisation, never a requirement

Every failure path falls back to today's behaviour — the legacy `iceServers`:

| Situation | Result |
|---|---|
| No pool (LAN room, no code) | Path skipped entirely; behaviour identical to today |
| A relay does not answer | Dropped from the map; the rest still compete |
| No relay measured by both | `pick` returns nil → fall back |
| Deadline elapses first | Best-so-far, possibly nil → fall back |
| **Peer is an older client** | It sends no map; ours stays one-sided; `pick` returns nil → fall back |

The last row is the one to keep: a Mac on this round talking to a Mac on the
previous one must still transfer. Interop degrades to the current behaviour and
never breaks.

### What a relay mismatch actually costs

Two peers relaying through **different** TURN servers do connect. Both sides
gather a relay candidate; TURN permissions are IP-scoped and installed via
`CreatePermission` for every remote candidate; there is no NAT between two
public TURN servers; and this fleet's coturn config denies only bogon and
private ranges, so the pool's own public IPs are permitted. Per-client
nearest-relay assignment is how every commercial TURN provider operates.

The cost is a second hop, and — the part that actually matters — roughly **2x
metered relay bandwidth**, because every byte crosses two of our coturn
instances and counts against both the per-node cap and the code owner's quota.

So converging still matters, just not for correctness: it is a
bandwidth-and-latency argument. A session where the two peers disagree, or
where one falls back to the legacy relay, is degraded and not broken — which is
what makes every row of the table above an acceptable outcome rather than a
failure.

Earlier drafts of this document, and the comment at the head of
`RelayChoice.swift`, asserted the opposite: that a mismatch "does not degrade
gracefully" and that the connection "fails looking like a network fault". That
was wrong, and it mattered, because it made every trade-off in this design look
like a correctness risk. Keeping it honest: no real cross-peer transfer has been
run either way, so the claim above is reasoning from the protocol and the
fleet's configuration, not from a measurement.

## Components

Split along one line — whether a unit can be tested without WebRTC:

| Unit | Responsibility | Testable |
|---|---|---|
| `RelayChoice.pick(mine:theirs:)` | The symmetric selection, line-for-line with the web | Pure; fully |
| `RelayRttMessage` | Encode/decode `{relayRtt: …}` on the signal envelope | Fully |
| `RelayNegotiator` | Holds both maps, sends and receives over signalling, exposes `waitForChoice(deadline:)` | Fully, with `FakeWebSocketChannel` |
| `RelayProbe` | Times one relay's Allocate round trip | **No** — needs live WebRTC |

The split is deliberate. Every *decision* lives in the first three; `RelayProbe`
is left holding only a stopwatch and no branches. R1-G3's acceptance found three
defects that no unit test could have caught, all of them in code that only a
real peer connection reaches — so the useful move is to shrink that region
rather than to test around it.

## Data flow

```
signalling connects
  ├── sender:   shows the code, waits for a peer   ← measurement runs here
  └── receiver: waits for firstPeer (often instant) ← short window, parallel probes
          │
   six relays probed concurrently, relay-only, first `typ relay` candidate wins
          │
   own map ready ──► broadcast {relayRtt: …}
   peer's map arrives ──► re-run pick  (no reply: that is the ping-pong guard)
          │
   peer appears ──► wait ≤ relayChoiceDeadline for a choice
          │
   chosen  ──► RealtimeConnection(iceServers: chosen.iceServers, policy: .relay)
   none    ──► RealtimeConnection(iceServers: advertised)          (today's behaviour)
```

## Changes to existing code

- `Account/ICEClient.swift` — `fetch` returns an `ICEConfig { iceServers,
  relays }` instead of a bare `[ICEServerConfig]`. The explanatory comment at
  the foot of the file is replaced by the implementation it was explaining.
- `Realtime/RealtimeConnection.swift` — `init` gains an `iceTransportPolicy`.
- `RelayiumAppKit/RealtimeConnectionFactory.swift` — orchestrates probe start,
  the exchange, and the bounded wait.
- `RealtimeSessionModel` — its `makeConnection` closure widens from
  `[ICEServerConfig]` to the whole `ICEConfig`, because the model is the one
  that calls `iceClient.fetch` and hands the result on. It gains no *decision*:
  which relay wins is settled below it, and the model's tests do not change
  beyond the type. Naming this is the point — an earlier draft of this document
  claimed the model was untouched, which was wrong, and a "no change here" that
  turns out to be a change is how a plan's task list quietly loses a step.
- `Signaling/SignalingClient.swift` — no change. `sendSignal(to:data:)` and
  `onSignal` already carry arbitrary JSON.

## Testing

**`pick`** takes the web's `ice.test.ts` cases plus a symmetry property test:
for generated pairs of maps, `pick(a, b) == pick(b, a)`. Symmetry is the whole
basis of "no negotiation"; if it stops holding, the two peers pick different
relays — see below for what that costs.

**`RelayNegotiator`** is driven through a fake channel: a peer map arriving
re-derives the choice; an older peer that never sends one leaves the fallback in
place; the deadline returns the best available rather than hanging.

**`RelayProbe`** gets no unit test and the code says so. Its correctness is
"does the stopwatch start and stop in the right places", which only a live
allocation demonstrates.

## Acceptance

- `swift test` passes, including the symmetry property.
- A cross-network transfer between two real peers still completes. **This is the
  one that matters and the one that has not been run for R1-G3 either** — see
  that round's Task 11 record.
- With the peer on a build without this change, the transfer still completes
  (fallback path).
- The chosen relay id, and both RTT maps, are logged once per session so the
  800 ms constant can be replaced with a measured value.

## Non-goals

- **Racing direct against relay.** See the relay-only decision; revisit with
  data.
- **Re-measuring during a transfer.** The choice is made once per session. A
  relay that degrades mid-transfer is a resume problem, not a selection one.
- **Persisting measurements between sessions.** Tempting, and wrong at this
  stage: a cached RTT from a different network is worse than no cache, and the
  measurement is cheap and parallel.
- **The duplicate `us-chi` pool entry.** `/api/ice` currently advertises both
  `us-chi` and node `9eebb2ef…` pointing at `192.3.116.43`, so that relay is
  measured twice. Harmless — it costs one extra probe and the two entries tie —
  and it is a server-side data cleanup, not part of this round.
