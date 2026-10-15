package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// failSyncs makes the next `n` file flushes fail with boom (n < 0: all of
// them) while counting every call, and restores the seams on cleanup.
func failSyncs(t *testing.T, n int, boom error) *atomic.Int64 {
	t.Helper()
	var calls atomic.Int64
	var left atomic.Int64
	left.Store(int64(n))
	orig := syncFile
	t.Cleanup(func() { syncFile = orig })
	syncFile = func(f *os.File) error {
		calls.Add(1)
		if left.Load() != 0 {
			left.Add(-1)
			return boom
		}
		return orig(f)
	}
	return &calls
}

func fileLen(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func asND(t *testing.T, err error) *NotDurableError {
	t.Helper()
	var nde *NotDurableError
	if !errors.As(err, &nde) || !errors.Is(err, ErrNotDurable) {
		t.Fatalf("err = %v; want a *NotDurableError", err)
	}
	return nde
}

// countingReader records whether anything read it.
type countingReader struct {
	r     io.Reader
	reads atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	c.reads.Add(1)
	return c.r.Read(p)
}

// Root's first RED case at storage level: a failed flush of a 512-byte first
// chunk must not report 512 as a size, and must keep the 512 bytes as
// evidence (they crossed the network and are billed) instead of truncating.
func TestFailedFlushKeepsTheTailAndReportsOnlyTheDurableOffset(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2c3"
	_, full := d.paths(key)
	boom := errors.New("EIO")
	failSyncs(t, 1, boom)
	got, err := d.Append(context.Background(), key, 0, bytes.NewReader(bytes.Repeat([]byte("x"), 512)))
	nde := asND(t, err)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v; the flush error must stay visible", err)
	}
	if got != 0 || nde.Durable != 0 || nde.Physical != 512 || nde.Written != 512 {
		t.Fatalf("Append = %d, %+v; want 0 and {Durable 0 Physical 512 Written 512}", got, nde)
	}
	if n := fileLen(t, full); n != 512 {
		t.Fatalf("file length = %d; the accepted tail must be kept until the ledger settles it", n)
	}
	if _, ok := d.durable.get(key); ok {
		t.Fatal("a failed flush certified a size")
	}
}

// Root's third RED case: a body that broke off AND a flush that failed — both
// causes must be visible, and the size must not be the physical one.
func TestBodyErrorAndFlushErrorAreBothReported(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2c4"
	syncErr := errors.New("FSYNC_EIO")
	readErr := errors.New("BODY_INTERRUPTED")
	failSyncs(t, 1, syncErr)
	got, err := d.Append(context.Background(), key, 0, &erroringReader{after: 3, err: readErr})
	nde := asND(t, err)
	if !errors.Is(err, syncErr) || !errors.Is(err, readErr) {
		t.Fatalf("err = %v; want both the flush error and the body error", err)
	}
	if got != 0 || nde.Physical != 3 || nde.Written != 3 {
		t.Fatalf("Append = %d, %+v", got, nde)
	}
}

// A failed directory flush on the creating append is the same outcome.
func TestFailedDirectoryFlushIsNotDurable(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2c5"
	// The shard already exists (a sibling blob), so the flush that fails is the
	// creating append's own directory-entry flush, after its bytes were written.
	if _, err := d.Append(context.Background(), "a1zzzz", 0, strings.NewReader("s")); err != nil {
		t.Fatal(err)
	}
	boom := errors.New("DIR_EIO")
	orig := syncDir
	t.Cleanup(func() { syncDir = orig })
	syncDir = func(string) error { return boom }
	got, err := d.Append(context.Background(), key, 0, strings.NewReader("abc"))
	nde := asND(t, err)
	if !errors.Is(err, boom) || got != 0 || nde.Physical != 3 {
		t.Fatalf("Append = %d, %v", got, err)
	}
}

