package xfer

import (
	"bytes"
	"testing"
)

func TestFrameRoundtrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, MsgHello, []byte("hi")); err != nil {
		t.Fatalf("write: %v", err)
	}
	tp, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if tp != MsgHello || string(payload) != "hi" {
		t.Fatalf("got type=%d payload=%q", tp, payload)
	}
}

func TestJSONFrameRoundtrip(t *testing.T) {
	var buf bytes.Buffer
	in := Manifest{Files: []FileEntry{{Path: "a.txt", Size: 3, Mode: 0o644, ModTime: 111}}}
	if err := WriteJSON(&buf, MsgManifest, in); err != nil {
		t.Fatalf("write: %v", err)
	}
	var out Manifest
	tp, err := ReadJSON(&buf, &out)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if tp != MsgManifest || len(out.Files) != 1 || out.Files[0].Path != "a.txt" || out.Files[0].Size != 3 {
		t.Fatalf("roundtrip mismatch: %+v", out)
	}
}
