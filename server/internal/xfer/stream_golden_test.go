package xfer

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// U-G: every v1 Hello is byte-for-byte what ae2219cc9 (before the stream
// protocol existed) wrote. The hex below was produced by that commit's own
// wire.go, not written by hand; Stream is omitempty, so no released peer
// ever sees the new field.
func TestStreamGoldenV1HelloUnchanged(t *testing.T) {
	cases := []struct {
		h    Hello
		want string
	}{
		{Hello{Version: 1, Mode: "push"},
			"010000004b7b2256657273696f6e223a312c224d6f6465223a2270757368222c2253796e63223a66616c73652c2244656c657465223a66616c73652c22526573756d6550726f6f66223a66616c73657d"},
		{Hello{Version: 1, Mode: "push", Sync: true, Delete: true, ResumeProof: true},
			"01000000487b2256657273696f6e223a312c224d6f6465223a2270757368222c2253796e63223a747275652c2244656c657465223a747275652c22526573756d6550726f6f66223a747275657d"},
		{Hello{Version: 1, Mode: "pull"},
			"010000004b7b2256657273696f6e223a312c224d6f6465223a2270756c6c222c2253796e63223a66616c73652c2244656c657465223a66616c73652c22526573756d6550726f6f66223a66616c73657d"},
	}
	for _, c := range cases {
		var b bytes.Buffer
		if err := WriteJSON(&b, MsgHello, c.h); err != nil {
			t.Fatal(err)
		}
		if got := hex.EncodeToString(b.Bytes()); got != c.want {
			t.Fatalf("v1 Hello %+v changed on the wire:\n got %s\nwant %s", c.h, got, c.want)
		}
	}
}

// U-G2: the stream frames' type numbers, field names and field order, pinned
// with a fixed challenge.
func TestStreamGoldenFrames(t *testing.T) {
	const challenge = "000102030405060708090a0b0c0d0e0f"
	const sum = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	cases := []struct {
		name string
		t    MsgType
		v    any
		want string
	}{
		{"stream hello", MsgHello, Hello{Version: 1, Mode: "push", Stream: true},
			`{"Version":1,"Mode":"push","Sync":false,"Delete":false,"ResumeProof":false,"Stream":true}`},
		{"accept", MsgStreamAccept, StreamAccept{ChunkMax: StreamChunkMax}, `{"ChunkMax":1048576}`},
		{"end", MsgStreamEnd, StreamEnd{Size: 0, SHA256: sum, Challenge: challenge},
			`{"Size":0,"SHA256":"` + sum + `","Challenge":"` + challenge + `"}`},
		{"result", MsgStreamResult, StreamResult{Size: 0, SHA256: sum, Challenge: challenge},
			`{"Size":0,"SHA256":"` + sum + `","Challenge":"` + challenge + `"}`},
	}
	for _, c := range cases {
		var b bytes.Buffer
		if err := WriteJSON(&b, c.t, c.v); err != nil {
			t.Fatal(err)
		}
		want := frameBytes(c.t, []byte(c.want))
		if !bytes.Equal(b.Bytes(), want) {
			t.Fatalf("%s:\n got %q\nwant %q", c.name, b.Bytes(), want)
		}
	}
	if MsgStreamAccept != 9 || MsgStreamData != 10 || MsgStreamEnd != 11 || MsgStreamResult != 12 {
		t.Fatal("stream message types renumbered")
	}
	if StreamChunkMax != 1<<20 || StreamChallengeLen != 32 {
		t.Fatal("stream limits changed")
	}
	for code, want := range map[string]string{
		ErrCodeStreamNotAccepted: "stream_not_accepted", ErrCodeInvalidDestination: "invalid_destination",
		ErrCodeWriteFailed: "write_failed", ErrCodeProtocol: "protocol_error", ErrCodeDestinationExists: "destination_exists",
	} {
		if code != want {
			t.Fatalf("error code %q, want %q", code, want)
		}
	}
}
