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
)

// Envelope is every message on the wire, client<->server, in both directions.
//
// DeviceID/Active are client→server only and appear on join; a later
// TypeActivate frame carries no payload. They are never echoed to any peer:
// the roster stays {id,name},
// so one client can neither read nor confirm another's installation id.
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
