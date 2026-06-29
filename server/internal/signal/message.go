package signal

import "encoding/json"

const (
	TypeJoin    = "join"
	TypeWelcome = "welcome"
	TypePeers   = "peers"
	TypeSignal  = "signal"
)

// Envelope is every message on the wire, client<->server, in both directions.
type Envelope struct {
	Type  string          `json:"type"`
	From  string          `json:"from,omitempty"`  // server-stamped sender peer id
	To    string          `json:"to,omitempty"`    // target peer id for TypeSignal
	Name  string          `json:"name,omitempty"`  // device nickname on join / self on welcome
	IP    string          `json:"ip,omitempty"`    // server-observed public IP, self-only on welcome
	Peers []Peer          `json:"peers,omitempty"` // room roster on TypePeers
	Data  json.RawMessage `json:"data,omitempty"`  // opaque WebRTC/crypto payload
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
	return json.Marshal(e)
}