// Root's second RED case: after a failed flush the zero-byte probe must not
// hand back the unsynced physical size as an authoritative mismatch — and a
// HEALED fsync must not bless it either: a later successful flush says nothing
// about pages an earlier one failed to write.
func TestProbeNeverBlessesAnUncertifiedTail(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2c6"
	_, full := d.paths(key)
	calls := failSyncs(t, 1, errors.New("EIO"))
	if _, err := d.Append(context.Background(), key, 0, strings.NewReader("abc")); !errors.Is(err, ErrNotDurable) {
		t.Fatalf("setup: %v", err)
	}
	before := calls.Load()
	for i := 0; i < 2; i++ { // the seam is healed now; ask twice
		size, err := d.Append(context.Background(), key, 0, bytes.NewReader(nil))
		if errors.Is(err, ErrOffsetMismatch) {
			t.Fatalf("probe %d = %d, %v: an unsynced size answered as an authoritative mismatch", i, size, err)
		}
		nde := asND(t, err)
		if size != 0 || nde.Durable != 0 || nde.Physical != 3 || nde.Written != 0 {
			t.Fatalf("probe %d = %d, %+v", i, size, nde)
		}
	}
	if calls.Load() != before {
		t.Fatalf("a probe flushed (%d -> %d): fsync-then-attest is exactly the rule that is wrong", before, calls.Load())
	}
	if n := fileLen(t, full); n != 3 {
		t.Fatalf("a probe changed the blob: length %d", n)
	}
}

// A real append without a settled floor (or with one short of the tail) must
// refuse BEFORE reading its body, and must leave the evidence alone.
func TestRepairNeedsASettledFloorCoveringTheWholeTail(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2c7"
	_, full := d.paths(key)
	failSyncs(t, 1, errors.New("EIO"))
	tail := bytes.Repeat([]byte("t"), 512)
	if _, err := d.Append(context.Background(), key, 0, bytes.NewReader(tail)); !errors.Is(err, ErrNotDurable) {
		t.Fatalf("setup: %v", err)
	}
	for _, ctx := range []context.Context{
		context.Background(),
		WithSettledThrough(context.Background(), 511),
	} {
		body := &countingReader{r: bytes.NewReader(tail)}
		size, err := d.Append(ctx, key, 0, body)
		nde := asND(t, err)
		if size != 0 || nde.Written != 0 || nde.Physical != 512 {
			t.Fatalf("unsettled append = %d, %+v", size, nde)
		}
		if body.reads.Load() != 0 {
			t.Fatal("an unsettled append read its body")
		}
		if n := fileLen(t, full); n != 512 {
			t.Fatalf("unsettled append destroyed evidence: length %d", n)
		}
	}
	// Covered: verify and rewrite the SAME bytes, then flush once.
	size, err := d.Append(WithSettledThrough(context.Background(), 512), key, 0, bytes.NewReader(tail))
	if err != nil || size != 512 {
		t.Fatalf("settled replay = %d, %v", size, err)
	}
	got, _ := os.ReadFile(full)
	if !bytes.Equal(got, tail) {
		t.Fatal("replayed bytes differ")
	}
	if c, ok := d.durable.get(key); !ok || c != 512 {
		t.Fatalf("certified = %d, %v; want 512", c, ok)
	}
	// And now it is certified: a stale probe gets an authoritative 409.
	if size, err := d.Append(context.Background(), key, 0, bytes.NewReader(nil)); !errors.Is(err, ErrOffsetMismatch) || size != 512 {
		t.Fatalf("probe after repair = %d, %v", size, err)
	}
}

// A failed flush during matching replay retains the full evidence and never
// certifies the rewritten prefix, even though the body was consumed.
func TestFailedReplayNeverAcknowledges(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2c8"
	failSyncs(t, 1, errors.New("EIO"))
	if _, err := d.Append(context.Background(), key, 0, strings.NewReader("tail")); !errors.Is(err, ErrNotDurable) {
		t.Fatalf("setup: %v", err)
	}
	failSyncs(t, 1, errors.New("EIO2"))
	body := &countingReader{r: strings.NewReader("tail")}
	size, err := d.Append(WithSettledThrough(context.Background(), 4), key, 0, body)
	nde := asND(t, err)
	if size != 0 || nde.Durable != 0 || nde.Physical != 4 || nde.Written != 4 || body.reads.Load() == 0 || !strings.Contains(err.Error(), "EIO2") {
		t.Fatalf("failed replay = %d, %+v, reads %d", size, nde, body.reads.Load())
	}
	_, full := d.paths(key)
	got, err := os.ReadFile(full)
	if err != nil || string(got) != "tail" {
		t.Fatalf("retained tail = %q, %v", got, err)
	}
	if _, ok := d.durable.get(key); ok {
		t.Fatal("a failed replay certified a size")
	}
}

