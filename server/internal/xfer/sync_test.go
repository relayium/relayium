package xfer

import (
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func writeFileMtime(t *testing.T, path, body string, mtime int64) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	tm := time.Unix(mtime, 0)
	if err := os.Chtimes(path, tm, tm); err != nil {
		t.Fatal(err)
	}
}

func TestSyncStateForSkipsUnchanged(t *testing.T) {
	dst := t.TempDir()
	// Manifest declares three files.
	m := Manifest{Files: []FileEntry{
		{Path: "a.txt", Size: 5, ModTime: 1000}, // identical on disk → skip
		{Path: "b.txt", Size: 9, ModTime: 2000}, // different content/size → send
		{Path: "c.txt", Size: 4, ModTime: 3000}, // absent on disk → send
	}}
	writeFileMtime(t, filepath.Join(dst, "a.txt"), "hello", 1000) // size 5, mtime 1000 → match
	writeFileMtime(t, filepath.Join(dst, "b.txt"), "old", 1500)   // size 3 != 9 → send

	rs := syncStateFor(dst, m)
	if len(rs.Skip) != 1 || rs.Skip[0] != 0 {
		t.Fatalf("Skip = %v, want [0] (a.txt unchanged)", rs.Skip)
	}
}

func TestSyncRoundTripSkipsUnchanged(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	// Source: two files.
	writeFileMtime(t, filepath.Join(src, "d", "a.txt"), "hello", 1000)
	writeFileMtime(t, filepath.Join(src, "d", "b.txt"), "world!!", 2000)
	// Destination already has an identical a.txt (same size+mtime) → should be skipped.
	writeFileMtime(t, filepath.Join(dst, "d", "a.txt"), "hello", 1000)

	m, srcs, err := BuildManifest([]string{filepath.Join(src, "d")})
	if err != nil {
		t.Fatal(err)
	}

	c1, c2 := net.Pipe()
	var wg sync.WaitGroup
	wg.Add(1)
	var recvErr error
	var rep Report
	go func() {
		defer wg.Done()
		rep, recvErr = Receive(c2, dst, RecvOpts{})
		c2.Close()
	}()
	srep, serr := Send(c1, m, srcs, SendOpts{Sync: true})
	c1.Close()
	wg.Wait()
	if serr != nil || recvErr != nil {
		t.Fatalf("send=%v recv=%v", serr, recvErr)
	}
	// a.txt skipped, only b.txt sent.
	if srep.Skipped != 1 {
		t.Fatalf("Skipped = %d, want 1", srep.Skipped)
	}
	if rep.Files != 1 {
		t.Fatalf("received %d files, want 1 (only b.txt)", rep.Files)
	}
	got, _ := os.ReadFile(filepath.Join(dst, "d", "b.txt"))
	if string(got) != "world!!" {
		t.Fatalf("b.txt = %q", got)
	}
}
