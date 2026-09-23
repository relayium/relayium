//go:build windows

package xfer

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// W-4: the receiver's filesystem promises on NTFS. Staging and install go
// through os.Root; the hard link (FileLinkInformation without
// ReplaceIfExists) refuses anything that appeared at the destination —
// a file or a directory junction pointing elsewhere — and the junction's
// target is never written; a normal install leaves no staging behind.
func TestStreamRecvRootWindows(t *testing.T) {
	t.Run("install leaves no staging", func(t *testing.T) {
		dir := t.TempDir()
		data := []byte("windows install")
		h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{})
		h.send(MsgStreamData, data)
		h.send(MsgStreamEnd, endFor(data))
		h.expect(MsgStreamResult)
		if r := h.done(); r.err != nil || !r.rep.Installed {
			t.Fatalf("receiver %+v %v", r.rep, r.err)
		}
		if b, err := os.ReadFile(filepath.Join(dir, "out.bin")); err != nil || string(b) != string(data) {
			t.Fatalf("installed %q %v", b, err)
		}
		if l := listDir(t, dir); len(l) != 1 {
			t.Fatalf("listing %v", l)
		}
	})
	t.Run("file planted during the transfer", func(t *testing.T) {
		dir := t.TempDir()
		data := []byte("streamed")
		h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{})
		h.send(MsgStreamData, data)
		if err := os.WriteFile(filepath.Join(dir, "out.bin"), []byte("planted"), 0o600); err != nil {
			t.Fatal(err)
		}
		go h.send(MsgStreamEnd, endFor(data))
		h.expectRefusal(ErrCodeDestinationExists)
		h.c.Close()
		h.done()
		if b, _ := os.ReadFile(filepath.Join(dir, "out.bin")); string(b) != "planted" {
			t.Fatalf("planted file now %q", b)
		}
		assertNoStaging(t, dir)
	})
	t.Run("junction planted during the transfer", func(t *testing.T) {
		base := t.TempDir()
		dir := filepath.Join(base, "dest")
		outside := filepath.Join(base, "outside")
		for _, d := range []string{dir, outside} {
			if err := os.Mkdir(d, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		data := []byte("must not escape")
		h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{})
		h.send(MsgStreamData, data)
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(dir, "out.bin"), outside).CombinedOutput(); err != nil {
			t.Fatalf("mklink /J: %v %s", err, out)
		}
		go h.send(MsgStreamEnd, endFor(data))
		h.expectRefusal(ErrCodeDestinationExists)
		h.c.Close()
		h.done()
		if l := listDir(t, outside); len(l) != 0 {
			t.Fatalf("the junction's target was written: %v", l)
		}
		assertNoStaging(t, dir)
	})
	t.Run("junction present before", func(t *testing.T) {
		base := t.TempDir()
		dir := filepath.Join(base, "dest")
		outside := filepath.Join(base, "outside")
		for _, d := range []string{dir, outside} {
			if err := os.Mkdir(d, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(dir, "out.bin"), outside).CombinedOutput(); err != nil {
			t.Fatalf("mklink /J: %v %s", err, out)
		}
		h := startRecv(t, dir, "out.bin", StreamRecvOpts{})
		h.hello()
		h.manifest("out.bin")
		h.expectRefusal(ErrCodeDestinationExists)
		h.done()
		if l := listDir(t, outside); len(l) != 0 {
			t.Fatalf("the junction's target was written: %v", l)
		}
	})
}