// Restart: a tail written by a process that never flushed it (simulated by a
// raw write and a fresh DiskStore, whose record is empty) is accepted evidence
// but never resumable, however healthy fsync is now.
func TestColdRestartNeverTrustsAPhysicalTail(t *testing.T) {
	dir := t.TempDir()
	d1, err := NewDiskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2c9"
	_, full := d1.paths(key)
	if size, err := d1.Append(context.Background(), key, 0, strings.NewReader("durable!")); err != nil || size != 8 {
		t.Fatalf("setup: %d %v", size, err)
	}
	f, err := os.OpenFile(full, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("unflushed")); err != nil {
		t.Fatal(err)
	}
	_ = f.Sync() // even a later successful flush must not make it trusted
	f.Close()
	d2, err := NewDiskStore(dir) // the restart
	if err != nil {
		t.Fatal(err)
	}
	size, err := d2.Append(context.Background(), key, 8, bytes.NewReader(nil))
	nde := asND(t, err)
	if size != 8 || nde.Durable != 8 || nde.Physical != 17 {
		t.Fatalf("probe after restart = %d, %+v", size, nde)
	}
	// Same process, same bytes: the record certifies the first 8 only.
	size, err = d1.Append(context.Background(), key, 0, bytes.NewReader(nil))
	nde = asND(t, err)
	if size != 8 || nde.Durable != 8 || nde.Physical != 17 {
		t.Fatalf("stale probe on the old process = %d, %+v; want durable 8 only", size, nde)
	}
}

// The one legitimate certified tail: this process flushed it, then the caller
// lost the answer (or its commit failed). No replay needed.
func TestSameProcessLostAnswerIsAnAuthoritativeMismatch(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2d0"
	ctx := context.Background()
	if size, err := d.Append(ctx, key, 0, strings.NewReader("one")); err != nil || size != 3 {
		t.Fatal(size, err)
	}
	if size, err := d.Append(ctx, key, 3, strings.NewReader("two")); err != nil || size != 6 {
		t.Fatal(size, err)
	}
	size, err := d.Append(ctx, key, 3, bytes.NewReader(nil)) // the caller still thinks 3
	if !errors.Is(err, ErrOffsetMismatch) || size != 6 {
		t.Fatalf("stale probe = %d, %v; want an authoritative 6", size, err)
	}
}

// Eviction from the bounded record is safe: the tail becomes untrusted, never
// trusted; and the record really is bounded.
func TestKnownDurableIsBoundedAndEvictionFailsSafe(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	d.durable = newKnownDurable(2)
	ctx := context.Background()
	keys := []string{"aa0001", "aa0002", "aa0003"}
	for _, k := range keys {
		if _, err := d.Append(ctx, k, 0, strings.NewReader("abcd")); err != nil {
			t.Fatal(err)
		}
	}
	if n := d.durable.len(); n != 2 {
		t.Fatalf("record holds %d entries; want the bound 2", n)
	}
	size, err := d.Append(ctx, keys[0], 0, bytes.NewReader(nil))
	if errors.Is(err, ErrOffsetMismatch) {
		t.Fatalf("evicted key answered %d as authoritative", size)
	}
	if nde := asND(t, err); nde.Durable != 0 || nde.Physical != 4 {
		t.Fatalf("evicted probe = %+v", nde)
	}
	if size, err := d.Append(ctx, keys[2], 0, bytes.NewReader(nil)); !errors.Is(err, ErrOffsetMismatch) || size != 4 {
		t.Fatalf("recent key = %d, %v", size, err)
	}
	if err := d.Delete(ctx, keys[2]); err != nil {
		t.Fatal(err)
	}
	if _, ok := d.durable.get(keys[2]); ok {
		t.Fatal("Delete left a certification behind")
	}
}

