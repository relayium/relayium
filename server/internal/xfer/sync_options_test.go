package xfer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/fsnotify/fsnotify"
)

func TestFilteredWatchAndManifestAgree(t *testing.T) {
	root := t.TempDir()
	skipped := filepath.Join(root, "config", "private")
	explicitRoot := filepath.Join(skipped, "requested")
	keep := filepath.Join(root, "unmatched", "private")
	for _, p := range []string{explicitRoot, keep} {
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "include.txt"), []byte("ok"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var excludes Excludes
	for _, pattern := range []string{"/absolute", "dir/[", "../outside", "x//y", ""} {
		if err := excludes.Add(pattern); err == nil {
			t.Fatalf("accepted malformed exclude %q", pattern)
		}
	}
	if err := excludes.Add("config/private"); err != nil {
		t.Fatal(err)
	}
	m, _, excluded, err := BuildFilteredManifest([]string{root, explicitRoot}, excludes)
	if err != nil || len(m.Files) != 2 || excluded.Directories != 1 {
		t.Fatalf("manifest length %d, excluded %+v, err %v", len(m.Files), excluded, err)
	}

	l := watchLoop{w: newFakeWatcher(1), opts: WatchOpts{Excludes: excludes}, added: map[string]bool{}}
	if err := l.start([]string{root, explicitRoot}); err != nil {
		t.Fatal(err)
	}
	if !l.added[skipped] || !l.added[explicitRoot] || !l.added[keep] {
		t.Fatalf("wrong watch roots under exclusion: %+v", l.added)
	}
	if !l.excluded(filepath.Join(skipped, "ignored.txt")) || l.excluded(filepath.Join(explicitRoot, "include.txt")) {
		t.Fatal("events did not respect the selected roots")
	}
	l.observe(fsnotify.Event{Name: skipped, Op: fsnotify.Rename})
	if !l.dirty || l.added[explicitRoot] {
		t.Fatal("moving an excluded ancestor must invalidate an explicit source inside it")
	}
}

func TestSyncByteProgressCountsOnlyTransmittedPayload(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	root := filepath.Join(src, "tree")
	out := filepath.Join(dst, "tree")
	for _, path := range []string{root, out} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for path, body := range map[string]string{
		filepath.Join(root, "already.txt"): "same",
		filepath.Join(out, "already.txt"):  "same",
		filepath.Join(root, "partial.txt"): "abcdef",
		filepath.Join(out, "partial.txt"):  "abc",
	} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m, paths, err := BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	var hashed []TransferProgress
	m, err = WithContentDigestsProgress(context.Background(), m, paths, func(p TransferProgress) {
		hashed = append(hashed, p)
	})
	if err != nil || len(hashed) < 2 || hashed[len(hashed)-1].BytesDone != 10 {
		t.Fatalf("wrong scan progress %v, %v", hashed, err)
	}

	var updates []TransferProgress
	rep, _, sendErr, recvErr := pipeTransfer(t, m, paths, dst, SendOpts{
		Sync: true, ContentCheck: true, TransferProgress: func(p TransferProgress) {
			updates = append(updates, p)
		},
	}, RecvOpts{AllowSync: true})
	if sendErr != nil || recvErr != nil || rep.Files != 1 {
		t.Fatalf("sync %+v, send=%v receive=%v", rep, sendErr, recvErr)
	}
	if len(updates) < 2 || updates[0].BytesTotal != 3 {
		t.Fatalf("wrong sending plan: %v", updates)
	}
	last := updates[len(updates)-1]
	if last.BytesDone != 3 || last.BytesTotal != 3 || last.FilesDone != 2 || !last.AwaitingResult {
		t.Fatalf("wrong sending progress: %v", updates)
	}
}
