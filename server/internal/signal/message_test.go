package signal

import (
	"encoding/json"
	"testing"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	in := Envelope{Type: TypeSignal, To: "peer-2", Data: []byte(`{"sdp":"x"}`)}
	b, err := EncodeEnvelope(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, err := DecodeEnvelope(b)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Type != TypeSignal || out.To != "peer-2" || string(out.Data) != `{"sdp":"x"}` {
		t.Fatalf("round trip mismatch: %+v", out)
	}
}

func TestDecodeRejectsInvalidJSON(t *testing.T) {
	if _, err := DecodeEnvelope([]byte("not json")); err == nil {
		t.Fatal("expected error on invalid JSON")
	}
}

func TestEncodeEmptyRosterKeepsPeersArray(t *testing.T) {
	b, err := EncodeEnvelope(Envelope{Type: TypePeers})
	if err != nil {
		t.Fatal(err)
	}
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(b, &frame); err != nil {
		t.Fatal(err)
	}
	peers, ok := frame["peers"]
	if !ok || string(peers) != "[]" {
		t.Fatalf("empty roster must be explicit on the wire, got %s", b)
	}
	if len(frame) != 2 {
		t.Fatalf("empty roster must not add unrelated fields, got %s", b)
	}
}
