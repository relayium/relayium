package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// syncEvent is one flush the store asked for, with what was on disk at that
// moment — which is what makes the ORDER assertable, not just the call.
type syncEvent struct {
	kind      string // "file" or "dir"
	path      string
	size      int64 // file: the size being flushed
	finalSeen bool  // file: whether the key's final path already existed
}

// recordSyncs swaps the durability seams for recorders that still perform the
// real flush, and restores them on cleanup. failFile, when non-nil, is returned
// by every file flush instead.
func recordSyncs(t *testing.T, final string, failFile error) *[]syncEvent {
	t.Helper()
	var events []syncEvent
	origFile, origDir := syncFile, syncDir
	t.Cleanup(func() { syncFile, syncDir = origFile, origDir })
	syncFile = func(f *os.File) error {
		info, err := f.Stat()
		if err != nil {
			t.Fatalf("stat during sync: %v", err)
		}
		_, ferr := os.Stat(final)
		events = append(events, syncEvent{kind: "file", path: f.Name(), size: info.Size(), finalSeen: ferr == nil})
		if failFile != nil {
			return failFile
		}
		return origFile(f)
	}
	syncDir = func(dir string) error {
		events = append(events, syncEvent{kind: "dir", path: dir})
		return origDir(dir)
	}
	return &events
}

func TestPutFlushesDataBeforeRenameAndTheNameAfter(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "abcdef"
	shardDir, full := d.paths(key)
	events := recordSyncs(t, full, nil)

	if _, err := d.Put(context.Background(), key, strings.NewReader("payload")); err != nil {
		t.Fatal(err)
	}
	ev := *events
	// New shard: root dir entry, then the temp file's data, then the shard entry.
	if len(ev) != 3 {
		t.Fatalf("syncs = %+v; want root dir, file, shard dir", ev)
	}
	if ev[0].kind != "dir" || ev[0].path != d.dir {
		t.Fatalf("first sync %+v; want the store root after creating the shard", ev[0])
	}
	f := ev[1]
	if f.kind != "file" || !strings.HasPrefix(filepath.Base(f.path), tmpPrefix) || f.size != int64(len("payload")) || f.finalSeen {
		t.Fatalf("data sync %+v; want the complete temp file flushed BEFORE the rename", f)
	}
	if ev[2].kind != "dir" || ev[2].path != shardDir {
		t.Fatalf("last sync %+v; want the shard directory after the rename", ev[2])
	}

	// Same shard again: no root sync, still data then name.
	*events = nil
	if _, err := d.Put(context.Background(), "abzzzz", strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if ev := *events; len(ev) != 2 || ev[0].kind != "file" || ev[1].kind != "dir" {
		t.Fatalf("existing-shard syncs = %+v; want file then shard dir", ev)
	}
}

func TestPutFailsAndPublishesNothingWhenTheDataFlushFails(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "cdef01"
	shardDir, full := d.paths(key)
	boom := errors.New("EIO")
	recordSyncs(t, full, boom)

	if _, err := d.Put(context.Background(), key, strings.NewReader("payload")); !errors.Is(err, boom) {
		t.Fatalf("Put with a failing flush = %v; want the flush error", err)
	}
	if _, err := os.Stat(full); !os.IsNotExist(err) {
		t.Fatalf("object published although its data never reached disk (stat err %v)", err)
	}
	entries, _ := os.ReadDir(shardDir)
	for _, e := range entries {
		t.Fatalf("temp file left behind: %s", e.Name())
	}
}

func TestAppendFlushesBeforeReportingTheNewOffset(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "ef0123"
	shardDir, full := d.paths(key)
	events := recordSyncs(t, full, nil)
	ctx := context.Background()

	// First chunk creates the blob: data flushed at its full new size, and the
	// shard entry flushed so the file itself survives.
	if got, err := d.Append(ctx, key, 0, strings.NewReader("hello")); err != nil || got != 5 {
		t.Fatalf("Append 0 = %d, %v", got, err)
	}
	ev := *events
	var sawFile, sawShard bool
	for _, e := range ev {
		if e.kind == "file" && e.path == full && e.size == 5 {
			sawFile = true
		}
		if e.kind == "dir" && e.path == shardDir {
			sawShard = true
		}
	}
	if !sawFile || !sawShard {
		t.Fatalf("creating append syncs = %+v; want the 5-byte file and the shard dir", ev)
	}

	// A later chunk: its data flushed at the new size; no directory flush needed.
	*events = nil
	if got, err := d.Append(ctx, key, 5, strings.NewReader(" world")); err != nil || got != 11 {
		t.Fatalf("Append 5 = %d, %v", got, err)
	}
	if ev := *events; len(ev) != 1 || ev[0].kind != "file" || ev[0].size != 11 {
		t.Fatalf("continuing append syncs = %+v; want one 11-byte file flush", ev)
	}

	// A failed append still flushes the prefix it wrote: those bytes are read
	// back by size and billed.
	*events = nil
	sentinel := errors.New("client went away")
	got, err := d.Append(ctx, key, 11, &erroringReader{after: 3, err: sentinel})
	if !errors.Is(err, sentinel) || got != 14 {
		t.Fatalf("failing append = %d, %v; want 14 and the reader error", got, err)
	}
	if ev := *events; len(ev) != 1 || ev[0].kind != "file" || ev[0].size != 14 {
		t.Fatalf("failed append syncs = %+v; want the 14-byte prefix flushed", ev)
	}

	// A zero-length probe at a non-zero offset wrote nothing: no flush.
	*events = nil
	if got, err := d.Append(ctx, key, 14, strings.NewReader("")); err != nil || got != 14 {
		t.Fatalf("probe = %d, %v", got, err)
	}
	if ev := *events; len(ev) != 0 {
		t.Fatalf("zero-length probe flushed: %+v", ev)
	}
}

func TestAppendReportsAFailedFlush(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "0123ab"
	_, full := d.paths(key)
	boom := errors.New("EIO")
	recordSyncs(t, full, boom)
	if _, err := d.Append(context.Background(), key, 0, strings.NewReader("data")); !errors.Is(err, boom) {
		t.Fatalf("Append with a failing flush = %v; want the flush error, not success", err)
	}
}
