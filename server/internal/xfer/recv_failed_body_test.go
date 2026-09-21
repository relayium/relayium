package xfer

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// A file whose body cannot be written is ONE failed file, not a failed transfer
// (see receiveOneFile). That promise only holds if the receiver still consumes
// the bytes the sender streams for it: the sender does not know the write was
// refused, and whatever is left unread is what the receiver parses next.
//
// Here the first destination is a symlink, which writeFileBody refuses before it
// reads a single byte. The second file is ordinary and must still arrive.
func TestAFileRefusedBeforeItsBodyIsReadDoesNotDesyncTheNextOne(t *testing.T) {
	src := t.TempDir()
	root := filepath.Join(src, "box")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// Larger than one frame header and not JSON, so an unread body cannot be
	// mistaken for the FileHash frame that follows it.
	first := bytes.Repeat([]byte("not a frame, just file content\n"), 4096)
	second := []byte("the file after the refused one")
	if err := os.WriteFile(filepath.Join(root, "a-refused.bin"), first, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "b-ordinary.txt"), second, 0o644); err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	if err := os.Mkdir(filepath.Join(dst, "box"), 0o755); err != nil {
		t.Fatal(err)
	}
	elsewhere := filepath.Join(t.TempDir(), "outside.bin")
	if err := os.WriteFile(elsewhere, []byte("untouched"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(dst, "box", "a-refused.bin")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	m, srcs, err := BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	rep, _, serr, rerr := pipeTransfer(t, m, srcs, dst, SendOpts{Sync: true}, RecvOpts{AllowSync: true})
	if rerr != nil || serr != nil {
		t.Fatalf("one refused file failed the whole transfer: recv=%v send=%v", rerr, serr)
	}
	if len(rep.Failed) != 1 || rep.Failed[0] != "box/a-refused.bin" {
		t.Fatalf("Failed = %q, want exactly the refused file", rep.Failed)
	}
	got, err := os.ReadFile(filepath.Join(dst, "box", "b-ordinary.txt"))
	if err != nil || !bytes.Equal(got, second) {
		t.Fatalf("the file after the refused one did not arrive intact: %q, %v", got, err)
	}
	// The refusal is the point: nothing was written through the link.
	if out, _ := os.ReadFile(elsewhere); string(out) != "untouched" {
		t.Fatalf("wrote through the symlink: %q", out)
	}
}

// Draining must not turn a dead stream into a quiet per-file failure: if the
// sender stops mid-body there is no next frame to be in step with, and the
// transfer ends with an error, as it did before.
func TestDrainingARefusedBodyStillFailsTheTransferWhenTheStreamEnds(t *testing.T) {
	dst := t.TempDir()
	elsewhere := filepath.Join(t.TempDir(), "outside.bin")
	if err := os.WriteFile(elsewhere, []byte("untouched"), 0o644); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dst, "a.bin")
	if err := os.Symlink(elsewhere, dest); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	base, err := filepath.Abs(dst)
	if err != nil {
		t.Fatal(err)
	}
	peer := &scriptedPeer{Reader: bytes.NewReader(make([]byte, 100))} // 100 of the 4096 promised
	ok, err := receiveOneFile(peer, base, dest, FileEntry{Path: "a.bin", Size: 4096}, 0, true, nil)
	if ok || err == nil {
		t.Fatalf("ok=%v err=%v; a stream that ends inside a body must fail the transfer", ok, err)
	}
}
