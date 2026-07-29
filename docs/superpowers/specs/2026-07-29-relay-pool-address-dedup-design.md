# Relay pool: dedupe by address, not only by id

Date: 2026-07-29
Status: implemented

## Background

`/api/ice` hands the client a relay pool assembled from three sources, in this
order (`server/account/turn.go`):

1. the owner's own nodes — always included, free self-hosted relay;
2. online fleet nodes — skipped when the request is in strict mode;
3. statically configured relays from `RELAYIUM_TURN_RELAYS`.

The client measures RTT to every entry and both peers converge on the fastest id
they share.

The assembly already intends to avoid handing out the same relay twice. A `seen`
map guards sources 2 and 3, the block comment says *"Dynamic nodes win a shared
id"*, and source 3's skip is commented *"already-covered-by-a-dynamic-node"*.

**The intent is right and the key is wrong.** `seen` is keyed on the entry's
**id**. Two entries describing the same physical relay under different ids sail
straight through.

### Two ways that happens

**A static relay and a registered node sharing an address.** Observed in
production: one `RELAYIUM_TURN_RELAYS` entry and one registered fleet node point
at the same `turn:HOST:PORT`. Their ids differ — one is operator-chosen in JSON,
the other is the node's generated id — so source 3's `seen[rc.ID]` check cannot
see the collision, and the pool carries the same relay twice.

**Two node rows sharing an address.** A node's identity lives in `state.json`. A
node that loses it registers with a **fresh id**, while the old row stays in the
pool until its last heartbeat falls outside `nodeOnlineWindow` (90 s). For that
window the same machine is offered twice under two ids. Id-based dedup is blind
to this by construction.

The own-nodes loop (source 1) is a third case: it writes to `seen` but never
reads it, so two of one user's own node rows sharing an address are both emitted
regardless.

### Why it is worth fixing rather than cleaning up the data

Removing the duplicated static entry from `RELAYIUM_TURN_RELAYS` fixes today's
instance and leaves the trap armed — the second case above needs no
misconfiguration at all, only a node that lost its state file.

The cost is not merely cosmetic. The client probes every entry in the pool, so a
duplicate consumes a probe slot while measuring something already measured. The
macOS relay-pool round left `relayChoiceDeadline` at 800 ms against a 4 s
per-relay probe timeout, with its acceptance never run and the note that "one
unreachable relay in the pool plausibly disables the feature for both peers".
Spending a slot twice on one relay eats directly into a budget that has never
been measured.

## Design

Add a second dedup set keyed on **address**, consulted and written by all three
sources, in the existing order. Precedence is therefore unchanged: own nodes beat
fleet nodes beat static config — which is what the existing comments already
claim happens.

### The key is `host:port`, not the URL string

A TURN URL is `turn:host:port[?transport=…]` (or `turns:` on the TLS port).
Keying on the raw URL would treat `turn:H:3478` and `turn:H:3478?transport=tcp`
as two relays. A static `RELAYIUM_TURN_RELAYS` entry's `urls` array is
operator-written and may legitimately list both.

More fundamentally: what the client measures is the **machine**, not the URL. Two
spellings of one host:port are one RTT. `host:port` is the granularity that
matches what the duplicate actually costs.

**Why the scheme is not part of the key.** A reviewer proposed keying on
scheme-class plus `host:port` — i.e. treating `turn:H:P` and `turns:H:P` as
distinct — as cheap insurance against a dedup that could collapse TURN and
TURN-over-TLS onto one surviving entry, losing TLS reachability for whichever
side lost. That change was **not made**; the key stays plain `host:port`.
`turn:` defaults to port 3478 and `turns:` to port 5349, and a single port
cannot serve both plaintext TURN and TURN-over-TLS — coturn binds them on
separate listeners. So a genuine `turn:H:P` / `turns:H:P` pair sharing both the
same host **and** the same port is not physically realisable, and the reviewer
who raised the concern could not construct one. Since the collision this would
guard against does not occur, adding scheme to the key would only weaken the
dedup's ability to collapse the real duplicates it exists for, for no offsetting
benefit.

Note for anyone extending this: fleet nodes today report exactly one URL each —
`relay.go` builds a single `turn:IP:PORT`, UDP only. The transport variants live
in the legacy top-level `RELAYIUM_TURN_URLS`, which is not part of this pool.
So the transport case arises from static config, not from nodes.

