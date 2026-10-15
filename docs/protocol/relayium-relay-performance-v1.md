# Relay performance v1 — throughput-informed relay agreement

Status: Web implementation (first client). Windows (shares the Web library but has
not opted in), RelayiumKit/Swift, the Go CLI and Android are pending ports and today
behave as legacy peers. Shared vectors: `contracts/relay-performance-v1.json`.

## 1. Problem

Two peers in a pairing-code room agree on one TURN relay by exchanging the time each
took to allocate on every pool relay (`relayRtt`, see `relayium-link-v1.md`) and
running the symmetric `pickRelay`: lowest worse-leg, then sum, then id. That is a
setup-latency order. It cannot see that the nearest relay may be the one that moves
a file slowest — 20 ms at 2 Mbit/s loses to 200 ms at 100 Mbit/s by minutes on a
64 MiB file.

v1 adds the second signal a file transfer experiences: goodput both peers have
**observed on completed transfers** through each relay. Nothing is probed and no
extra relayed byte is sent; the evidence is a by-product of transfers that happened
anyway.

## 2. Wire format

A sibling key in the **same** signalling `signal` object as `relayRtt`, so a peer can
never weigh one map against a stale copy of the other:

```json
{"relayRtt": {"n1": 20, "n2": 200},
 "relayPerf": {"v": 1, "policy": "bulk", "ref": 33554432,
               "k": {"n1": 2000, "n2": 100000},
               "u": {"n1": 2400, "n2": 120000}}}
```

| Field | Rule |
|---|---|
| `v` | Exactly `1`. |
| `policy` | Exactly `"bulk"`: rank for bulk file transfer. |
| `ref` | Exactly `33554432` (32 MiB), the reference payload the policy predicts. |
| `k` | Published evidence. Object (not array), at most 32 entries — over the cap the WHOLE declaration is rejected. Keys: relay ids, 1..64 chars. Values: kbit/s, finite, `1..10000000`, floored; a bad entry is dropped individually. Ids not in the receiver's own pool are ignored. |
| `u` | **Required.** The sender's upper bound on any `k` value it can publish in this room, for every pool relay it holds confident history for, sent complete from its FIRST envelope and unchanged for the room. Same shape and limits as `k`. A relay absent from `u` will never get a `k` entry from this sender. The receiver clamps each `k` entry to `u` and drops `k` entries with no `u` entry. |

Unknown extra fields are ignored. `{"v":1,"policy":"bulk","ref":33554432,"k":{},"u":{}}`
declares support with no evidence and is sent by a client with an empty history.

The first internal batch sent declarations without `u`; it never
shipped, and such a declaration is now simply invalid (that peer is treated as legacy).
Clients without this Web implementation remain legacy peers.

A sender publishes `k` entries only for relays whose own probe has answered in this
room, and only when its local history is confident and consistent with that fresh
round trip (§4), so the entry grows in the same envelopes as the RTT it was judged
against.

### Activation

Goodput ranking is in force only while this client participates AND every peer whose
RTT map it holds declared exactly v1/`bulk`/`ref` in its **latest** envelope. A newer
envelope without a valid declaration — or with any other version, policy or reference
— demotes that peer to legacy at once. Object presence alone, a declaration from a
previous room, or a declaration not accompanied by a valid `relayRtt` map never
activates anything. Room switches (`reset`/`suspend`) forget all evidence and
declarations. A legacy client reads `relayRtt` and ignores the sibling key
(Web `parseRelayRtt`, Swift `RelayRttMessage.decode`, Go `linksession` discovery,
Android `CliPeerSignal`), so both sides fall back to the unchanged legacy order and
the unchanged 5 s peer grace.

## 3. Choice

`L = pickRelay(mine, theirs)` — the legacy winner. For a relay `x` common to both
RTT maps:

- `g(x)` = joint goodput: the smaller of the two peers' `k[x]` when both have one,
  the one that exists otherwise, absent when neither does.
- `predicted(x) = max(mine[x], theirs[x]) + ceil(ref·8 / g(x))` milliseconds.

`L` is displaced only by a challenger `c` with `g(L)` and `g(c)` both present and

```
predicted(c)·5 < predicted(L)·4   and   predicted(L) − predicted(c) ≥ 250 ms
```

Among qualifying challengers the lowest `predicted`, then `(worst, sum, id)` wins.
All arithmetic is integer; the rule is symmetric under swapping the peers. With no
evidence for `L`, or none for any challenger, the result is exactly `L`: there is no
assumed bandwidth for an unknown relay, and the first transfer through it is what
creates its evidence. No geography, no node load count, no allocation count is used.

**Honest trade-off.** The reference policy ranks for a 32 MiB transfer. A text
message or a tiny file is dominated by setup, where `L` is already right; the override
margin keeps `L` whenever the history-based saving is small, but a room that switches
to a far, fast relay pays that relay's extra connection setup latency (amortized when the connection is reused). This
is a bulk-file preference, not a claim that every message is faster.

## 4. Evidence (local history)

Recorded by each side for itself after a batch finishes **cleanly** — sent and
answered with COMPLETE, or received, verified, finalized and acknowledged — and never
for a declined, cancelled, failed, integrity-failed or gap-interrupted (resumed)
batch, nor across a room switch. A sample is attributed to a relay only when the
connection's selected candidate pair has a local `relay` candidate whose TURN server
URL belongs to exactly one entry of this room's pool, and that entry is a relay this
room built a connection on by agreement. Pool-fallback builds, direct paths and
unreadable stats record nothing.