// A zero-byte probe at a billing floor that happens to equal the physical size
// must not certify that size: it flushed nothing.
func TestProbeAtTheEndCertifiesNothing(t *testing.T) {
	dir := t.TempDir()
	d1, _ := NewDiskStore(dir)
	const key = "a1b2d1"
	_, full := d1.paths(key)
	if _, err := d1.Append(context.Background(), key, 0, strings.NewReader("abc")); err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(full, os.O_WRONLY|os.O_APPEND, 0)
	_, _ = f.Write([]byte("def"))
	f.Close()
	d2, _ := NewDiskStore(dir)
	if size, err := d2.Append(context.Background(), key, 6, bytes.NewReader(nil)); err != nil || size != 6 {
		t.Fatalf("probe at end = %d, %v", size, err)
	}
	size, err := d2.Append(context.Background(), key, 3, bytes.NewReader(nil))
	if errors.Is(err, ErrOffsetMismatch) {
		t.Fatalf("probe at the end certified %d", size)
	}
	asND(t, err)
}

// Concurrent same-key traffic while a tail is being repaired: probes, stale
// appends and the settled replay serialize on the key lock; no caller ever
// sees the uncertified tail as durable, and the final blob is exactly the
// replay.
func TestConcurrentProbesNeverSeeTheTailAsDurable(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2d2"
	_, full := d.paths(key)
	failSyncs(t, 1, errors.New("EIO"))
	tail := bytes.Repeat([]byte("q"), 4096)
	if _, err := d.Append(context.Background(), key, 0, bytes.NewReader(tail)); !errors.Is(err, ErrNotDurable) {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var bad atomic.Int64
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			size, err := d.Append(context.Background(), key, 0, bytes.NewReader(nil))
			// Before the repair: not durable. After it: an authoritative 4096
			// that THIS process flushed. Never a durable answer below that.
			if err == nil || (errors.Is(err, ErrOffsetMismatch) && size != 4096) {
				bad.Add(1)
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		if size, err := d.Append(WithSettledThrough(context.Background(), 4096), key, 0, bytes.NewReader(tail)); err != nil || size != 4096 {
			bad.Add(1)
		}
	}()
	wg.Wait()
	if bad.Load() != 0 {
		t.Fatalf("%d concurrent answers trusted the uncertified tail", bad.Load())
	}
	got, _ := os.ReadFile(full)
	if !bytes.Equal(got, tail) {
		t.Fatal("final blob differs from the replay")
	}
}

// The healthy path pays nothing new: one file flush per append, as before.
func TestHealthyAppendStillFlushesOnce(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "a1b2d3"
	calls := failSyncs(t, 0, nil)
	ctx := context.Background()
	if _, err := d.Append(ctx, key, 0, strings.NewReader("abc")); err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	if _, err := d.Append(ctx, key, 3, strings.NewReader("def")); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load() - before; got != 1 {
		t.Fatalf("continuing append flushed %d times; want 1", got)
	}
}

// Replacing an existing object invalidates its old certificate before the
// directory flush. A failure cannot resurrect the old inode's durability.
func TestFailedPutReplacementForgetsEarlierCertificate(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	const key = "a1PutReplacement"
	if _, err := d.Put(ctx, key, strings.NewReader("old")); err != nil {
		t.Fatal(err)
	}
	original := syncDir
	t.Cleanup(func() { syncDir = original })
	syncDir = func(string) error { return errors.New("DIR_EIO") }
	if _, err := d.Put(ctx, key, strings.NewReader("NEW")); err == nil {
		t.Fatal("failed directory flush acknowledged")
	}
	syncDir = original
	n, err := d.Append(ctx, key, 0, bytes.NewReader(nil))
	nde := asND(t, err)
	if n != 0 || nde.Physical != 3 || nde.Durable != 0 {
		t.Fatalf("replacement probe=%d %+v", n, nde)
	}
	_, path := d.paths(key)
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "NEW" {
		t.Fatalf("replacement evidence=%q %v", got, err)
	}
}
