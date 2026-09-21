package xfer

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// What a peer says when it refuses ends up on this machine's terminal, next to
// the SAS. RemoteError keeps the peer's words verbatim in its fields and makes
// them safe where they become display text.
func TestRemoteErrorTextCannotDriveTheTerminal(t *testing.T) {
	esc := string(rune(0x1b))
	for _, e := range []*RemoteError{
		{Code: "x", Msg: "no" + esc + "[2J\nverification code (SAS): 000000"},
		{Code: "co" + esc + "[1Ade\r"},
	} {
		got := e.Error()
		if strings.ContainsAny(got, esc+"\n\r") {
			t.Fatalf("control characters reached the message: %q", got)
		}
	}
	e := &RemoteError{Msg: "a" + esc}
	if e.Msg != "a"+esc {
		t.Fatal("the field must keep what the peer sent")
	}
}

// The collision refusal echoes the SENDER's manifest path on the receiver's
// terminal (and sends it back to the sender).
func TestDestinationExistsEchoesTheManifestPathSafely(t *testing.T) {
	esc := string(rune(0x1b))
	dst := t.TempDir()
	name := "a" + esc + "[2J.txt"
	m := Manifest{Files: []FileEntry{{Path: name, Size: 1}}}
	if err := writeFileForTest(dst, name); err != nil {
		t.Skipf("cannot create that name here: %v", err)
	}
	var in bytes.Buffer
	if err := WriteJSON(&in, MsgHello, Hello{Version: WireVersion}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&in, MsgManifest, m); err != nil {
		t.Fatal(err)
	}
	peer := &scriptedPeer{Reader: &in}
	_, err := Receive(peer, dst, RecvOpts{})
	if err == nil || !strings.Contains(err.Error(), "destination already exists") {
		t.Fatalf("err = %v, want the collision refusal", err)
	}
	if strings.Contains(err.Error(), esc) {
		t.Fatalf("the local error carries the escape: %q", err)
	}
	// …and the frame sent back says the same thing, equally safely.
	_, payload, rerr := ReadFrame(&peer.out)
	if rerr != nil {
		t.Fatal(rerr)
	}
	var we WireError
	if err := json.Unmarshal(payload, &we); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(we.Msg, esc) || !strings.Contains(we.Msg, `\x1b`) {
		t.Fatalf("wire message = %q", we.Msg)
	}
}

func writeFileForTest(dir, name string) error {
	return os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644)
}
