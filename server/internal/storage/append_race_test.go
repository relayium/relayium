package storage

import (
	"bytes"
	"context"
	"sync"
	"testing"
)

// Concurrent appends at the SAME offset to the SAME key must not interleave and
// corrupt the blob: the per-key stripe lock serializes them, so exactly one wins
// (grows the blob) and the rest see an offset mismatch. Without the lock the
// Stat-then-copy would let two writers both pass the size check and interleave.
func TestDiskStoreConcurrentAppendNoInterleave(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	const key = "raceblob"
	const chunkLen = 4096

	// Each goroutine offers a distinct all-same-byte chunk at offset 0.
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(b byte) {
			defer wg.Done()
			if _, err := d.Append(ctx, key, 0, bytes.NewReader(bytes.Repeat([]byte{b}, chunkLen))); err == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}(byte('A' + i))
	}
	wg.Wait()

	if wins != 1 {
		t.Fatalf("exactly one same-offset append may win, got %d", wins)
	}
	// The stored blob must be exactly one winner's chunk — a single repeated byte,
	// full length, never a mix of two writers' bytes.
	rc, err := d.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	got := make([]byte, 0, chunkLen*2)
	buf := make([]byte, 1024)
	for {
		n, e := rc.Read(buf)
		got = append(got, buf[:n]...)
		if e != nil {
			break
		}
	}
	if len(got) != chunkLen {
		t.Fatalf("blob length = %d, want %d (no interleaving/overwrite past one chunk)", len(got), chunkLen)
	}
	if !bytes.Equal(got, bytes.Repeat(got[:1], chunkLen)) {
		t.Fatal("blob bytes are not uniform — concurrent appends interleaved")
	}
}