Goodput = plaintext batch bytes ÷ wall time from consent to COMPLETE. It includes
both devices' encryption and the receiver's disk as well as the network: it is an
observed end-to-end transfer goodput hint, never a relay capacity measurement.
Network-ACK waits are NOT excluded as "disk"; credit-window, buffer-drain and
finalize times are kept separately as local diagnostics.

Stored locally (Web: `localStorage["relayium.relayPerf.v1"]`), at most 30 entries,
only records from the past 24 h are used. Expired records are removed from storage
on the next history creation or use (a closed browser cannot run expiry):
`[hmac16, transport, netClass, minute, kbpsStep, volumeBucket, rttMs]` — the first 8
bytes of HMAC-SHA256 over the relay id under a random local 32-byte salt; the relay
transport (`udp`/`tcp`/`tls`/`unknown`); a coarse network class (`navigator.connection.type`
or `unknown`); goodput in eighth-octave steps; `floor(log2(bytes))`; this side's probe
round trip, 5 ms grain. No raw relay id, peer id, IP, network name, file name, size,
hash, key or content. Storage failure degrades to an in-memory history.

Qualifying sample: ≥ 8 MiB and ≥ 200 ms. Confident: ≥ 2 samples, or one ≥ 32 MiB.
Only samples on the same network class whose recorded round trip is within
`max(100 ms, recorded)` of the current probe count. Estimate = lower quartile.

Upper bound (`u`): the MAXIMUM row of all samples for that relay and network class, when
those samples are confident. A lower quartile of any round-trip-selected subset never
exceeds that subset's maximum, which never exceeds the whole set's (a quartile of all rows
would NOT be a bound: slow rows from another vantage point pull it far below what a later
round trip selects). The client takes these bounds once when the room's pool arrives and
clamps every value it later publishes to them — so a transfer finishing elsewhere or a
network change mid-room can never make a declared bound false (it can only lower or drop
a published value).
A browser network change (`connection` change, `online`/`offline`) makes all earlier
evidence non-confident for the rest of the page.

## 5. When a room may build (first-build agreement)

What must agree is each peer's FIRST connection build — the read taken inside the gate's
`whenReady` callback — not merely the final maps. The legacy early release looks only at
OUR unanswered probes, and also releases once our own measurement has finished. Under the
goodput score both are unsound: the peer's round trip and evidence for a relay arrive
together in its envelope, and until they do they can move the choice. (Root's executable
counterexamples: with A knowing near only and B knowing near and far, A built near at 41 ms
while B built far at 200 ms; with both knowing far, A built near at 200 ms one envelope
before B built far. In both the final maps agreed.)

Rule while goodput ranking decides (both peers declare v1, and some side declared any
bound in `u`). For every relay whose data is incomplete on EITHER side, replace each
unknown by its most favourable possible value:

- our unanswered round trip: at least the rounded elapsed probe time (the legacy anchor
  argument), else 0;
- the peer's unreported round trip: at least 0 — nothing bounds it;
- each side's evidence: its published value once that side has reported the relay
  (absent then means none, ever); before that, its upper bound (`u`; absent means none).
  The joint goodput is the min of two values or the single value, so its best case is the
  larger bound.

The relay is retired only if, with those values, it can neither become the legacy winner
(worse leg ≤ the legacy winner's, ties fall through) nor a qualifying challenger that beats
the current pick (§3 margin, and a cost ≤ the pick's). The room builds when every such
relay is retired. "Our measurement finished" is no longer a shortcut. Unknown capacity is
never scored as measured: these bounds only decide whether a relay can still win, never
which one does.

- **Cold rooms.** If neither side declared any bound, no override is possible, the pick is
  the legacy pick by construction, and the room keeps the legacy release rule exactly
  (same build times).
- **Grace.** The existing per-peer 5 s grace still bounds every wait. A relay that could
  still win but whose probe never answers (on either side) holds the room until the grace;
  a grace release builds on the current pick and has the legacy rule's split exposure.
- **Pre-existing legacy exposure, unchanged.** The legacy rule (old peers, Windows, no
  evidence) releases once our own probes finish even if a relay the peer has not reported
  is nearer than the pick for us. A randomised simulation shows this can split first builds
  under reordered envelopes. It is old behaviour, not changed here, and is recorded as a
  separate finding.

Cost: a goodput room may build later than the legacy rule would, while the peer's report
of a relay that could still matter is in flight — typically one probe plus one signalling
delay. It never waits on a relay that cannot change the pick.

## 6. What it never touches

Relay credentials, renewal and quota; the `onActivity`/`onUserActivity` lifetime and
renewal evidence (samples are observation only and renew nothing); room
authentication; DataChannel framing, ACKs, durability, nonces and COMPLETE ordering.
No active probes, no telemetry: evidence never leaves the device except as the `k` and `u`
numbers in §2, sent only to the peer in the same room.

## 7. Verification status

Logic: shared vectors (pick, parse, release) and a randomised soundness check of the
release rule against complete final worlds; the history bound is checked over random row
sets. First-build agreement: two real selections on one deterministic clock with reordered
envelopes, building from `takeChoice()` inside `whenReady`. Integration: Web selection/session/workspace tests. Controlled route:
local two-TURN fixture (see the task artifacts). Real fleet, WAN and device behaviour
are **not** verified by any of these.
