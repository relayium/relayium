package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// dripReader hands out one byte at a time, forever, pausing between them. It is
// the client the append path had no answer for: it never stalls a single read
// long enough for any socket deadline to notice, and it never ends.
type dripReader struct {
	pause time.Duration
}

func (d dripReader) Read(p []byte) (int, error) {
	time.Sleep(d.pause)
	if len(p) == 0 {
		return 0, nil
	}
	p[0] = 'x'
	return 1, nil
}

// Append used to copy its reader to completion without ever looking at the
// context, so how long one append could run was decided entirely by whoever was
// feeding it. That is the hole under account.pairRoomBlobHold: a delete intent
// held for an hour only covers an in-flight append if an in-flight append has an
// upper bound at all.
func TestDiskStoreAppendStopsWhenItsContextDoes(t *testing.T) {
	dir := t.TempDir()
	d, err := NewDiskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	started := time.Now()
	n, err := d.Append(ctx, "deadline", 0, dripReader{pause: time.Millisecond})
	elapsed := time.Since(started)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("append against a drip that never ends: err = %v, want the context deadline", err)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("the append ran %s past a 150ms deadline", elapsed)
	}
	// Whatever landed BEFORE the deadline is reported, because those bytes are
	// real and the caller has to be able to bill and resume from them.
	if n <= 0 {
		t.Fatalf("append reported %d bytes; the bytes that landed before the cut still have to be reported", n)
	}
	onDisk, err := os.Stat(filepath.Join(dir, "de", "deadline"))
	if err != nil {
		t.Fatalf("stat the partial blob: %v", err)
	}
	if onDisk.Size() != n {
		t.Fatalf("append reported %d bytes but the blob holds %d", n, onDisk.Size())
	}

	// A context that is ALREADY done writes nothing at all.
	done, cancelDone := context.WithCancel(context.Background())
	cancelDone()
	if _, err := d.Append(done, "already-done", 0, dripReader{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("append on a cancelled context: %v, want context.Canceled", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "al", "already-done")); !os.IsNotExist(err) {
		t.Fatalf("a cancelled append created the blob anyway: %v", err)
	}
}

// The cut must not cost the bytes that already landed: the caller resumes from
// the offset it is told, and a second append continues rather than restarts.
func TestAnAppendCutByItsDeadlineIsStillResumable(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	n, err := d.Append(ctx, "resume", 0, dripReader{pause: time.Millisecond})
	if err == nil {
		t.Fatal("the drip append was expected to be cut")
	}
	if n2, err := d.Append(context.Background(), "resume", n, readerOf("TAIL")); err != nil || n2 != n+4 {
		t.Fatalf("resuming from the reported offset: n=%d err=%v, want %d", n2, err, n+4)
	}
	rc, err := d.Get(context.Background(), "resume")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	if int64(len(b)) != n+4 || string(b[n:]) != "TAIL" {
		t.Fatalf("blob is %d bytes ending %q, want %d ending TAIL", len(b), b[n:], n+4)
	}
}

// gatedReader serves its bytes only after gate closes, and signals `started` on
// its first Read — so a test can hold an append (and its stripe lock) open at a
// known point.
type gatedReader struct {
	b       []byte
	started chan struct{}
	gate    chan struct{}
	sig     bool
	i       int
}

func (r *gatedReader) Read(p []byte) (int, error) {
	if !r.sig {
		r.sig = true
		close(r.started)
	}
	<-r.gate
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}

// A context that dies while its append is WAITING FOR THE KEY LOCK must write
// nothing either — in particular it must not create the blob file. The pre-lock
// check cannot see this case (the context was alive when it ran), so the check
// is repeated after the lock is acquired; this pins that recheck.
func TestAContextCancelledWhileWaitingForTheLockCreatesNoBlob(t *testing.T) {
	dir := t.TempDir()
	d, err := NewDiskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	// A second key on the SAME lock stripe, found rather than guessed, so the
	// contention below is real whatever the shard hash does.
	const holder = "lockholder"
	contender := ""
	for i := 0; contender == ""; i++ {
		k := fmt.Sprintf("contender%d", i)
		if d.keyLock(k) == d.keyLock(holder) {
			contender = k
		}
	}

	started := make(chan struct{})
	gate := make(chan struct{})
	holderDone := make(chan error, 1)
	go func() {
		_, err := d.Append(context.Background(), holder, 0, &gatedReader{b: []byte("HELD"), started: started, gate: gate})
		holderDone <- err
	}()
	<-started // the holder is inside Append, stripe lock held

	ctx, cancel := context.WithCancel(context.Background())
	contenderDone := make(chan error, 1)
	go func() {
		_, err := d.Append(ctx, contender, 0, readerOf("NEVER"))
		contenderDone <- err
	}()
	// Give the contender time to pass the pre-lock check and block on the stripe,
	// then kill its context and release the holder.
	time.Sleep(100 * time.Millisecond)
	cancel()
	close(gate)

	if err := <-holderDone; err != nil {
		t.Fatalf("the lock-holding append failed: %v", err)
	}
	if err := <-contenderDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("append whose context died at the lock: %v, want context.Canceled", err)
	}
	if _, err := os.Stat(filepath.Join(dir, contender[:2], contender)); !os.IsNotExist(err) {
		t.Fatalf("a dead context's append still created its blob: %v", err)
	}
}

type sliceReader struct {
	b []byte
	i int
}

func readerOf(s string) *sliceReader { return &sliceReader{b: []byte(s)} }

func (r *sliceReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}
