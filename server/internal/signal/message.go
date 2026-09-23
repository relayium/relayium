package signal

import "encoding/json"

const (
	TypeJoin    = "join"
	TypeWelcome = "welcome"
	TypePeers   = "peers"
	// TypeLeft is emitted by the server when one physical signaling connection
	// actually closes. Unlike a roster representative handoff, it is definitive
	// permission for clients to tear down sessions bound to that peer id.
	TypeLeft   = "left"
	TypeSignal = "signal"
	// TypeActivate says "this connection is now the page the user is looking
	// at". It carries no payload and can only ever affect the connection it
	// arrives on; see Hub.Activate.
	TypeActivate = "activate"
	// TypeICERenew asks the server for fresh relay credentials for the transfer
	// this connection is already part of. Data is exactly {round,rid}; see
	// RenewRequest and docs/protocol/relay-renew-v1.md §2.
	//
	// It carries no pairing code, by construction. The connection itself is the
	// capability: the server stamped its id and knows which room admitted it,
	// so nothing the client says decides who it is.
	TypeICERenew = "ice-renew"
	// TypeICEGrant is the reply. Data carries {status,round,rid} plus, when
	// granted, exactly the /api/ice configuration shape — one credential format
	// on the wire, one parser on every client.
	//
	// A single-sided request gets NO reply at all, and that is the protocol
	// rather than an omission: a server too old to know this type ignores it,
	// so clients already treat silence as "unavailable" and retry within their
	// own bounds. See grantCollectWindow.
	TypeICEGrant = "ice-grant"
)

// Envelope is every message on the wire, client<->server, in both directions.
//
// DeviceID/Active are client→server only and appear on join; a later
// TypeActivate frame carries no payload. They are never echoed to any peer:
// no roster entry ever carries an installation id, so one client can neither
// read nor confirm another's. (A roster entry is {id,name}, plus the
// server-validated Proto hint below when that peer sent one; see ProtoHint.)
type Envelope struct {
	Type  string          `json:"type"`
	From  string          `json:"from,omitempty"`  // server-stamped sender peer id
	To    string          `json:"to,omitempty"`    // target peer id for TypeSignal
	Name  string          `json:"name,omitempty"`  // device nickname on join / self on welcome
	IP    string          `json:"ip,omitempty"`    // server-observed public IP, self-only on welcome
	Peers []Peer          `json:"peers,omitempty"` // room roster on TypePeers
	Peer  string          `json:"peer,omitempty"`  // departed peer id on TypeLeft
	Data  json.RawMessage `json:"data,omitempty"`  // opaque WebRTC/crypto payload
	// DeviceID is an opaque per-installation presence key sent on join in the
	// code-less LAN room only. It groups one browser's tabs into one advertised
	// device. Optional: an older client omits it and stays a distinct peer.
	DeviceID string `json:"deviceId,omitempty"`
	// Active marks a join whose page is the current/focused one, so the very
	// first roster already routes to the right tab.
	Active bool `json:"active,omitempty"`
	// Proto is the link-pairing roster hint (relayium-signaling-v1 "Protocol
	// hint"). Client→server on join; server→client on welcome, as the echo that
	// tells the joiner this server understands hints. Pairing-code rooms only.
	// Decoding never fails on it: anything but a valid hint decodes as absent.
	Proto ProtoHint `json:"proto,omitempty"`
}

// deviceIDLen is the exact length of a valid installation id: 16 bytes of a
// client-side derivation, lower-case hex.
const deviceIDLen = 32

// ValidDeviceID accepts only the exact shape the client is specified to send.
// Anything else — wrong length, wrong case, non-hex, whitespace, control
// characters — is not sanitised into something usable but rejected outright, so
// an attacker-chosen string can never become a grouping key. A rejected id is
// treated as absent, which is the pre-existing (one peer, one device) behavior.
func ValidDeviceID(s string) bool {
	if len(s) != deviceIDLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

type Peer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Proto is the peer's validated join hint, if it sent one. `omitempty`, so
	// a peer that sent none keeps the exact {id,name} bytes older clients read.
	Proto ProtoHint `json:"proto,omitempty"`
}

