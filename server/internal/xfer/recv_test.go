package xfer

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReceiveRefusesExistingDestinationWithoutTruncating(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(dest, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	var rw bytes.Buffer
	if err := WriteJSON(&rw, MsgHello, Hello{Version: WireVersion, Mode: "push"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&rw, MsgManifest, Manifest{Files: []FileEntry{{Path: "a.txt", Size: 3}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Receive(&rw, dir, RecvOpts{}); err == nil {
		t.Fatal("ordinary receive accepted an existing destination")
	}
	if got, _ := os.ReadFile(dest); string(got) != "keep me" {
		t.Fatalf("existing destination changed: %q", got)
	}
}

func TestReceiveRejectsUnnegotiatedOffset(t *testing.T) {
	var rw bytes.Buffer
	if err := WriteJSON(&rw, MsgHello, Hello{Version: WireVersion, Mode: "push"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&rw, MsgManifest, Manifest{Files: []FileEntry{{Path: "a.txt", Size: 3}}}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&rw, MsgFileStart, FileStart{Index: 0, Offset: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := Receive(&rw, t.TempDir(), RecvOpts{NoResume: true}); err == nil {
		t.Fatal("Receive accepted an offset it did not advertise")
	}
}

func TestReceiveRejectsFilesOutOfManifestOrder(t *testing.T) {
	var rw bytes.Buffer
	if err := WriteJSON(&rw, MsgHello, Hello{Version: WireVersion, Mode: "push"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&rw, MsgManifest, Manifest{Files: []FileEntry{
		{Path: "a.txt", Size: 0}, {Path: "b.txt", Size: 0},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&rw, MsgFileStart, FileStart{Index: 1, Offset: 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := Receive(&rw, t.TempDir(), RecvOpts{NoResume: true}); err == nil {
		t.Fatal("Receive accepted files out of manifest order")
	}
}

// safeJoin must accept the documented default destDirs — "." (relayium serve's
// default --dir and receive's default destdir) and any trailing-slash path —
// while still rejecting manifest paths that escape destDir.
func TestSafeJoinAcceptsDefaultDestDirs(t *testing.T) {
	for _, dir := range []string{".", "out/", t.TempDir() + "/", t.TempDir()} {
		if _, err := safeJoin(dir, "001/a.txt"); err != nil {
			t.Errorf("safeJoin(%q, %q) = err %v, want a valid path", dir, "001/a.txt", err)
		}
	}
}

// End-to-end guard for the documented default: serve's --dir and receive's
// destdir both default to ".". This exercises the full Send->Receive path with
// destDir="." (the case existing e2e tests missed by always using t.TempDir()).
func TestReceiveIntoDotDir(t *testing.T) {
	srcRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(srcRoot, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	t.Chdir(dst) // Receive(".") must land files under the current directory.

	cSend, cRecv := net.Pipe()
	errc := make(chan error, 1)
	go func() {
		_, err := Send(cSend, m, srcs, SendOpts{})
		cSend.Close()
		errc <- err
	}()

	rep, err := Receive(cRecv, ".", RecvOpts{})
	cRecv.Close()
	if err != nil {
		t.Fatalf("receive into \".\": %v", err)
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("send: %v", serr)
	}
	if len(rep.Failed) != 0 {
		t.Fatalf("unexpected failures receiving into \".\": %v", rep.Failed)
	}
	got, err := os.ReadFile(filepath.Join(dst, filepath.Base(srcRoot), "a.txt"))
	if err != nil || string(got) != "hello" {
		t.Fatalf("a.txt under \".\" = %q err=%v", got, err)
	}
}

// A manifest path with ".." must never resolve outside destDir. safeJoin
// anchors it at destDir's root, so an escape attempt is contained inside
// destDir rather than reaching the parent tree.
func TestSafeJoinContainsEscape(t *testing.T) {
	base := t.TempDir()
	absBase, _ := filepath.Abs(base)
	for _, rel := range []string{"../escape", "../../etc/passwd", "a/../../b"} {
		got, err := safeJoin(base, rel)
		if err != nil {
			continue // rejecting outright is also acceptable
		}
		if got != absBase && !strings.HasPrefix(got, absBase+string(filepath.Separator)) {
			t.Errorf("safeJoin(%q, %q) = %q, escaped destDir %q", base, rel, got, absBase)
		}
	}
}

// A peer-controlled FileStart.Index that is out of range must be rejected with
// an error, not crash the receiver (and, in serve, the whole daemon) with an
// index-out-of-range panic.
func TestReceiveRejectsBadFileIndex(t *testing.T) {
	cSend, cRecv := net.Pipe()

	go func() {
		defer cSend.Close()
		_ = WriteJSON(cSend, MsgHello, Hello{Version: WireVersion, Mode: "push"})
		_ = WriteJSON(cSend, MsgManifest, Manifest{Files: []FileEntry{{Path: "a.txt", Size: 5}}})
		var rs ResumeState
		if _, err := ReadJSON(cSend, &rs); err != nil {
			return
		}
		_ = WriteJSON(cSend, MsgFileStart, FileStart{Index: 99, Offset: 0})
	}()

	_, err := Receive(cRecv, t.TempDir(), RecvOpts{NoResume: true})
	cRecv.Close()
	if err == nil {
		t.Fatal("Receive accepted an out-of-range FileStart.Index; want an error")
	}
	if strings.Contains(err.Error(), "index out of range") {
		t.Fatalf("Receive panicked instead of returning a clean error: %v", err)
	}
}
