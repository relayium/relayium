package xfer

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// oneShot drives a real Send against a real Receive and returns the sender's
// error, so refusals are observed exactly as a user's push would see them.
func oneShot(t *testing.T, dst string, m Manifest, srcs []string, sync_ bool) error {
	t.Helper()
	c1, c2 := net.Pipe()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = Receive(c2, dst, RecvOpts{})
		c2.Close()
	}()
	_, err := Send(c1, m, srcs, SendOpts{Sync: sync_})
	c1.Close()
	wg.Wait()
	return err
}

// A manifest over the receiver's cap used to close the connection without a
// word, leaving the sender to guess. It is a structural refusal the sender can
// act on, so it comes back as a typed error naming the limit.
func TestSendSeesManifestCapRefusal(t *testing.T) {
	files := make([]FileEntry, maxManifestFiles+1)
	for i := range files {
		files[i] = FileEntry{Path: "f" + string(rune('a'+i%26)) + string(rune('a'+i/26)) + ".bin"}
	}
	err := oneShot(t, t.TempDir(), Manifest{Files: files}, nil, false)

	var remote *RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("err = %v (%T), want a *RemoteError", err, err)
	}
	if remote.Code != ErrCodeManifestTooLarge {
		t.Fatalf("Code = %q, want %q", remote.Code, ErrCodeManifestTooLarge)
	}
	if !strings.Contains(remote.Msg, "1000") {
		t.Fatalf("Msg = %q, want the actual limit stated", remote.Msg)
	}
}

// push never overwrites. The refusal names the colliding file by its RELATIVE
// manifest path — the sender's own word for its own file — and never the
// receiver's absolute path, which would leak that host's layout.
func TestSendSeesDestinationExistsRefusalWithoutAbsolutePath(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFileMtime(t, filepath.Join(src, "d", "a.txt"), "hello", 1000)
	writeFileMtime(t, filepath.Join(dst, "d", "a.txt"), "already here", 1000)

	m, srcs, err := BuildManifest([]string{filepath.Join(src, "d")})
	if err != nil {
		t.Fatal(err)
	}
	sendErr := oneShot(t, dst, m, srcs, false)

	var remote *RemoteError
	if !errors.As(sendErr, &remote) {
		t.Fatalf("err = %v (%T), want a *RemoteError", sendErr, sendErr)
	}
	if remote.Code != ErrCodeDestinationExists {
		t.Fatalf("Code = %q, want %q", remote.Code, ErrCodeDestinationExists)
	}
	if !strings.Contains(remote.Msg, "d/a.txt") {
		t.Fatalf("Msg = %q, want the relative manifest path named", remote.Msg)
	}
	if strings.Contains(remote.Msg, dst) || strings.Contains(remote.Msg, string(os.PathSeparator)+"var") {
		t.Fatalf("Msg = %q leaks the receiver's absolute path", remote.Msg)
	}
	if !strings.Contains(remote.Msg, "sync") {
		t.Fatalf("Msg = %q, want the way forward named", remote.Msg)
	}
	// The refusal happens before any bytes are streamed, so the existing file is
	// untouched.
	got, _ := os.ReadFile(filepath.Join(dst, "d", "a.txt"))
	if string(got) != "already here" {
		t.Fatalf("existing file was modified: %q", got)
	}
}

// Wire compatibility, sender side: a receiver that never sends MsgError (every
// release before this one) is handled exactly as before.
func TestReadExpectPassesThroughOrdinaryFrames(t *testing.T) {
	c1, c2 := net.Pipe()
	go func() {
		_ = WriteJSON(c1, MsgResume, ResumeState{Skip: []int{2}})
		c1.Close()
	}()
	var rs ResumeState
	if err := readExpect(c2, &rs); err != nil {
		t.Fatalf("an ordinary resume frame must decode as before: %v", err)
	}
	if len(rs.Skip) != 1 || rs.Skip[0] != 2 {
		t.Fatalf("rs = %+v, want Skip [2]", rs)
	}
}

// Wire compatibility, receiver side: an OLD sender ignores the frame type and
// decodes a refusal as an empty resume state. It must still fail — never
// proceed as though the receiver had accepted the batch.
func TestOldSenderStillFailsClosedOnErrorFrame(t *testing.T) {
	c1, c2 := net.Pipe()
	go func() {
		_ = WriteJSON(c1, MsgError, WireError{Code: ErrCodeManifestTooLarge, Msg: "too many"})
		c1.Close()
	}()
	// This is precisely what the old sender did: ReadJSON, type ignored.
	var rs ResumeState
	if _, err := ReadJSON(c2, &rs); err != nil {
		t.Fatalf("the old sender decoded the payload without error: %v", err)
	}
	// It learns nothing useful, and the receiver has hung up: the next read fails.
	var res Result
	if _, err := ReadJSON(c2, &res); err == nil {
		t.Fatal("an old sender must not be able to complete a refused transfer")
	}
}

func TestRemoteErrorMessage(t *testing.T) {
	e := &RemoteError{Code: ErrCodeDestinationExists, Msg: "destination already exists: d/a.txt"}
	if !strings.Contains(e.Error(), "d/a.txt") {
		t.Fatalf("Error() = %q", e.Error())
	}
	// A code-only refusal must still say something.
	bare := &RemoteError{Code: "some_future_code"}
	if !strings.Contains(bare.Error(), "some_future_code") {
		t.Fatalf("Error() = %q", bare.Error())
	}
}

// An unreadable MsgError payload must still be an error, not a silent success.
func TestReadExpectRejectsMalformedErrorFrame(t *testing.T) {
	c1, c2 := net.Pipe()
	go func() {
		_ = WriteFrame(c1, MsgError, []byte("{not json"))
		c1.Close()
	}()
	var rs ResumeState
	err := readExpect(c2, &rs)
	if err == nil {
		t.Fatal("a malformed error frame must not read as success")
	}
	var remote *RemoteError
	if errors.As(err, &remote) {
		t.Fatal("a malformed payload must not be reported as a structured refusal")
	}
}

// The frame carries only Code and Msg: nothing that could accidentally ship a
// path, a key or an allow-list.
func TestWireErrorShape(t *testing.T) {
	b, err := json.Marshal(WireError{Code: "c", Msg: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 2 || raw["Code"] != "c" || raw["Msg"] != "m" {
		t.Fatalf("WireError encodes as %s, want exactly Code and Msg", b)
	}
}