// ProtoLink1 is the only protocol hint token the server currently knows. On a
// roster entry it means "this peer accepts a link hello as its first inbound
// frame and will announce link/1 itself". It is a hint, never a security input:
// every key is still derived from the peers' own commit-reveal.
const ProtoLink1 = "link/1"

// maxProtoTokens bounds the join hint array. A longer array is not truncated
// into something usable; it is treated as absent.
const maxProtoTokens = 4

// knownProtoTokens is the closed, canonically ordered set of tokens the server
// will carry. The server never echoes a string it does not know, so the hint
// cannot become a covert channel between peers.
var knownProtoTokens = [...]string{ProtoLink1}

// ProtoHint is a validated protocol hint: nil (absent) or a non-empty,
// duplicate-free list of known tokens in canonical order.
//
// Its decoder is deliberately total. Every malformed input — not an array, more
// than maxProtoTokens elements, a non-string element, an unknown or differently
// spelled token, an empty array, null — decodes to nil WITHOUT an error, the
// same fail-to-absent rule ValidDeviceID applies to deviceId. Returning an
// error instead would fail the whole envelope, turning a bad optional field
// into a dropped join that older servers (which ignore unknown fields) admit.
type ProtoHint []string

// UnmarshalJSON implements the total decoder described on ProtoHint.
func (p *ProtoHint) UnmarshalJSON(b []byte) error {
	*p = ParseProtoHint(b)
	return nil
}

// ParseProtoHint validates one JSON value as a join hint. See ProtoHint.
func ParseProtoHint(raw []byte) ProtoHint {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil || len(items) > maxProtoTokens {
		return nil
	}
	tokens := make([]string, 0, len(items))
	for _, item := range items {
		// A non-string element fails to decode into a string; `null` decodes
		// to "", which is not a token. Either way the hint is absent.
		var s string
		if err := json.Unmarshal(item, &s); err != nil {
			return nil
		}
		tokens = append(tokens, s)
	}
	return ProtoHint(tokens).Canonical()
}

// Canonical returns the hint the server may carry for p: nil unless p is a
// non-empty list of at most maxProtoTokens known tokens (byte-equal), in which
// case the known tokens it names, once each, in canonical order. The hub
// applies it to every hint it is handed, so a Go caller constructing a
// ProtoHint by hand cannot bypass the rule the wire decoder enforces.
func (p ProtoHint) Canonical() ProtoHint {
	if len(p) == 0 || len(p) > maxProtoTokens {
		return nil
	}
	var seen [len(knownProtoTokens)]bool
	for _, t := range p {
		known := false
		for i, k := range knownProtoTokens {
			if t == k {
				seen[i], known = true, true
				break
			}
		}
		if !known {
			return nil
		}
	}
	out := make(ProtoHint, 0, len(knownProtoTokens))
	for i, k := range knownProtoTokens {
		if seen[i] {
			out = append(out, k)
		}
	}
	return out
}

// Has reports whether the hint names token.
func (p ProtoHint) Has(token string) bool {
	for _, t := range p {
		if t == token {
			return true
		}
	}
	return false
}

func DecodeEnvelope(b []byte) (Envelope, error) {
	var e Envelope
	err := json.Unmarshal(b, &e)
	return e, err
}

func EncodeEnvelope(e Envelope) ([]byte, error) {
	// `omitempty` is useful for every other envelope, but a peers frame without
	// the array is ambiguous to older/native clients: they may treat it as "no
	// update" and retain a device that has left. Keep the field mandatory for
	// this message type, including the zero-peer case.
	if e.Type == TypePeers && len(e.Peers) == 0 {
		type wireEnvelope Envelope
		return json.Marshal(struct {
			wireEnvelope
			Peers []Peer `json:"peers"`
		}{wireEnvelope: wireEnvelope(e), Peers: []Peer{}})
	}
	return json.Marshal(e)
}