### Normalisation rules

- Strip the scheme (`turn:` / `turns:`) and anything from `?` onward.
- A missing port takes the scheme's default: 3478 for `turn:`, 5349 for `turns:`.
- IPv6 literals arrive bracketed (`turn:[2001:db8::1]:3478`); the brackets are
  part of the host and the last colon outside them separates the port.
- Compare host case-insensitively. Do not resolve DNS — two names for one machine
  stay two entries, because resolving would make `/api/ice` depend on a
  network round trip on a request path that must stay fast.

### Within one source, the freshest row wins — and that is the right one

`OnlineNodes` and `UserNodes` both order `by last_seen_at DESC`, so when two rows
share an address the one heartbeating most recently is reached first and claims
it. In the lost-`state.json` case that is exactly the desired outcome: the live
re-registered node wins and the stale row — which will age out of
`nodeOnlineWindow` within 90 s anyway — is the one dropped. No extra ordering
logic is needed; it falls out of queries that already sort this way.

Rows with an identical `last_seen_at` tie arbitrarily. That is acceptable: they
are the same machine by address, so either choice hands the client the same relay.

### A candidate is skipped when *any* of its addresses is taken

A relay advertising several URLs is one machine. If one of its host:ports is
already claimed, the whole entry is a duplicate. Accepting it "for the URLs that
don't collide" would hand the client a second entry pointing at the same box —
the exact thing being fixed.

This rule assumes one entry describes one machine. Fleet nodes guarantee that —
the node agent emits exactly one URL per node. A static `RELAYIUM_TURN_RELAYS`
entry is operator-written, though, and could legitimately list URLs for **two
different hosts** in one entry's `urls` array. If a node happens to cover the
first host, the whole entry — including the second, otherwise-uncovered host —
is skipped, which is a narrow but real violation of this design's own "the
dedup must never shrink the pool". The code has no way to tell "two URLs, one
machine" from "two URLs, two machines" apart from trusting the input, so this
is not something the dedup can detect or fix; it is a property of
`RELAYIUM_TURN_RELAYS` to verify before deploying. A static entry that
genuinely spans two hosts (e.g. `198.51.100.1` and `198.51.100.2`) must be
configured as two separate entries, not one.

### Unparseable URLs fail open

If no `host:port` can be extracted from a URL, that URL claims nothing and forces
no skip; the entry stays in the pool. A parser that cannot read an unusual but
working URL must not be able to empty the relay pool — the same fail-open
principle the storage-reachability probe uses, and for the same reason: a
degraded guard should cost redundancy, never availability.

## Code shape

A new `server/account/relayaddr.go` holds the parsing and normalisation, with its
own test file. It has one job, is pure, and is fully testable without a request —
keeping it out of `turn.go` leaves the handler about assembly.

`turn.go` gains a `seenAddr` map beside `seen` and, in each of the three loops,
one guard and one claim. `seen` stays: it is still the right check for "this
exact id was already emitted", and it is what makes the strict-mode and
own-node precedence readable.

## Testing

Unit tests on the parser:

- `turn:H:3478` and `turn:H:3478?transport=tcp` normalise identically.
- `turn:H` normalises to `H:3478`; `turns:H` to `H:5349`.
- `turn:H:3479` and `turn:H:3478` do **not** collide — different ports are
  different relays.
- Bracketed IPv6 with and without a port.
- Host comparison is case-insensitive.
- Garbage input yields "no address" rather than a wrong one.

Tests on the assembly, driven through the existing `/api/ice` handler tests:

- A static entry whose address matches an online fleet node's: only the node
  appears, and it keeps the node's id and region.
- Two node rows sharing an address: exactly one entry, and it is the row with the
  more recent `last_seen_at` — the live re-registration, not the stale row.
- Two of one user's own nodes sharing an address: one entry.
- Distinct relays are all still emitted — the regression that matters most, since
  an over-eager dedup silently shrinks the pool.
- An entry whose URLs are unparseable is still emitted.
- Precedence unchanged: own node beats fleet node beats static config.

## Out of scope

- Removing the duplicated static entry from production's
  `RELAYIUM_TURN_RELAYS`. Once the pool dedupes correctly the duplicate is
  invisible, so cleaning it becomes housekeeping rather than a fix, and it is an
  edit to central's environment rather than to this repository.
- Any change to how the client chooses among the relays it is given.
