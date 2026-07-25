# Relayium signaling protocol v1 (authoritative)

The WebSocket rendezvous that pairs two peers in a code room and relays their
opaque WebRTC/crypto payloads. Transport only — the SDP/ICE and commit-reveal SAS
handshake ride inside `data` and are defined by the realtime layer, not here.

## Connection
- `GET <wsBase>/ws?code=<urlencoded code>` upgraded to a WebSocket.
- Empty code → the LAN room; non-empty code → that code room. A pairing-code room
  holds exactly two peers; the LAN room holds up to a server cap (currently 50),
  so the `peers` roster there may list more than one other peer.

## Envelope (every frame, both directions), JSON:
{ "type": string, "from"?: string, "to"?: string, "name"?: string,
  "ip"?: string, "peers"?: [{"id":string,"name":string}], "data"?: <any JSON> }
- `type` ∈ { "join", "welcome", "peers", "signal" }.
- All fields except `type` are optional (Go omitempty).

## Sequence
1. On open, the client sends `{"type":"join","name":<device nickname>}`.
2. Server replies `{"type":"welcome","name":<this client's peer id>,"ip":<server-observed public IP or "">}`.
   (The self peer id is carried in `name` on welcome.)
3. Server sends `{"type":"peers","peers":[{id,name},…]}` — the current room roster,
   and again whenever it changes.
4. To signal a peer: `{"type":"signal","to":<peer id>,"data":<opaque JSON>}`.
   The server relays it to that peer and stamps `from` = the sender's peer id.
   The client never sets `from`.

## Robustness
- Inbound frames are untrusted: a malformed / non-object / non-JSON frame is
  dropped, never crashes the receive loop.
- Sending on a socket that is not OPEN is a no-op (best-effort); a lost frame is
  re-aligned by the join/welcome/peers exchange after reconnect.
- `data` is never interpreted by the signaling layer.
